// Renders the Astra composition to MP4.
// npx tsx scripts/render.ts --out out/test.mp4 [--input input.json] [--public dir] [--montage Montage.tsx] [--frames 0-359] [--scale 0.5]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const out = path.resolve(arg("out") ?? "out/render.mp4");
  const inputProps = arg("input") ? JSON.parse(fs.readFileSync(arg("input")!, "utf8")) : undefined;
  let entry = path.join(root, "src/index.ts");
  const montage = arg("montage");
  if (montage) {
    // A job's montage replaces the kit check montage in a private copy of the sources.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "astra-src-"));
    fs.cpSync(path.join(root, "src"), path.join(work, "src"), { recursive: true });
    fs.copyFileSync(path.resolve(montage), path.join(work, "src/montage/Montage.tsx"));
    entry = path.join(work, "src/index.ts");
  }
  const started = Date.now();
  const serveUrl = await bundle({ entryPoint: entry, publicDir: path.resolve(arg("public") ?? path.join(root, "public")) });
  const composition = await selectComposition({ serveUrl, id: "Astra", inputProps });
  const frames = arg("frames")?.split("-").map(Number) as [number, number] | undefined;
  let last = -1;
  await renderMedia({
    serveUrl, composition, inputProps, outputLocation: out, codec: "h264", crf: 18,
    audioCodec: "aac", audioBitrate: "192k", pixelFormat: "yuv420p",
    concurrency: Number(arg("concurrency") ?? Math.max(2, Math.floor(os.cpus().length / 2))),
    frameRange: frames, scale: Number(arg("scale") ?? 1),
    onProgress: ({ progress }) => {
      const pct = Math.floor(progress * 10) * 10;
      if (pct !== last) { last = pct; console.log(`render ${pct}%`); }
    },
  });
  console.log(`${out} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
