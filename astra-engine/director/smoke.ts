// Renders stills of every worked example on a synthetic clip: catches kit errors before Astra's montages hit them.
// npx tsx director/smoke.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import type { AstraInput } from "../src/input";
import { loadExamples } from "./knowledge";
import { analyzeMontage } from "./validate";
import { ENGINE_ROOT, prepareWorkspace } from "./workspace";

const clip = path.join(ENGINE_ROOT, "public/dev/smoke.mp4");

function syntheticClip(duration: number) {
  if (fs.existsSync(clip)) return;
  fs.mkdirSync(path.dirname(clip), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=30:duration=${duration}`,
    "-f", "lavfi", "-i", `sine=frequency=220:duration=${duration}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
}

async function main() {
  const examples = loadExamples();
  syntheticClip(Math.max(...examples.map(e => e.duration)) + 1);
  let failed = 0;
  for (const example of examples) {
    const words = [...example.text.matchAll(/(\d+):([^\s@]+)@(\d+(?:\.\d+)?)/g)].map(m => ({ word: m[2], start: Number(m[3]), end: Number(m[3]) + 0.3 }));
    const input: AstraInput = { duration: example.duration, fps: 30, video: "dev/smoke.mp4", words, cutouts: [], sounds: {}, music: {}, assets: {} };
    const analysis = analyzeMontage(example.code, example.duration);
    // Every block's first frame, a moment inside it, and just before each list item lights up.
    const times = new Set<number>([0]);
    for (const b of analysis.blocks) {
      times.add(b.from + 0.05);
      times.add((b.from + b.to) / 2);
      for (const item of (Array.isArray(b.props.items) ? b.props.items : []) as { at?: unknown }[]) if (typeof item?.at === "number") times.add(Math.max(b.from + 0.02, item.at - 0.1));
    }
    const serveUrl = await bundle({ entryPoint: path.join(prepareWorkspace(example.code, `smoke-${example.name}`), "src/index.ts"), publicDir: path.join(ENGINE_ROOT, "public") });
    const inputProps = input as unknown as Record<string, unknown>;
    const composition = await selectComposition({ serveUrl, id: "Astra", inputProps });
    const out = path.join(ENGINE_ROOT, "out/smoke", example.name);
    fs.mkdirSync(out, { recursive: true });
    for (const t of [...times].filter(t => t < example.duration - 0.05).sort((a, b) => a - b)) {
      try {
        await renderStill({ serveUrl, composition, inputProps, frame: Math.round(t * 30), output: path.join(out, `t-${t.toFixed(2)}.png`) });
      } catch (error) {
        failed++;
        console.log(`${example.name} @ ${t.toFixed(2)}s: ${String((error as Error).message).split("\n")[0]}`);
      }
    }
    console.log(`${example.name}: ${times.size} frames checked`);
  }
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
