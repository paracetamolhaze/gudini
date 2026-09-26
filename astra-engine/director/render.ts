import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { AstraInput } from "../src/input";

/** Bundles a workspace and renders it to MP4. `scale` below 1 gives a fast draft. */
export async function renderVideo(opts: {
  workspace: string;
  publicDir: string;
  input: AstraInput;
  out: string;
  scale?: number;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const serveUrl = await bundle({ entryPoint: path.join(opts.workspace, "src/index.ts"), publicDir: opts.publicDir });
  try {
  const inputProps = opts.input as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: "Astra", inputProps });
  await renderMedia({
    serveUrl, composition, inputProps, outputLocation: opts.out,
    codec: "h264", crf: opts.scale && opts.scale < 1 ? 26 : 18, pixelFormat: "yuv420p",
    audioCodec: "aac", audioBitrate: "192k",
    concurrency: Math.max(2, Math.floor(os.cpus().length / 2)),
    scale: opts.scale ?? 1,
    onProgress: ({ progress }) => opts.onProgress?.(progress),
  });
  } finally {
    // A bundle carries a copy of the job's public folder (the video, pictures, sounds): hundreds of MB.
    fs.rmSync(serveUrl, { recursive: true, force: true });
  }
  masterAudio(opts.out);
}

/** A voice at TikTok loudness plus effects can sum above 0 dB: a soft limiter keeps peaks under -1 dB. The picture is copied as is. */
export function masterAudio(file: string) {
  const temp = `${file}.master.mp4`;
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", file, "-c:v", "copy",
    "-af", "alimiter=limit=0.891:attack=5:release=60:level=false", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", temp], { stdio: "pipe" });
  fs.renameSync(temp, file);
}
