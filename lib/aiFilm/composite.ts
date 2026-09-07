import fs from "fs";
import path from "path";
import { probeDuration, runFfmpeg } from "../ffmpeg";
import { hasMusic, MUSIC_FILE } from "../store";
import { filmDir } from "./generate";
import type { AiFilmPlan } from "./types";

/**
 * Сборка и композиция AI-фильма.
 *
 * Геометрия кадра 1080×1920: сверху фильм 16:9 → 1080×608, снизу автор 1080×1312
 * (вырезка из его кадра 1080×1920 со сдвигом cropY — лицо остаётся в кадре, субтитры
 * ложатся на нижнюю часть, как и в обычном стиле). Звук — оригинал автора той же
 * цепочкой, что и в обычном монтаже. Фильм не растягивается: каждая последовательность
 * сгенерирована не короче своего отрезка речи и подрезается по нему.
 */

export const FILM_W = 1080;
export const FILM_H = 608;
export const AUTHOR_H = 1920 - FILM_H;
export const FILM_FPS = 30;

export function authorCropY(): number {
  const v = Number(process.env.AI_FILM_AUTHOR_CROP_Y ?? 200);
  return Math.max(0, Math.min(1920 - AUTHOR_H, Math.round(v)));
}

/** Один фильм из последовательностей: каждая обрезана под свой отрезок речи, всё — под длину ролика. */
export async function assembleFilm(dir: string, plan: AiFilmPlan, sequenceFiles: string[], duration: number): Promise<string> {
  if (sequenceFiles.length !== plan.sequences.length) throw new Error("AI-фильм: число последовательностей не совпадает с планом");
  const parts: string[] = [];
  const filters: string[] = [];
  for (let i = 0; i < plan.sequences.length; i++) {
    const seq = plan.sequences[i];
    const file = path.join(dir, sequenceFiles[i]);
    const have = await probeDuration(file);
    const need = i === plan.sequences.length - 1 ? Math.max(seq.end, duration) - seq.start : seq.end - seq.start;
    if (have + 0.5 < need) {
      throw new Error(`AI-фильм: последовательность ${i + 1} короче своего отрезка (${have.toFixed(1)} с < ${need.toFixed(1)} с)`);
    }
    parts.push("-i", file);
    filters.push(`[${i}:v]fps=${FILM_FPS},scale=1280:720,setsar=1,trim=duration=${need.toFixed(3)},setpts=PTS-STARTPTS[p${i}]`);
  }
  const concat = plan.sequences.map((_, i) => `[p${i}]`).join("") + `concat=n=${plan.sequences.length}:v=1:a=0[v]`;
  const out = path.join(filmDir(dir), "film.mp4");
  await runFfmpeg([...parts, "-filter_complex", `${filters.join(";")};${concat}`, "-map", "[v]", "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p", out]);
  const dur = await probeDuration(out);
  if (dur + 0.5 < duration) throw new Error(`AI-фильм: собранный фильм ${dur.toFixed(1)} с короче ролика ${duration.toFixed(1)} с`);
  return path.relative(dir, out);
}

/** Фильтры кадра: верх — фильм, низ — автор, поверх — субтитры. */
export function compositeFilter(fit: string, effDur: number, cropY: number, subs = "subs.ass"): string {
  return (
    `[0:v]${fit},fps=${FILM_FPS},crop=${FILM_W}:${AUTHOR_H}:0:${cropY}[author];` +
    `[1:v]scale=${FILM_W}:${FILM_H}:force_original_aspect_ratio=increase,crop=${FILM_W}:${FILM_H},setsar=1,fps=${FILM_FPS},` +
    `tpad=stop_mode=clone:stop_duration=5,trim=duration=${effDur.toFixed(3)},setpts=PTS-STARTPTS[film];` +
    `[film][author]vstack=inputs=2,ass=${subs}[v]`
  );
}

export async function renderFilmComposite(
  dir: string,
  source: string,
  filmFile: string,
  effDur: number,
  onProgress: (f: number) => void,
  opts: { threads: number; fit: string },
): Promise<void> {
  const music = hasMusic();
  const { fit, threads } = opts;
  if (!fs.existsSync(path.join(dir, "subs.ass"))) throw new Error("AI-фильм: нет файла субтитров");
  const voice = "afftdn=nr=10:nf=-45:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000";
  const audioChain = music
    ? `[0:a]${voice}[vo];` +
      `[2:a]volume=0.22,aresample=48000[mus];` +
      `[mus][vo]sidechaincompress=threshold=0.05:ratio=12:attack=20:release=500[duck];` +
      `[vo][duck]amix=inputs=2:duration=first:normalize=0[a]`
    : `[0:a]${voice}[a]`;
  await runFfmpeg(
    [
      "-i", source,
      "-i", filmFile,
      ...(music ? ["-stream_loop", "-1", "-i", MUSIC_FILE] : []),
      "-filter_complex", `${compositeFilter(fit, effDur, authorCropY())};${audioChain}`,
      "-map", "[v]", "-map", "[a]",
      "-threads", String(threads),
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-ar", "48000", "-b:a", "192k",
      "-movflags", "+faststart",
      ...(music ? ["-shortest"] : []),
      "out.mp4",
    ],
    { cwd: dir, totalDurationSec: effDur, onProgress },
  );
}
