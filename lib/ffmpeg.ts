import { spawn } from "child_process";

export function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

export function ffprobeBin(): string {
  return process.env.FFPROBE_PATH || "ffprobe";
}

export type ProbeInfo = {
  duration: number; // секунды
  width: number;
  height: number;
  hasAudio: boolean;
};

/** Точная длительность файла (для webm с камеры метаданные врут — мерим по аудио). */
export async function probeDuration(file: string): Promise<number> {
  const out = await runCapture(ffprobeBin(), [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    file,
  ]);
  const json = JSON.parse(out);
  return parseFloat(json.format?.duration ?? "0") || 0;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const out = await runCapture(ffprobeBin(), [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format", "-show_streams",
    file,
  ]);
  const json = JSON.parse(out);
  const video = (json.streams ?? []).find((s: any) => s.codec_type === "video");
  const audio = (json.streams ?? []).find((s: any) => s.codec_type === "audio");
  if (!video) throw new Error("В файле не найден видеопоток");
  return {
    duration: parseFloat(json.format?.duration ?? video.duration ?? "0"),
    width: video.width,
    height: video.height,
    hasAudio: Boolean(audio),
  };
}

function runCapture(bin: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} завершился с кодом ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/**
 * Запускает ffmpeg и сообщает прогресс (0..1) по -progress pipe:1.
 * cwd задаётся, чтобы в фильтрах использовать относительные пути (важно для ass= на Windows).
 */
export function runFfmpeg(
  args: string[],
  opts: { cwd?: string; totalDurationSec?: number; onProgress?: (fraction: number) => void } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fullArgs = ["-hide_banner", "-y", ...args, "-progress", "pipe:1", "-nostats"];
    const proc = spawn(ffmpegBin(), fullArgs, { cwd: opts.cwd, windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    proc.stdout.on("data", (chunk) => {
      const text = String(chunk);
      const match = text.match(/out_time_us=(\d+)/g);
      if (match && opts.totalDurationSec && opts.onProgress) {
        const last = match[match.length - 1];
        const us = parseInt(last.split("=")[1], 10);
        opts.onProgress(Math.min(1, us / 1e6 / opts.totalDurationSec));
      }
    });
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      if (code === 0) resolve();
      else if (code === null) {
        reject(
          new Error(
            `ffmpeg был остановлен системой (сигнал ${signal ?? "неизвестен"}) — почти всегда это нехватка ОЗУ на сервере. Увеличьте память сервиса или упростите монтаж.`,
          ),
        );
      } else reject(new Error(`ffmpeg завершился с кодом ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/** Извлекает аудио в WAV 16 кГц моно (для распознавания речи), с необязательной обрезкой. */
export async function extractAudio(
  inputFile: string,
  outputWav: string,
  cwd: string,
  trim?: { start: number; duration: number },
): Promise<void> {
  const pre = trim ? ["-ss", String(trim.start), "-t", String(trim.duration)] : [];
  await runFfmpeg([...pre, "-i", inputFile, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputWav], { cwd });
}

export type SilenceEvent = { start: number; end: number };

/** Все участки тишины в файле (silencedetect). */
export async function detectSilences(file: string, cwd: string, duration: number): Promise<SilenceEvent[]> {
  const stderr = await new Promise<string>((resolve, reject) => {
    const proc = spawn(
      ffmpegBin(),
      ["-hide_banner", "-i", file, "-af", "silencedetect=n=-40dB:d=0.6", "-f", "null", "-"],
      { cwd, windowsHide: true },
    );
    let out = "";
    proc.stderr.on("data", (d) => (out += d));
    proc.on("error", reject);
    proc.on("close", () => resolve(out));
  });

  const events: { start: number; end?: number }[] = [];
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start:\s*([\d.]+)/);
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (s) events.push({ start: parseFloat(s[1]) });
    else if (e && events.length) events[events.length - 1].end = parseFloat(e[1]);
  }
  return events.map((ev) => ({ start: ev.start, end: ev.end ?? duration }));
}

/**
 * По списку тишин строит сегменты речи, которые остаются в ролике:
 * обрезает края и вырезает длинные паузы внутри (оставляя естественный зазор).
 */
export function buildKeepSegments(
  silences: SilenceEvent[],
  duration: number,
): { start: number; end: number }[] {
  let start = 0;
  let end = duration;
  const first = silences[0];
  if (first && first.start <= 0.3 && first.end < duration) start = Math.max(0, first.end - 0.25);
  const last = silences[silences.length - 1];
  if (last && last.end >= duration - 0.5 && last.start > start) end = Math.min(duration, last.start + 0.5);
  if (end - start < 3) {
    start = 0;
    end = duration;
  }

  // внутренние паузы > 1.2 сек ужимаем до ~0.45 сек (0.25 до + 0.2 после)
  const cuts: { start: number; end: number }[] = [];
  for (const sil of silences) {
    const s = Math.max(sil.start, start);
    const e = Math.min(sil.end, end);
    if (e - s > 1.2 && s > start + 0.5 && e < end - 0.5) {
      cuts.push({ start: s + 0.25, end: e - 0.2 });
    }
  }

  const segments: { start: number; end: number }[] = [];
  let cursor = start;
  for (const cut of cuts) {
    if (cut.start > cursor + 0.2) segments.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (end > cursor + 0.2) segments.push({ start: cursor, end });
  return segments.length ? segments : [{ start, end }];
}
