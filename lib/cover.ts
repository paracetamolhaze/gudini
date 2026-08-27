import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getSettings, FACE_FILE, hasFace } from "./store";
import { runFfmpeg, probe } from "./ffmpeg";
import {
  HeadlineLine,
  breakHeadline,
  computeLayout,
  buildCoverHeadlineAss,
  resolveCoverFontFile,
  CoverLayout,
} from "./coverLayout";
import { buildCoverImagePrompt } from "./coverPrompt";

/**
 * Gudini Cover Design System — ИИ-обложки с нуля в едином фирменном стиле.
 * 1) Claude-концептор: анализ сценария → headline (2–4 КРИЧАЩИЕ строки, белый+жёлтый),
 *    kicker, эмоция, сцена, image_prompt (только сюжетная часть).
 * 2) Runway gen4_image: reference-фото стримера = identity (личность сохраняется,
 *    поза/эмоция/одежда — новые), композиция под БОЛЬШОЙ заголовок (лицо в верхних 2/3,
 *    нижние ~35% пригодны для текста). Фирменный стиль зашит константой, а не генерится заново.
 * 3) Текст — наш детерминированный рендерер (coverLayout): Oswald Bold, динамический размер
 *    по реальному измерению, 85–94% ширины. Модель НЕ рисует буквы.
 * Ошибки логируются кодами: NO_REFERENCE | INVALID_CONCEPT | MODERATION_REJECT |
 * RUNWAY_ERROR | DOWNLOAD_FAILED; при любом сбое пайплайн откатится на кадр из видео.
 */

export type TypographyDirection =
  | "BOTTOM_MASSIVE"
  | "SIDE_STACK"
  | "ONE_WORD_DOMINANT"
  | "ACCENT_BOX"
  | "INTEGRATED_POSTER";

export type CoverConcept = {
  headline: string;
  headlineLines: HeadlineLine[];
  /** 3 коротких варианта заголовка; победителя выбирает deterministic preflight */
  headlineCandidates?: string[];
  /** 1–3 главных смысловых слова ролика: заголовок обязан сохранить хотя бы одно */
  headlineAnchor?: string[];
  kicker?: string;
  /** направление типографики для full-AI обложки (текст рисует image-модель) */
  typographyDirection?: TypographyDirection;
  emotion: string; // правдоподобная фотографическая реакция (en)
  scene: {
    mainSubject: string; // кто в кадре и что делает корпусом/головой (без рук)
    storyObject: string; // ОДИН главный сюжетный объект
    environment: string; // ОДНО окружение
  };
  composition: {
    facePosition: "left" | "center" | "right";
    faceScale: "large" | "very_large";
    headlineArea: "lower";
    allowHands: boolean; // руки запрещены по умолчанию
  };
  design_notes: string[];
};

// Стиль/анатомия/запреты собираются детерминированно в lib/coverPrompt.ts (Prompt System v4)

