import fs from "fs";
import path from "path";
import { runFfmpeg } from "../ffmpeg";
import { FILM_W, FILM_H } from "./composite";

/**
 * Проверка готового ролика: верхняя область (фильм) должна жить — кадры меняться.
 * Застывший или чёрный верх — это не «готово», а ошибка сборки. Дёшево: по кадру
 * каждые 2 секунды, серый 16×9, сравнение соседних.
 */

export const FILM_CHECK_STEP_SEC = 2;
const W = 16;
const H = 9;

/** Доля пар соседних кадров, где картинка заметно изменилась, и доля почти чёрных кадров. */
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

export async function checkFilmAlive(dir: string, outFile = "out.mp4"): Promise<void> {
  const raw = path.join(dir, "ai-film", "check-top.gray");
  await runFfmpeg([
    "-i", outFile,
    "-vf", `crop=${FILM_W}:${FILM_H}:0:0,fps=1/${FILM_CHECK_STEP_SEC},scale=${W}:${H},format=gray`,
    "-f", "rawvideo", "-pix_fmt", "gray", raw,
  ], { cwd: dir });
  const stats = motionStats(fs.readFileSync(raw));
  try { fs.rmSync(raw, { force: true }); } catch {}
  if (stats.frames < 2) throw new Error("Проверка фильма: не удалось прочитать кадры верхней области");
  if (stats.dark / stats.frames > 0.3) throw new Error(`Проверка фильма: ${stats.dark} из ${stats.frames} кадров верха почти чёрные`);
  if (stats.changed / (stats.frames - 1) < 0.5) {
    throw new Error(`Проверка фильма: верх застыл — изменились только ${stats.changed} из ${stats.frames - 1} пар кадров`);
  }
}
