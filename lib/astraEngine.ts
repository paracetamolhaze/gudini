import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AstraState } from "./astra/types";
import type { Word } from "./transcribe";

/**
 * Новая Астра: монтаж пишет сама Астра (GPT-6 через мост Codex) из кубиков astra-engine (Remotion),
 * картинки готовит и проверяет она же. Включается ASTRA_ENGINE=remotion; без переменной работает прежняя Астра.
 */
export const astraEngineEnabled = () => String(process.env.ASTRA_ENGINE ?? "").toLowerCase() === "remotion";

// Этапы движка на шкале конвейера: до монтажа 26 %, после рендера идут проверка и обложка (92 %+).
const STAGES: Record<string, [string, number]> = {
  prepare: ["Астра: подготовка записи", 27],
  write: ["Астра пишет монтаж", 30],
  assets: ["Астра готовит картинки", 40],
  check: ["Астра проверяет картинки", 50],
  cutout: ["Астра: вырезка автора", 55],
  draft: ["Астра смотрит черновик", 60],
  review: ["Астра правит монтаж", 65],
  final: ["Астра собирает ролик", 70],
};

export async function runAstraEngine(opts: {
  dir: string;
  source: string;
  words: Word[];
  duration: number;
  topic: string;
  facts?: string[];
  setStep: (step: string, progress: number) => void;
}): Promise<void> {
  const root = process.cwd();
  const engine = path.join(root, "astra-engine");
  const workDir = path.join(opts.dir, "astra");
  // Новый монтаж — с чистого листа; найденные и сгенерированные картинки прошлого запуска остаются в кэше.
  fs.rmSync(path.join(workDir, "run"), { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const specFile = path.join(workDir, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify({
    video: path.resolve(opts.dir, opts.source),
    duration: opts.duration,
    words: opts.words.map(w => ({ word: w.word, start: w.start, end: w.end })),
    topic: opts.topic,
    facts: opts.facts,
    workDir,
    soundsDir: path.join(root, "assets", "astra", "sounds"),
    memesDir: path.join(root, "assets", "astra", "memes"),
    cacheDir: path.join(root, "data", "astra-cache"),
  }));

  let result = "";
  let error = "";
  const tail: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(engine, "node_modules", "tsx", "dist", "cli.mjs"), "director/run-job.ts", specFile], {
      cwd: engine, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let pending = "";
    const line = (text: string) => {
      const [kind, ...rest] = text.split(" ");
      const value = rest.join(" ");
      if (kind === "STAGE") {
        const [name, fraction] = value.split(" ");
        const stage = STAGES[name];
        if (stage) opts.setStep(fraction && name === "final" ? `${stage[0]}: ${Math.round(Number(fraction) * 100)}%` : stage[0],
          stage[1] + (name === "final" && fraction ? Math.round(Number(fraction) * 20) : 0));
      } else if (kind === "LOG") console.log(`  Астра: ${value}`);
      else if (kind === "RESULT") result = value;
      else if (kind === "ERROR") error = value;
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let n: number;
      while ((n = pending.indexOf("\n")) >= 0) { line(pending.slice(0, n).trim()); pending = pending.slice(n + 1); }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      tail.push(...chunk.split(/\r?\n/).filter(Boolean));
      tail.splice(0, Math.max(0, tail.length - 30));
    });
    child.on("error", reject);
    child.on("close", code => {
      if (pending.trim()) line(pending.trim());
      if (code === 0 && result && fs.existsSync(result)) resolve();
      else reject(new Error(`Астра не собрала ролик: ${error || tail.slice(-3).join(" | ") || `код ${code}`}`.slice(0, 900)));
    });
  });
  fs.copyFileSync(result, path.join(opts.dir, "out.mp4"));
}

/** Состояние, которое понимает страница проекта: монтаж готов, материалов не требуется. */
export function astraEngineState(duration: number): AstraState {
  return { version: 1, key: `remotion-${Date.now()}`, status: "rendered", duration, inserts: [] };
}
