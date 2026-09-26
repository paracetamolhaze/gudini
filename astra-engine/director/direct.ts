// Command-line run of Astra on one prepared recording.
// npx tsx director/direct.ts --input job/input.json --topic "..." --public public --media dev/job --out out/job [--sounds dir] [--lessons file]
import fs from "node:fs";
import path from "node:path";
import { astraInputSchema } from "../src/input";
import { directMontage } from "./job";
import { linkSounds, prepareVoice } from "./sounds";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

async function main() {
  const out = path.resolve(arg("out", "out/job")!);
  const publicDir = path.resolve(arg("public", "public")!);
  const raw = JSON.parse(fs.readFileSync(path.resolve(arg("input")!), "utf8"));
  const library = linkSounds(arg("sounds"), publicDir);
  const video = path.join(publicDir, raw.video);
  // The voice goes in cleaned and at TikTok loudness; the video itself plays muted.
  const voice = raw.voice ?? prepareVoice(video, publicDir, `${arg("media", "dev")}/voice`);
  const input = astraInputSchema.parse({ ...raw, ...library, voice, cutouts: [] });
  const lessonsFile = arg("lessons");
  const lessons = lessonsFile && fs.existsSync(lessonsFile) ? fs.readFileSync(lessonsFile, "utf8").split(/\r?\n/).filter(Boolean) : [];
  const start = arg("start");
  await directMontage({
    input, topic: arg("topic", "")!, lessons, publicDir, mediaSubdir: arg("media", "dev")!, outDir: out, log: console.log,
    startCode: start ? fs.readFileSync(path.resolve(start), "utf8") : undefined, skipReview: process.argv.includes("--skip-review"),
    memesDir: arg("memes"),
    facts: arg("facts") && fs.existsSync(arg("facts")!) ? JSON.parse(fs.readFileSync(arg("facts")!, "utf8")) : undefined,
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
