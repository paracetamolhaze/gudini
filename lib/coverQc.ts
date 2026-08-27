import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";

/**
 * QC Gate обложки: ни одна Full-AI обложка не публикуется без проверки.
 * Главный ловимый дефект — ПРИДУМАННЫЙ моделью текст (реальный случай: при верном
 * «ТИГР / У ДОМА» модель дорисовала мусорную строку «ТОЛШИЙ ШИНСВ»).
 * Решение принимает vision-модель (обычный OCR врёт на condensed/стилизованной
 * типографике), но вердикт мы пересчитываем сами по нормализованному тексту.
 */

export type CoverQcStatus =
  | "PASS"
  | "TEXT_MISMATCH"
  | "EXTRA_TEXT"
  | "UNREADABLE_TEXT"
  | "IDENTITY_PROBLEM"
  | "ANATOMY_PROBLEM"
  | "QC_UNAVAILABLE";

export type CoverQcResult = {
  status: CoverQcStatus;
  extractedText?: string[];
  reasons: string[];
  confidence: number;
  cost?: number;
};

/** Сырой ответ vision-модели (schema из спеки). */
export type CoverQcRaw = {
  readableText?: unknown;
  headlineMatch?: unknown;
  extraText?: unknown;
  textReadable?: unknown;
  obviousIdentityFailure?: unknown;
  obviousAnatomyFailure?: unknown;
  confidence?: unknown;
};

// Латинские двойники кириллицы: визуально неотличимы, дефектом не являются
const HOMOGLYPHS: Record<string, string> = {
  A: "А", B: "В", E: "Е", K: "К", M: "М", H: "Н", O: "О", P: "Р", C: "С", T: "Т", X: "Х", Y: "У",
};

/**
 * Нормализация для сравнения: регистр, переносы строк, кавычки, несмысловая
 * пунктуация и layout не учитываются. Валюта/проценты/стрелки — учитываются.
 */
