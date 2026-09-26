// Acceptance sheets of a finished montage: a labelled frame of every block, and the sound levels.
// npx tsx director/inspect.ts out/job
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { analyzeMontage } from "./validate";

const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args], { stdio: "pipe" });

function main() {
  const dir = path.resolve(process.argv[2]);
  const video = path.join(dir, "final.mp4");
  const code = fs.readFileSync(path.join(dir, "Montage.tsx"), "utf8");
  const input = JSON.parse(fs.readFileSync(path.join(dir, "input.json"), "utf8"));
  const { blocks } = analyzeMontage(code, input.duration);
  const out = path.join(dir, "inspect");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const shots = blocks.filter(b => !["Sfx", "Music"].includes(b.type))
    .map(b => ({ t: Math.min(b.to - 0.15, b.from + Math.min(0.9, (b.to - b.from) / 2)), label: `${b.type} ${b.from.toFixed(1)}-${b.to.toFixed(1)}` }));
  shots.forEach((s, i) => {
    const text = s.label.replace(/[:']/g, " ");
    ffmpeg(["-ss", s.t.toFixed(2), "-i", video, "-frames:v", "1", "-vf",
      `scale=432:768,drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='${text}':x=6:y=6:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=5`,
      path.join(out, `shot-${String(i).padStart(2, "0")}.png`)]);
  });
  const files = fs.readdirSync(out).filter(f => f.startsWith("shot-")).sort();
  for (let sheet = 0; sheet * 8 < files.length; sheet++) {
    const part = files.slice(sheet * 8, sheet * 8 + 8);
    const inputs = part.flatMap(f => ["-i", path.join(out, f)]);
    const cols = Math.min(4, part.length);
    const layout = part.map((_, i) => `${(i % cols) * 432}_${Math.floor(i / cols) * 768}`).join("|");
    ffmpeg([...inputs, "-filter_complex", `${part.map((_, i) => `[${i}]`).join("")}xstack=inputs=${part.length}:layout=${layout}:fill=white`, path.join(out, `sheet-${sheet}.png`)]);
  }
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
// Sound levels of the finished video: loudness for TikTok is about -14..-16 LUFS, true peak under -1 dBTP.
const levels = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", path.join(path.resolve(process.argv[2]), "final.mp4"), "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
const summary = levels.stderr.slice(levels.stderr.lastIndexOf("Summary:"));
console.log(summary.replace(/\s+/g, " ").trim());
