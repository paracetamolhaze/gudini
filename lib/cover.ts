import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getSettings, FACE_FILE, hasFace } from "./store";
import { runFfmpeg } from "./ffmpeg";

/**
 * ИИ-обложки: key art с нуля вместо стоп-кадра.
 * 1) Claude анализирует тему/сценарий и выдаёт концепт (headline, эмоция, сцена, image_prompt).
 * 2) Runway gen4_image строит вертикальный кадр с нуля, используя reference-фото стримера
 *    как identity reference (лицо/причёска/черты сохраняются, эмоция и фон — новые).
 * 3) Текст наносим сами (ASS): генеративные модели коверкают кириллицу, а читаемость
 *    заголовка в приоритетах выше красоты — поэтому модель оставляет нижнюю треть чистой,
 *    а headline (белая строка + жёлтая) и subheadline рендерятся детерминированно.
 * Любой сбой → фолбэк на обложку из кадра видео (старый путь) в pipeline.
 */

export type CoverConcept = {
  headline: string; // 2–5 слов, можно \n на две строки
  subheadline: string;
  emotion: string;
  visual_concept: string;
  image_prompt: string;
  design_notes: string[];
};

const CONCEPT_SYSTEM = `Ты — арт-директор viral short-form контента. По теме и сценарию ролика придумай обложку
в стиле драматичных вертикальных viral-covers (смесь viral YouTube cover, documentary/breaking-news poster,
cinematic social thumbnail).

Анализ: вытащи из сценария центральный конфликт/hook/claim — НЕ первые слова. Определи одну главную эмоцию
лица (шок, тревога, напряжение, недоверие, серьёзность, страх, разоблачение, мрачная ирония...), один сильный
визуальный символ темы для фона, один короткий headline.

Headline: 2–5 слов, ударный (шокирующее утверждение, разоблачение, угроза, поворот): «РАВЕНСТВО\\nКОНЧИЛОСЬ»,
«ПИЛОТ ВЫПРЫГНУЛ», «ЭТО УЖЕ НАЧАЛОСЬ». Длинное — сокращай. Можно перенос \\n на 2 строки.
Subheadline: одна короткая поясняющая строка.

image_prompt — на английском, для image-модели, обязательно укажи:
- create from scratch, vertical 9:16 thumbnail/key art;
- the person @streamer from the reference photo is the identity reference: preserve likeness, facial structure,
  hairstyle, age, defining features (glasses/beard/etc if present); emotion/pose/clothing/lighting may change;
- large foreground portrait (chest-up or close-up), the face dominates the frame, экшн-эмоция по теме;
- dramatic cinematic documentary-style background telling the story of the topic (конкретные объекты/символы);
- high contrast, atmospheric light, polished, viral social cover aesthetic, clean composition;
- IMPORTANT: no text, no letters, no captions anywhere in the image; keep the lower third relatively clean
  and less detailed (text will be added later by the renderer).
Весь image_prompt — НЕ ДЛИННЕЕ 900 символов.
Формулируй image_prompt безопасно (PG-13), иначе image-модель отклонит генерацию: без насилия, крови,
оружия у лица, животных, нападающих на людей. Угрозу передавай атмосферой: силуэт вдали, туман, свет,
тревожный фон — а не прямой опасностью для человека в кадре.

Ответь СТРОГО валидным JSON без пояснений:
{"headline":"...", "subheadline":"...", "emotion":"...", "visual_concept":"...", "image_prompt":"...",
"design_notes":["..."]}`;

export async function generateCoverConcept(
  topic: string,
  script: string | null,
  title?: string | null,
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
          (script ? `\nСценарий:\n${script}` : ""),
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
    if (!json.headline || !json.image_prompt) return null;
    return {
      headline: String(json.headline).slice(0, 60),
      subheadline: String(json.subheadline ?? "").slice(0, 80),
      emotion: String(json.emotion ?? ""),
      visual_concept: String(json.visual_concept ?? ""),
      image_prompt: String(json.image_prompt),
      design_notes: Array.isArray(json.design_notes) ? json.design_notes.map(String) : [],
    };
  } catch {
    return null;
  }
}