const CONCEPT_SYSTEM = `Ты — арт-директор viral short-form контента (Gudini Cover Design System).
По теме и сценарию придумай обложку: ОГРОМНОЕ ЛИЦО + ЭМОЦИЯ + СЮЖЕТ + ОГРОМНЫЙ КРИЧАЩИЙ HEADLINE.

Анализ: вытащи конфликт/hook/claim (НЕ первые слова сценария), одну эмоцию лица, один сильный
визуальный символ для фона.

HEADLINE — САМОЕ ВАЖНОЕ, его рисует сама image-модель. Предложи РОВНО 3 РАЗНЫХ коротких
варианта в headlineCandidates (одной строкой каждый, БЕЗ переносов). Финальный выберет система,
поэтому все три должны быть самодостаточными и передавать главный смысл.

Каждый вариант: идеально 2–3 слова, максимум 4; короткие простые русские слова; читается за секунду;
смысл понятен без пояснений. Это не пересказ сценария, а ударная обложечная формула: конфликт,
неожиданный факт, опасность, потеря, абсурд, шок, поворот.
Хорошо: «ТИГР У ДОМА», «ДЕТИ НА ЗАКАЗ», «ДЕНЬГИ СГОРЕЛИ», «ПИЛОТ ВЫПРЫГНУЛ», «РАВЕНСТВО КОНЧИЛОСЬ».
Плохо: «ТИГР ВО ДВОРЕ НЕ БЕГИ», «5000$ СТАЛИ 300$», «ДЕТЕЙ РЕДАКТИРУЮТ ДО РОЖДЕНИЯ».
Максимум ОДНА служебная связка (НА/ВО/НЕ/У…). Без стрелок, процентов, валют, длинных чисел и
пунктуации; число оставляй, только если оно САМО и есть hook («ПОТЕРЯЛ $5000»), а если смысл
выражается словами — предпочитай слова («ДЕНЬГИ СГОРЕЛИ»). Грамматика безупречна («ВО ДВОРЕ»,
не «В ДВОРЕ»). Варианты каждый раз НОВЫЕ, не повторяй структуру прошлых обложек.

headlineAnchor — 1–3 главных смысловых слова ролика в начальной форме, строчными: то, без чего
обложка теряет тему. Тигр → ["тигр"]; потеря денег → ["деньги","потеря"]; редактирование генов →
["дети","гены"]. Система проверит, что победивший вариант сохранил хотя бы один якорь: заголовок
вроде «НЕ БЕГИ» или «ВСЁ ПРОПАЛО» формально короткий, но предмет ролика в нём исчез. Не пиши в
якоря служебные слова и общие абстракции («будущее», «шок», «правда»).

kicker — верни null. Дополнительная мелкая надпись повышает риск, что генератор нарисует мусорный
текст, а стиль строится композицией, цветом и типографикой, а не лишними словами.

typographyDirection — выбери направление типографики ПОД этот headline и сцену (для обложек, где
текст рисует image-модель): BOTTOM_MASSIVE (огромный многострочник снизу) | SIDE_STACK (столбик
сбоку от лица) | ONE_WORD_DOMINANT (одно гигантское слово + маленькая вторая строка) | ACCENT_BOX
(ключевое слово на жёлтой плашке) | INTEGRATED_POSTER (текст вплетён в сцену, может заходить за
человека). Разные ролики — разные направления.

Ты отвечаешь ТОЛЬКО за режиссуру. Фотографичность, анатомию, запреты стиля и текста добавляет система —
НЕ пиши промпт сам. Верни структурные поля (на английском, кратко):
- emotion: правдоподобная фотографическая реакция, НЕ карикатура. Вместо "extreme shock, huge eyes" →
  "disturbed realization, eyes slightly wider than normal, subtle brow tension, mouth slightly open".
- scene.mainSubject: кто в кадре и что он делает корпусом/головой (БЕЗ рук), ≤5 слов.
- scene.storyObject: РОВНО ОДИН главный сюжетный объект, ≤5 слов (не список символов).
- scene.environment: РОВНО ОДНО окружение, ≤4 слов. Безопасно (PG-13): угроза — атмосферой.
- emotion: ≤8 слов.
- composition: facePosition left|center|right (в зависимости от объекта фона), faceScale large|very_large.
- allowHands: РУКИ ЗАПРЕЩЕНЫ ПО УМОЛЧАНИЮ (false). true — только если без руки/действия сюжет
  физически непонятен. Эмоциональный жест — НЕ причина. НИКОГДА не проси: hand near face, hand on
  forehead, pointing, open palms и прочие типовые жесты тумбнейлов.

Ответь СТРОГО валидным JSON:
{"headlineCandidates":["ДЕТИ НА ЗАКАЗ","ГЕНЫ НА ЗАКАЗ","РАВЕНСТВО КОНЧИЛОСЬ"],
"headlineAnchor":["дети","гены"],
"kicker":null,"typographyDirection":"BOTTOM_MASSIVE","emotion":"...",
"scene":{"mainSubject":"...","storyObject":"...","environment":"..."},
"composition":{"facePosition":"center","faceScale":"very_large","allowHands":false},
"design_notes":["..."]}`;

/** Kicker по умолчанию отсутствует; допускаются только 1–2 коротких слова (§17). */
export function acceptKicker(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim().replace(/\s+/g, " ");
  if (!text || /^(null|none|нет)$/i.test(text)) return undefined;
  const parts = text.split(" ");
  if (parts.length > 2 || text.length > 16) return undefined;
  return text.slice(0, 16);
}

