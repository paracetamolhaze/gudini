import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";

/**
 * QC Gate — обязательная часть Full-AI пайплайна (не фолбэк).
 * Проверяет: точный headline, отсутствие лишнего читаемого текста, читаемость,
 * узнаваемость лица, анатомию и критические визуальные артефакты.
 * Главный ловимый дефект — придуманный моделью текст (реальный случай: при верном
 * «ТИГР / У ДОМА» модель дорисовала мусорную строку «ТОЛШИЙ ШИНСВ»).
 * Решение принимает vision-модель (OCR врёт на condensed-типографике), но вердикт
 * по тексту мы пересчитываем сами по нормализованному сравнению.
 */

export type CoverQcStatus =
  | "PASS"
  | "TEXT_MISMATCH"
  | "EXTRA_TEXT"
  | "UNREADABLE_TEXT"
  | "IDENTITY_PROBLEM"
  | "ANATOMY_PROBLEM"
  | "VISUAL_ARTIFACTS"
  | "QC_UNAVAILABLE";

export type CoverQcResult = {
  status: CoverQcStatus;
  pass: boolean;
  extractedText?: string[];
  extraText?: string[];
  visualArtifacts?: string[];
  reasons: string[];
  confidence: number;
  cost?: number;
};

/** Сырой ответ vision-модели. */
export type CoverQcRaw = {
  readableText?: unknown;
  headlineMatch?: unknown;
  extraText?: unknown;
  textReadable?: unknown;
  identityOk?: unknown;
  anatomyOk?: unknown;
  visualArtifacts?: unknown;
  confidence?: unknown;
};

// Латинские двойники кириллицы: визуально неотличимы, дефектом не являются
const HOMOGLYPHS: Record<string, string> = {
  A: "А", B: "В", E: "Е", K: "К", M: "М", H: "Н", O: "О", P: "Р", C: "С", T: "Т", X: "Х", Y: "У",
};