/** Генерирует key art через Runway gen4_image с reference-фото и накладывает текст. Возвращает true при успехе. */
export async function generateAiCover(dir: string, concept: CoverConcept): Promise<boolean> {
  const key = getSettings().runwayKey;
  if (!key || !hasFace()) return false;

  const faceB64 = fs.readFileSync(FACE_FILE).toString("base64");
  const headers = {
    Authorization: `Bearer ${key}`,
    "X-Runway-Version": "2024-11-06",
    "Content-Type": "application/json",
  };

  // Runway ограничивает promptText 1000 символами — обрезаем по границе предложения
  let promptText = concept.image_prompt.includes("@streamer")
    ? concept.image_prompt
    : `The main person is @streamer. ${concept.image_prompt}`;
  if (promptText.length > 980) {
    const cut = promptText.slice(0, 980);
    promptText = cut.slice(0, Math.max(cut.lastIndexOf(". "), 600) + 1);
  }

  const res = await fetch("https://api.dev.runwayml.com/v1/text_to_image", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "gen4_image",
      promptText,
      ratio: "1080:1920",
      referenceImages: [{ uri: `data:image/jpeg;base64,${faceB64}`, tag: "streamer" }],
    }),
  });
  if (!res.ok) throw new Error(`Runway cover: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const task: any = await res.json();
  if (!task.id) throw new Error("Runway cover: нет id задачи");

  // ждём результат (до 3 минут)
  let imageUrl: string | null = null;
  for (let i = 0; i < 36; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const check = await fetch(`https://api.dev.runwayml.com/v1/tasks/${task.id}`, { headers });
    if (!check.ok) throw new Error(`Runway task: ${check.status}`);
    const json: any = await check.json();
    if (json.status === "SUCCEEDED") {
      imageUrl = Array.isArray(json.output) ? json.output[0] : json.output;
      break;
    }
    if (json.status === "FAILED" || json.status === "CANCELLED") {
      throw new Error(`Runway cover: ${json.status} ${json.failure ?? ""}`);
    }
  }
  if (!imageUrl) throw new Error("Runway cover: не дождались результата");

  const download = await fetch(imageUrl);
  if (!download.ok) throw new Error(`Runway cover download: ${download.status}`);
  fs.writeFileSync(path.join(dir, "cover_art.png"), Buffer.from(await download.arrayBuffer()));

  // текстовый слой — наш (читаемая кириллица, белая + жёлтая строки)
  fs.writeFileSync(path.join(dir, "cover-text.ass"), buildCoverTextAss(concept), "utf8");
  await runFfmpeg(
    ["-i", "cover_art.png", "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,ass=cover-text.ass", "-frames:v", "1", "-q:v", "2", "cover.jpg"],
    { cwd: dir },
  );
  return true;
}

/** Заголовок обложки: первая строка белая, вторая жёлтая, ниже — тонкий subheadline. */
export function buildCoverTextAss(concept: CoverConcept): string {
  const lines = concept.headline
    .split(/\\n|\n/)
    .map((l) => l.trim().replace(/[{}\\]/g, "").toUpperCase())
    .filter(Boolean)
    .slice(0, 2);
  const yellow = "{\\c&H00D7FF&}";
  const headline = lines.length === 2 ? `${lines[0]}\\N${yellow}${lines[1]}` : lines[0] ?? "";
  const sub = concept.subheadline.replace(/[{}\\]/g, "").toUpperCase();

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Head,Arial,150,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,2,0,1,12,5,2,50,50,300,1
Style: Sub,Arial,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,1,0,1,6,3,2,60,60,190,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Head,,0,0,0,,${headline}
${sub ? `Dialogue: 0,0:00:00.00,0:00:10.00,Sub,,0,0,0,,${sub}` : ""}
`;
}
