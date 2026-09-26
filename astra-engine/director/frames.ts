import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

/** JPEG stills of the draft plus a storyboard of the whole video, ready to send to Astra. */
export function draftImages(video: string, workDir: string, moments: { at: number; label: string }[], duration: number) {
  fs.mkdirSync(workDir, { recursive: true });
  const images: BridgeImage[] = [];
  const labels: { label: string }[] = [];
  const columns = 10;
  const every = Math.max(1, Math.ceil(duration / 40));
  const sheet = path.join(workDir, "storyboard.jpg");
  ffmpeg(["-i", video, "-vf", `fps=1/${every},scale=216:384,tile=${columns}x${Math.ceil(duration / every / columns)}:padding=4:color=white`, "-frames:v", "1", "-q:v", "4", sheet]);
  images.push({ base64: fs.readFileSync(sheet).toString("base64"), mediaType: "image/jpeg" });
  labels.push({ label: `раскадровка всего ролика: кадр каждые ${every} с, слева направо, сверху вниз` });
  moments.forEach((m, i) => {
    const file = path.join(workDir, `moment-${String(i).padStart(2, "0")}.jpg`);
    ffmpeg(["-ss", m.at.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=540:960", "-q:v", "4", file]);
    images.push({ base64: fs.readFileSync(file).toString("base64"), mediaType: "image/jpeg" });
    labels.push({ label: m.label });
  });
  return { images, labels };
}
