// Command-line run of Astra on one prepared recording.
// npx tsx director/direct.ts --input job/input.json --topic "..." --public public --media dev/job --out out/job [--sounds dir] [--lessons file]
import fs from "node:fs";
import path from "node:path";
import { astraInputSchema } from "../src/input";
import { directMontage } from "./job";
import { linkSounds } from "./sounds";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

async function main() {
  const out = path.resolve(arg("out", "out/job")!);
  const publicDir = path.resolve(arg("public", "public")!);
  const raw = JSON.parse(fs.readFileSync(path.resolve(arg("input")!), "utf8"));
  const input = astraInputSchema.parse({ ...raw, ...linkSounds(arg("sounds"), publicDir), cutouts: [] });
  const lessonsFile = arg("lessons");
  const lessons = lessonsFile && fs.existsSync(lessonsFile) ? fs.readFileSync(lessonsFile, "utf8").split(/\r?\n/).filter(Boolean) : [];
  await directMontage({ input, topic: arg("topic", "")!, lessons, publicDir, mediaSubdir: arg("media", "dev")!, outDir: out, log: console.log });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