export async function generateCoverConcept(
  topic: string,
  script: string | null,
  title?: string | null,
  /** жёсткая корректирующая инструкция для повторной ТЕКСТОВОЙ попытки (см. resolveHeadline) */
  strictNote?: string | null,
  styleHint?: string | null,
): Promise<CoverConcept | null> {
  const key = getSettings().anthropicKey;
  if (!key) return null;
  const client = new Anthropic({ apiKey: key });
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 16000,
    system: CONCEPT_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Тема: ${topic}\n` +
          (title ? `Рабочий заголовок ролика: ${title}\n` : "") +
          (styleHint ? `Пожелание по стилю: ${styleHint}\n` : "") +
          (script ? `\nСценарий:\n${script}` : "") +
          (strictNote ? `\n\n${strictNote}` : ""),
      },
    ],
  });
  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .replace(/^```(json)?/m, "")
    .replace(/```$/m, "")
    .trim();
  try {
    const json = JSON.parse(raw);
    // основной формат — 3 варианта заголовка (победителя выберет preflight);
    // старый формат headlineLines/headline поддерживается как один вариант
    const candidates = (Array.isArray(json.headlineCandidates) ? json.headlineCandidates : [])
      .map((c: unknown) => String(c ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 3);
    const rawLines = Array.isArray(json.headlineLines) ? json.headlineLines : null;
    const headline = candidates[0]
      ? candidates[0]
      : rawLines?.length
        ? rawLines.map((l: any) => String(l.text ?? "")).join("\n")
        : String(json.headline ?? "");
    const headlineLines = breakHeadline(candidates[0] ? null : (rawLines as HeadlineLine[] | null), headline);
    if (!headlineLines.length || !json.scene?.storyObject || !json.scene?.environment) return null;
    const fp = String(json.composition?.facePosition ?? "center");
    return {
      headline,
      headlineLines,
      headlineCandidates: candidates.length ? candidates : undefined,
      headlineAnchor: (Array.isArray(json.headlineAnchor) ? json.headlineAnchor : [])
        .map((a: unknown) => String(a ?? "").trim().toLowerCase())
        .filter((a: string) => a.length > 1)
        .slice(0, 3),
      // kicker необязателен и рискован (лишний текст → брак QC): принимаем только 1–2 коротких слова
      kicker: acceptKicker(json.kicker),
      typographyDirection: (["BOTTOM_MASSIVE", "SIDE_STACK", "ONE_WORD_DOMINANT", "ACCENT_BOX", "INTEGRATED_POSTER"] as const).includes(json.typographyDirection)
        ? json.typographyDirection
        : "BOTTOM_MASSIVE",
      emotion: String(json.emotion ?? "").slice(0, 120),
      scene: {
        mainSubject: String(json.scene.mainSubject ?? "").slice(0, 100),
        storyObject: String(json.scene.storyObject).slice(0, 100),
        environment: String(json.scene.environment).slice(0, 100),
      },
      composition: {
        facePosition: fp === "left" || fp === "right" ? (fp as "left" | "right") : "center",
        faceScale: json.composition?.faceScale === "large" ? "large" : "very_large",
        headlineArea: "lower",
        allowHands: json.composition?.allowHands === true, // руки запрещены по умолчанию
      },
      design_notes: Array.isArray(json.design_notes) ? json.design_notes.map(String) : [],
    };
  } catch {
    return null;
  }
}

/** Генерирует key art (Runway, reference-лицо) и накладывает фирменный заголовок. */
export async function generateAiCover(
  dir: string,
  concept: CoverConcept,
): Promise<{ ok: boolean; layout?: CoverLayout; reason?: string }> {
  const key = getSettings().runwayKey;
  if (!key) return { ok: false, reason: "NO_RUNWAY_KEY" };
  if (!hasFace()) {
    console.warn("Cover: NO_REFERENCE — reference-фото не загружено в Настройках");
    return { ok: false, reason: "NO_REFERENCE" };
  }

  // --- лог reference-фото (доказательство, что используется именно сохранённое) ---
  const faceStat = fs.statSync(FACE_FILE);
  let faceDims = "?";
  try {
    const info = await probe(FACE_FILE);
    faceDims = `${info.width}x${info.height}`;
  } catch {}
  console.log(
    `Cover reference: source=${FACE_FILE} | size=${faceStat.size} bytes | dims=${faceDims} | loaded=ok`,
  );

  const faceB64 = fs.readFileSync(FACE_FILE).toString("base64");
  const headers = {
    Authorization: `Bearer ${key}`,
    "X-Runway-Version": "2024-11-06",
    "Content-Type": "application/json",
  };

  // Prompt System v4: детерминированная сборка из фиксированных секций (Claude — только режиссура)
  const promptText = buildCoverImagePrompt(concept);
  fs.writeFileSync(path.join(dir, "cover-image-prompt.txt"), promptText, "utf8");
  console.log(`Cover prompt: ${promptText.length} chars | allowHands=${concept.composition.allowHands}`);

  const res = await fetch("https://api.dev.runwayml.com/v1/text_to_image", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "gen4_image",
      promptText,
      ratio: "1080:1920",
      referenceImages: [{ uri: `data:image/jpeg;base64,${faceB64}`, tag: "streamer" }],
      // свои фото обычных людей: без этого строгий фильтр «public figure» режет реальные лица
      contentModeration: { publicFigureThreshold: "low" },
    }),
  });
  if (!res.ok) throw new Error(`RUNWAY_ERROR: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const task: any = await res.json();
  if (!task.id) throw new Error("RUNWAY_ERROR: нет id задачи");

  let imageUrl: string | null = null;
  for (let i = 0; i < 36; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const check = await fetch(`https://api.dev.runwayml.com/v1/tasks/${task.id}`, { headers });
    if (!check.ok) throw new Error(`RUNWAY_ERROR: task ${check.status}`);
    const json: any = await check.json();
    if (json.status === "SUCCEEDED") {
      imageUrl = Array.isArray(json.output) ? json.output[0] : json.output;
      break;
    }
    if (json.status === "FAILED" || json.status === "CANCELLED") {
      const failure = String(json.failure ?? "");
      const code = /moderation/i.test(failure) ? "MODERATION_REJECT" : "RUNWAY_ERROR";
      throw new Error(`${code}: ${failure}`);
    }
  }
  if (!imageUrl) throw new Error("RUNWAY_ERROR: не дождались результата");

  const download = await fetch(imageUrl);
  if (!download.ok) throw new Error(`DOWNLOAD_FAILED: ${download.status}`);
  const artBuffer = Buffer.from(await download.arrayBuffer());
  fs.writeFileSync(path.join(dir, "cover_art.png"), artBuffer);

  // диагностика исходника генератора
  try {
    const art = await probe(path.join(dir, "cover_art.png"));
    console.log(
      `generated source: provider=runway gen4_image | width=${art.width} | height=${art.height} | filesize=${artBuffer.length} bytes`,
    );
  } catch {}

  // --- lossless-постобработка ДО текста: композиция 1080×1920 + мягкий photographic finishing ---
  // (один resize lanczos, лёгкий шарп для глаз/волос, чуть локального контраста; PNG — без потерь)
  await runFfmpeg(
    [
      "-i", "cover_art.png",
      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920," +
        "unsharp=5:5:0.55:5:5:0.0,eq=contrast=1.03:saturation=1.02",
      "-frames:v", "1",
      "cover_base.png",
    ],
    { cwd: dir },
  );

  // --- фирменный текстовый слой (шрифт кладём рядом: ass fontsdir) ---
  const layout = computeLayout(concept.headlineLines);
  fs.writeFileSync(path.join(dir, "cover-text.ass"), buildCoverHeadlineAss(layout, concept.kicker), "utf8");
  fs.mkdirSync(path.join(dir, "fonts"), { recursive: true });
  const fontSrc = resolveCoverFontFile();
  fs.copyFileSync(fontSrc.file, path.join(dir, "fonts", path.basename(fontSrc.file)));
  // финальный энкод — максимальное качество JPEG (без промежуточных jpeg-пережатий)
  await runFfmpeg(
    ["-i", "cover_base.png", "-vf", "ass=cover-text.ass:fontsdir=fonts", "-frames:v", "1", "-q:v", "1", "cover.jpg"],
    { cwd: dir },
  );
  return { ok: true, layout };
}
