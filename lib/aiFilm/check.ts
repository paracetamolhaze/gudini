import fs from "fs";
import path from "path";
import { probe, runFfmpeg } from "../ffmpeg";
import { hashFromGray, hamming, HASH_VF } from "../sceneHash";
import { authorFitFilter, CARD } from "../topInset";
import type { AiFilmPlan } from "./types";

/**
 * Проверка готового ролика v2: в каждом AI-окне кадр результата обязан отличаться от
 * кадра автора в тот же момент (наложение действительно произошло), не быть чёрным и
 * меняться во времени. Автор-окна не проверяются: там результат и есть автор.
 * Всё локально, без платных вызовов.
 */

export const FILM_CHECK_STEP_SEC = 2;
const W = 16;
const H = 9;
const MIN_HASH_DISTANCE = 8;

/** Доля пар соседних кадров, где картинка заметно изменилась, и число почти чёрных кадров. */
export function motionStats(gray: Buffer, w = W, h = H): { frames: number; changed: number; dark: number } {
  const size = w * h;
  const frames = Math.floor(gray.length / size);
  let changed = 0;
  let dark = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += gray[f * size + i];
    if (sum / size < 12) dark++;
    if (f === 0) continue;
    let diff = 0;
    for (let i = 0; i < size; i++) diff += Math.abs(gray[f * size + i] - gray[(f - 1) * size + i]);
    if (diff / size > 3) changed++;
  }
  return { frames, changed, dark };
}

async function grayFrames(dir: string, file: string, crop: string, start: number, len: number, out: string, vf: string): Promise<Buffer> {
  await runFfmpeg(
    ["-ss", start.toFixed(3), "-t", len.toFixed(3), "-i", file, "-vf", `${crop}${crop ? "," : ""}${vf}`, "-f", "rawvideo", "-pix_fmt", "gray", out],
    { cwd: dir },
  );
  const buf = fs.readFileSync(out);
  try { fs.rmSync(out, { force: true }); } catch {}
  return buf;
}

/** Проверка AI-окон: наложение есть (кадр не равен кадру автора), верх/кадр живой и не чёрный. */
export async function checkAiSegments(dir: string, plan: AiFilmPlan, authorSource: string, outFile = "out.mp4"): Promise<void> {
  const tmp = path.join(dir, "ai-film");
  fs.mkdirSync(tmp, { recursive: true });
  const segments = plan.timeline.filter((s) => s.mode !== "author" && s.end - s.start >= 1.5);
  if (!segments.length) throw new Error("Проверка AI-фильма: в плане нет AI-окон");
  const source = await probe(path.isAbsolute(authorSource) ? authorSource : path.join(dir, authorSource));
  const fit = authorFitFilter(source.displayWidth, source.displayHeight);
  for (const seg of segments) {
    const crop = seg.mode === "hybrid" ? `crop=${CARD.w}:${CARD.h}:${CARD.x}:${CARD.y}` : "";
    const mid = (seg.start + seg.end) / 2;
    const a = hashFromGray(await grayFrames(dir, outFile, crop, mid, 0.05, path.join(tmp, "chk-out.gray"), `${HASH_VF},select=eq(n\\,0)`));
    const b = hashFromGray(await grayFrames(dir, authorSource, `${fit}${crop ? `,${crop}` : ""}`, mid, 0.05, path.join(tmp, "chk-src.gray"), `${HASH_VF},select=eq(n\\,0)`));
    if (a == null || b == null) throw new Error(`Проверка AI-фильма: не удалось прочитать кадр на ${mid.toFixed(1)} с`);
    if (hamming(a, b) < MIN_HASH_DISTANCE) {
      throw new Error(`Проверка AI-фильма: на ${mid.toFixed(1)} с (${seg.mode}) в кадре автор, а не AI-сцена — наложение не сработало`);
    }
    const stats = motionStats(await grayFrames(dir, outFile, crop, seg.start, seg.end - seg.start, path.join(tmp, "chk-mot.gray"), `fps=1/${FILM_CHECK_STEP_SEC},scale=${W}:${H},format=gray`));
    if (stats.frames >= 2 && stats.dark / stats.frames > 0.5) {
      throw new Error(`Проверка AI-фильма: окно ${seg.start.toFixed(1)}–${seg.end.toFixed(1)} с почти чёрное`);
    }
    if (stats.frames >= 3 && stats.changed === 0) {
      throw new Error(`Проверка AI-фильма: окно ${seg.start.toFixed(1)}–${seg.end.toFixed(1)} с застыло — кадры не меняются`);
    }
  }
}
