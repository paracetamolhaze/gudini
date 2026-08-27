import fs from "fs";
import path from "path";
import { getSettings, FACE_FILE, hasFace } from "./store";
import { runFfmpeg } from "./ffmpeg";
import { computeLayout, buildCoverHeadlineAss, resolveCoverFontFile } from "./coverLayout";
import type { CoverConcept } from "./cover";

/**
 * Провайдер изображений обложек: Gemini Flash через OpenRouter.
 * Выбран по бенчмарку (6/6 TEXT_EXACT, вдвое дешевле Pro). Gemini Pro автоматически
 * НЕ используется — его можно включить только явно через FULL_AI_COVER_MODEL.
 */

export const DEFAULT_FULL_AI_MODEL = "google/gemini-3.1-flash-image";

/** Kill switch: FULL_AI_COVER=false мгновенно возвращает старый пайплайн обложек. */
export const fullAiCoverEnabled = () => process.env.FULL_AI_COVER !== "false";
export const fullAiCoverModel = () => process.env.FULL_AI_COVER_MODEL || DEFAULT_FULL_AI_MODEL;

export type GeneratedImage = { file: string; cost: number; width: number; height: number };

/** Одна генерация изображения с reference-лицом из Настроек. */
export async function generateCoverImage(prompt: string, outFile: string): Promise<GeneratedImage> {
  const key = getSettings().openrouterKey;
  if (!key) throw new Error("NO_OPENROUTER_KEY");
  if (!hasFace()) throw new Error("NO_REFERENCE");

  const faceB64 = fs.readFileSync(FACE_FILE).toString("base64");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: fullAiCoverModel(),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${faceB64}` } },
          ],
        },
      ],
      modalities: ["image", "text"],
      usage: { include: true },
    }),
  });
  const json: any = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`IMAGE_PROVIDER_ERROR: ${res.status} ${JSON.stringify(json.error ?? {}).slice(0, 200)}`);
  }
  const dataUrl: string | undefined = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!dataUrl?.startsWith("data:")) throw new Error("IMAGE_PROVIDER_ERROR: изображение не вернулось");
  const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  fs.writeFileSync(outFile, buffer);
  return { file: outFile, cost: Number(json.usage?.cost ?? 0), width: 0, height: 0 };
}

/**
 * Lossless-приведение к формату обложки 1080×1920 + мягкий photographic finishing.
 * Тот же фильтр, что и в текущем production-пайплайне (единый вид обложек).
 */
export async function finishCoverImage(dir: string, source: string, out: string): Promise<string> {
  await runFfmpeg(
    [
      "-i", path.basename(source),
      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920," +
        "unsharp=5:5:0.55:5:5:0.0,eq=contrast=1.03:saturation=1.02",
      "-frames:v", "1",
      path.basename(out),
    ],
    { cwd: dir },
  );
  return out;
}

/** Детерминированный текстовый слой поверх чистой картинки (режим RENDERER_TEXT и фолбэк). */
export async function renderHeadlineOnImage(
  dir: string,
  baseImage: string,
  concept: CoverConcept,
  out: string,
): Promise<string> {
  const layout = computeLayout(concept.headlineLines);
  fs.writeFileSync(path.join(dir, "cover-text.ass"), buildCoverHeadlineAss(layout, concept.kicker), "utf8");
  fs.mkdirSync(path.join(dir, "fonts"), { recursive: true });
  const font = resolveCoverFontFile();
  fs.copyFileSync(font.file, path.join(dir, "fonts", path.basename(font.file)));
  await runFfmpeg(
    [
      "-i", path.basename(baseImage),
      "-vf", "ass=cover-text.ass:fontsdir=fonts",
      "-frames:v", "1",
      "-q:v", "1",
      path.basename(out),
    ],
    { cwd: dir },
  );
  return out;
}

/** Финальный энкод обложки без текстового слоя (режим FULL_AI — буквы уже нарисованы). */
export async function encodeFinalCover(dir: string, baseImage: string, out: string): Promise<string> {
  await runFfmpeg(
    ["-i", path.basename(baseImage), "-frames:v", "1", "-q:v", "1", path.basename(out)],
    { cwd: dir },
  );
  return out;
}