export function normalizeCoverText(input: string): string {
  return String(input ?? "")
    .toUpperCase()
    .replace(/[«»„“”"'`’‘]/g, "")
    .replace(/Ё/g, "Е")
    .replace(/[A-Z]/g, (c) => HOMOGLYPHS[c] ?? c)
    .replace(/[.,!?:;…]/g, " ")
    .replace(/[\r\n \t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text: string): string[] {
  return normalizeCoverText(text).split(" ").filter(Boolean);
}

/**
 * Пересчёт вердикта по ответу модели. Чистая функция — тестируется без сети.
 * PASS: headline совпал, лишнего текста нет, текст читаем, нет провала личности/анатомии.
 * Отсутствие kicker'а допустимо; неправильный kicker попадёт в extraText → FAIL.
 */
export function evaluateQc(
  raw: CoverQcRaw,
  expectedHeadline: string,
  expectedKicker?: string,
): CoverQcResult {
  const readable = Array.isArray(raw.readableText) ? raw.readableText.map((t) => String(t)) : [];
  const confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
  const reasons: string[] = [];

  const joined = normalizeCoverText(readable.join(" "));
  const headline = normalizeCoverText(expectedHeadline);
  // kicker-плашка часто встаёт МЕЖДУ строками заголовка («ТИГР / ЧП В ГОРОДЕ / У ДОМА») —
  // это валидная вёрстка, поэтому перед проверкой убираем точные вхождения кикера
  const kicker = expectedKicker ? normalizeCoverText(expectedKicker) : "";
  const withoutKicker = kicker
    ? joined.split(kicker).join(" ").replace(/\s+/g, " ").trim()
    : joined;
  const headlineFound = headline.length > 0 && withoutKicker.includes(headline);

  // лишний текст: слова, которых нет ни в headline, ни в kicker
  const allowed = new Set([...words(expectedHeadline), ...(expectedKicker ? words(expectedKicker) : [])]);
  const strayWords = readable
    .flatMap((line) => words(line))
    .filter((w) => !allowed.has(w));
  const modelExtra = Array.isArray(raw.extraText) ? raw.extraText.map(String).filter((t) => t.trim()) : [];

  if (raw.textReadable === false) {
    reasons.push("модель не смогла разобрать текст на обложке");
    return { status: "UNREADABLE_TEXT", extractedText: readable, reasons, confidence };
  }
  if (!headlineFound) {
    reasons.push(
      `headline не совпал: ожидалось «${headline}», на обложке «${withoutKicker || "— текста не найдено —"}»`,
    );
    return { status: "TEXT_MISMATCH", extractedText: readable, reasons, confidence };
  }
  if (strayWords.length || modelExtra.length) {
    const found = [...new Set([...strayWords, ...modelExtra.map((t) => normalizeCoverText(t))])].filter(Boolean);
    reasons.push(`лишний текст на обложке: ${found.join(", ")}`);
    return { status: "EXTRA_TEXT", extractedText: readable, reasons, confidence };
  }
  if (raw.obviousIdentityFailure === true) {
    reasons.push("лицо не похоже на reference-фото");
    return { status: "IDENTITY_PROBLEM", extractedText: readable, reasons, confidence };
  }
  if (raw.obviousAnatomyFailure === true) {
    reasons.push("грубая анатомическая ошибка");
    return { status: "ANATOMY_PROBLEM", extractedText: readable, reasons, confidence };
  }
  return { status: "PASS", extractedText: readable, reasons, confidence };
}

const QC_SYSTEM =
  "Ты — контролёр качества обложек. Смотри на изображение и отвечай СТРОГО одним JSON-объектом, без пояснений.";

function qcPrompt(headline: string, kicker?: string): string {
  return (
    `Expected headline:\n"${headline}"\n\n` +
    (kicker ? `Expected optional kicker:\n"${kicker}"\n\n` : "") +
    "Inspect this cover image.\n\n" +
    "Return JSON only:\n" +
    '{"readableText":["<every clearly readable text block, top to bottom, verbatim>"],' +
    '"headlineMatch":<true if the headline appears with exactly this wording and spelling>,' +
    '"extraText":["<any readable text that is NOT part of the headline or kicker>"],' +
    '"textReadable":<true if the lettering is clean and legible>,' +
    '"obviousIdentityFailure":<true only if the face is clearly a different person or badly distorted>,' +
    '"obviousAnatomyFailure":<true only if there is an obvious anatomical defect>,' +
    '"confidence":<0..1>}\n\n' +
    "Report gibberish or invented pseudo-words as extraText. Ignore tiny illegible texture noise."
  );
}

// Haiku 4.5 — дешёвый multimodal: QC не должен стоить как ещё одна генерация
const QC_MODEL = "claude-haiku-4-5-20251001";
const QC_PRICE_IN = 1 / 1_000_000; // $ за входной токен
const QC_PRICE_OUT = 5 / 1_000_000; // $ за выходной токен

/** Проверяет готовую обложку. При недоступности QC возвращает QC_UNAVAILABLE (без исключения). */
export async function runCoverQc(
  imageFile: string,
  expectedHeadline: string,
  expectedKicker?: string,
): Promise<CoverQcResult> {
  const key = getSettings().anthropicKey;
  if (!key) return { status: "QC_UNAVAILABLE", reasons: ["нет ANTHROPIC_API_KEY"], confidence: 0, cost: 0 };
  try {
    const client = new Anthropic({ apiKey: key });
    const media = imageFile.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
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
              source: { type: "base64", media_type: media as "image/png", data: fs.readFileSync(imageFile).toString("base64") },
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
      reasons: [`QC недоступен: ${String(e?.message ?? e).slice(0, 160)}`],
      confidence: 0,
      cost: 0,
    };
  }
}

/** Доп. инструкция для повторной генерации: что именно было не так (§14). */
export function buildRetryFeedback(previous: CoverQcResult, headline: string, kicker?: string): string {
  const cause =
    previous.status === "EXTRA_TEXT"
      ? "it contained extra readable text that was not requested"
      : previous.status === "TEXT_MISMATCH"
        ? "the headline was misspelled or reworded"
        : previous.status === "UNREADABLE_TEXT"
          ? "the lettering was not clearly legible"
          : "it failed quality control";
  return (
    `\n\nPrevious generation failed because ${cause}.\n\n` +
    `IMPORTANT:\nRender ONLY these exact words:\n"${headline.replace(/\n/g, " ")}"\n` +
    (kicker ? `Optional kicker:\n"${kicker}"\n` : "") +
    "Do not create any other letters, labels, signs or pseudo-text anywhere in the image. " +
    "Every letter must be correctly spelled Cyrillic and clearly legible."
  );
}
