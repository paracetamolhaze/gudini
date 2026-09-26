import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import type { AstraInput } from "../src/input";
import type { BridgeImage } from "./bridge";
import type { Block } from "./validate";

const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe" });

/** Moments worth looking at: the hook, the middle of every scene, and the ending. */
export function keyMoments(blocks: Block[], duration: number): { at: number; label: string }[] {
  const moments = [
    { at: 0.6, label: "крючок, 0.6 с" },
    { at: 2.0, label: "крючок, 2.0 с" },
    ...blocks.filter(b => b.type !== "Sfx" && b.type !== "Flash").map(b => {
      const at = Math.min(b.to - 0.1, b.from + Math.min(1.2, (b.to - b.from) * 0.6));
      return { at, label: `${b.type}${typeof b.props.text === "string" ? ` «${b.props.text}»` : typeof b.props.title === "string" ? ` «${b.props.title}»` : ""}, ${at.toFixed(1)} с` };
    }),
    { at: duration - 1.0, label: `финал, ${(duration - 1).toFixed(1)} с` },
  ].sort((a, b) => a.at - b.at);
  const picked: typeof moments = [];
  for (const m of moments) if (!picked.some(p => Math.abs(p.at - m.at) < 0.8)) picked.push(m);
  // The service accepts up to 24 images; one goes to the storyboard.
  if (picked.length <= 22) return picked;
  const step = picked.length / 22;
  return Array.from({ length: 22 }, (_, i) => picked[Math.floor(i * step)]);
}

/**
 * The frames Astra reviews, rendered one by one instead of a whole draft video:
 * a storyboard (a frame every 2 s) and the key moments at half size. About a minute instead of three and a half.
 */
export async function draftStills(opts: { workspace: string; publicDir: string; input: AstraInput; workDir: string; moments: { at: number; label: string }[] }) {
  const { input, workDir } = opts;
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const serveUrl = await bundle({ entryPoint: path.join(opts.workspace, "src/index.ts"), publicDir: opts.publicDir });
  const inputProps = input as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: "Astra", inputProps });
  const browser = await openBrowser("chrome");
  const still = (at: number, file: string, scale: number) => renderStill({
    serveUrl, composition, inputProps, frame: Math.min(composition.durationInFrames - 1, Math.max(0, Math.round(at * composition.fps))),
    output: file, imageFormat: "jpeg", jpegQuality: 78, scale, puppeteerInstance: browser,
  });
  const images: BridgeImage[] = [];
  const labels: { label: string }[] = [];
  try {
    const every = Math.max(1, Math.ceil(input.duration / 40));
    let count = 0;
    for (let t = 0.3; t < input.duration - 0.2; t += every) await still(t, path.join(workDir, `board-${String(count++).padStart(3, "0")}.jpeg`), 0.2);
    const sheet = path.join(workDir, "storyboard.jpg");
    ffmpeg(["-framerate", "1", "-i", path.join(workDir, "board-%03d.jpeg"), "-vf", `tile=10x${Math.ceil(count / 10)}:padding=4:color=white`, "-frames:v", "1", "-q:v", "4", sheet]);
    images.push({ base64: fs.readFileSync(sheet).toString("base64"), mediaType: "image/jpeg" });
    labels.push({ label: `раскадровка всего ролика: кадр каждые ${every} с, слева направо, сверху вниз` });
    for (const [i, m] of opts.moments.entries()) {
      const file = path.join(workDir, `moment-${String(i).padStart(2, "0")}.jpeg`);
      await still(m.at, file, 0.5);
      images.push({ base64: fs.readFileSync(file).toString("base64"), mediaType: "image/jpeg" });
      labels.push({ label: m.label });
    }
  } finally {
    await browser.close({ silent: true });
  }
  return { images, labels };
}