/** Нормализация для сравнения: регистр, переносы, кавычки и layout не учитываются. */
export function normalizeCoverText(input: string): string {
  return String(input ?? "")
    .toUpperCase()
    .replace(/[«»„“”"'`’‘]/g, "")
    .replace(/Ё/g, "Е")
    .replace(/[A-Z]/g, (c) => HOMOGLYPHS[c] ?? c)
    .replace(/[.,!?:;…]/g, " ")
    .replace(/[\r\n \t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text: string): string[] {
  return normalizeCoverText(text).split(" ").filter(Boolean);
}

/**
 * Пересчёт вердикта по ответу модели. Чистая функция — тестируется без сети.
 * FAIL означает COVER_FAILED: QC не имеет права инициировать новую генерацию.
 */
export function evaluateQc(
  raw: CoverQcRaw,
  expectedHeadline: string,
  expectedKicker?: string | null,
): CoverQcResult {
  const readable = Array.isArray(raw.readableText) ? raw.readableText.map((t) => String(t)) : [];
  const confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
  const artifacts = Array.isArray(raw.visualArtifacts) ? raw.visualArtifacts.map(String).filter((a) => a.trim()) : [];
  const reasons: string[] = [];

  const joined = normalizeCoverText(readable.join(" "));
  const headline = normalizeCoverText(expectedHeadline);
  // kicker-плашка часто встаёт МЕЖДУ строками заголовка («ТИГР / ЧП В ГОРОДЕ / У ДОМА») —
  // это валидная вёрстка, поэтому перед проверкой убираем точные вхождения кикера
  const kicker = expectedKicker ? normalizeCoverText(expectedKicker) : "";
  const withoutKicker = kicker ? joined.split(kicker).join(" ").replace(/\s+/g, " ").trim() : joined;
  const headlineFound = headline.length > 0 && withoutKicker.includes(headline);

  const allowed = new Set([...words(expectedHeadline), ...(expectedKicker ? words(expectedKicker) : [])]);
  const strayWords = readable.flatMap((line) => words(line)).filter((w) => !allowed.has(w));
  const modelExtra = Array.isArray(raw.extraText) ? raw.extraText.map(String).filter((t) => t.trim()) : [];
  const strayList = [...new Set([...strayWords, ...modelExtra.map((t) => normalizeCoverText(t))])].filter(Boolean);

  const fail = (status: CoverQcStatus): CoverQcResult => ({
    status,
    pass: false,
    extractedText: readable,
    extraText: strayList,
    visualArtifacts: artifacts,
    reasons,
    confidence,
  });

  if (raw.textReadable === false) {
    reasons.push("текст на обложке нечитаем");
    return fail("UNREADABLE_TEXT");
  }
  if (!headlineFound) {
    reasons.push(
      `headline не совпал: ожидалось «${headline}», на обложке «${withoutKicker || "— текста не найдено —"}»`,
    );
    return fail("TEXT_MISMATCH");
  }
  if (strayList.length) {
    reasons.push(`лишний текст на обложке: ${strayList.join(", ")}`);
    return fail("EXTRA_TEXT");
  }
  if (raw.identityOk === false) {
    reasons.push("лицо недостаточно похоже на reference-фото");
    return fail("IDENTITY_PROBLEM");
  }
  if (raw.anatomyOk === false) {
    reasons.push("грубая анатомическая ошибка");
    return fail("ANATOMY_PROBLEM");
  }
  if (artifacts.length) {
    reasons.push(`визуальные артефакты: ${artifacts.join(", ")}`);
    return fail("VISUAL_ARTIFACTS");
  }
  return {
    status: "PASS",
    pass: true,
    extractedText: readable,
    extraText: [],
    visualArtifacts: [],
    reasons: [],
    confidence,
  };
}

const QC_SYSTEM =
  "Ты — контролёр качества обложек. Смотри на изображение и отвечай СТРОГО одним JSON-объектом, без пояснений.";

function qcPrompt(headline: string, kicker?: string | null): string {
  return (
    `Expected headline:\n"${headline}"\n\n` +
    (kicker ? `Expected optional kicker:\n"${kicker}"\n\n` : "No kicker is expected.\n\n") +
    "Inspect this cover image.\n\n" +
    "Return JSON only:\n" +
    '{"readableText":["<every clearly readable text block, top to bottom, verbatim>"],' +
    '"headlineMatch":<true if the headline appears with exactly this wording and spelling>,' +
    '"extraText":["<any readable text that is NOT part of the headline or kicker>"],' +
    '"textReadable":<true if the lettering is clean and legible at thumbnail size>,' +
    '"identityOk":<false only if the face is clearly a different person or badly distorted>,' +
    '"anatomyOk":<false only if there is an obvious anatomical defect>,' +
    '"visualArtifacts":["<only severe defects that ruin the cover>"],' +
    '"confidence":<0..1>}\n\n' +
    "Report gibberish or invented pseudo-words as extraText. Ignore tiny illegible texture noise."
  );
}

/**
 * Тип изображения по сигнатуре байтов, а не по расширению файла: генератор может
 * вернуть JPEG в файле .png, и тогда заявленный media_type ломает запрос к QC.
 */
export function detectImageMediaType(buffer: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && buffer.toString("latin1", 0, 3) === "GIF") return "image/gif";
  if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP")
    return "image/webp";
  return "image/jpeg";
}

// Haiku 4.5 — дешёвый multimodal: QC не должен стоить как ещё одна генерация
const QC_MODEL = "claude-haiku-4-5-20251001";
const QC_PRICE_IN = 1 / 1_000_000;
const QC_PRICE_OUT = 5 / 1_000_000;

/** Проверяет готовую обложку. Недоступность QC — это FAIL (без исключения), а не пропуск. */
export async function runCoverQc(
  imageFile: string,
  expectedHeadline: string,
  expectedKicker?: string | null,
): Promise<CoverQcResult> {
  const key = getSettings().anthropicKey;
  if (!key) {
    return { status: "QC_UNAVAILABLE", pass: false, reasons: ["нет ANTHROPIC_API_KEY"], confidence: 0, cost: 0 };
  }
  try {
    const client = new Anthropic({ apiKey: key });
    const buffer = fs.readFileSync(imageFile);
    const media = detectImageMediaType(buffer);
    const response = await client.messages.create({
      model: QC_MODEL,
      max_tokens: 1000,
      system: QC_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: media, data: buffer.toString("base64") },
            },
            { type: "text", text: qcPrompt(expectedHeadline, expectedKicker) },
          ],
        },
      ],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("модель вернула не JSON");
    const cost =
      (response.usage?.input_tokens ?? 0) * QC_PRICE_IN + (response.usage?.output_tokens ?? 0) * QC_PRICE_OUT;
    return { ...evaluateQc(JSON.parse(match[0]) as CoverQcRaw, expectedHeadline, expectedKicker), cost };
  } catch (e: any) {
    return {
      status: "QC_UNAVAILABLE",
      pass: false,
      reasons: [`QC недоступен: ${String(e?.message ?? e).slice(0, 160)}`],
      confidence: 0,
      cost: 0,
    };
  }
}
