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
}
