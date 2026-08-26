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
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg завершился с кодом ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/** Извлекает аудио в WAV 16 кГц моно (для распознавания речи). */
export async function extractAudio(inputFile: string, outputWav: string, cwd: string): Promise<void> {
  await runFfmpeg(["-i", inputFile, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputWav], { cwd });
}
