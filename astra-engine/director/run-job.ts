// Entry point for the site's pipeline: one cleaned recording in, Astra's finished montage out.
// npx tsx director/run-job.ts spec.json
// Prints "STAGE <name> [fraction]" lines for the progress bar, "LOG <line>" for the worker log,
// and "RESULT <path to final.mp4>" at the end. Exits with code 1 and an "ERROR <message>" line on failure.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { astraInputSchema, DEFAULT_FACE, type Word } from "../src/input";
import { directMontage } from "./job";
import { linkSounds, prepareVoiceAsync } from "./sounds";
import { ENGINE_ROOT } from "./workspace";

export type JobSpec = {
  /** The recording after speech cleanup, 1080x1920. */
  video: string;
  duration: number;
  /** Words on the cleaned timeline. */
  words: Word[];
  topic: string;
  /** Checked facts of the story, if the project has research. */
  facts?: string[];
  /** Folder for this job: the render's public folder and Astra's working files are made inside. */
  workDir: string;
  /** The owner's sound library (sfx/<role>, music/<mood>) and meme clips. */
  soundsDir?: string;
  memesDir?: string;
  /** Prepared sounds are kept here between jobs. */
  cacheDir?: string;
};

const emit = (line: string) => process.stdout.write(`${line.replace(/\r?\n/g, " ")}\n`);

/** Where the author's head is, from the matting silhouette; the default box if the tool is unavailable. */
function findFace(video: string, duration: number) {
  try {
    const python = process.env.ASTRA_PYTHON ?? "python3";
    const model = process.env.ASTRA_RVM_MODEL ?? path.join(ENGINE_ROOT, "matting/rvm_mobilenetv3_fp32.onnx");
    const out = execFileSync(python, [path.join(ENGINE_ROOT, "matting/head.py"), "--video", video, "--duration", String(duration), "--model", model],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
    const box = JSON.parse(out.trim().split(/\r?\n/).pop() ?? "{}");
    if ([box.x, box.y, box.w, box.h].every((n: unknown) => typeof n === "number" && Number.isFinite(n))) return box as typeof DEFAULT_FACE;
  } catch (error) {
    emit(`LOG Положение головы не найдено, беру обычное: ${String((error as Error).message).slice(0, 160)}`);
  }
  return DEFAULT_FACE;
}

async function main() {
  const spec = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), "utf8")) as JobSpec;
  const publicDir = path.join(spec.workDir, "public");
  const outDir = path.join(spec.workDir, "run");
  fs.mkdirSync(path.join(publicDir, "job"), { recursive: true });
  fs.cpSync(path.join(ENGINE_ROOT, "public/fonts"), path.join(publicDir, "fonts"), { recursive: true });
  // The recording enters the render's public folder without a second copy when the file system allows it.
  const video = path.join(publicDir, "job/video.mp4");
  fs.rmSync(video, { force: true });
  try { fs.linkSync(spec.video, video); } catch { fs.copyFileSync(spec.video, video); }

  emit("STAGE prepare");
  const face = findFace(video, spec.duration);
  const library = linkSounds(spec.soundsDir, publicDir, spec.cacheDir ?? publicDir);
  const voice = prepareVoiceAsync(video, publicDir, "job");
  const input = astraInputSchema.parse({
    duration: spec.duration, fps: 30, video: "job/video.mp4", words: spec.words, face, ...library, cutouts: [],
  });
  const result = await directMontage({
    input, topic: spec.topic, lessons: [], facts: spec.facts, publicDir, mediaSubdir: "job", outDir,
    memesDir: spec.memesDir, voice, skipReview: process.env.ASTRA_REVIEW !== "1",
    log: line => emit(`LOG ${line}`),
    onStage: (stage, fraction) => emit(`STAGE ${stage}${fraction === undefined ? "" : ` ${fraction.toFixed(3)}`}`),
  });
  emit(`RESULT ${result.final}`);
}

main().catch(error => {
  emit(`ERROR ${String((error as Error)?.message ?? error).slice(0, 600)}`);
  process.exitCode = 1;
});
