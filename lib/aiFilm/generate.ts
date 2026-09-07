import fs from "fs";
import path from "path";
import crypto from "crypto";
import { probeDuration, runFfmpeg } from "../ffmpeg";
import { recordFlat, assertBudget } from "../costLedger";
import { sceneKey } from "./plan";
import { startVeo, waitVeo, downloadGcs, uploadGcs, veoBody, VEO_BUCKET } from "./veo";
import type { AiFilmPlan, AiFilmSceneResult, FilmScene } from "./types";

/**
 * Генерация сцен по плану. Всё лежит в <проект>/ai-film/:
 *   scenes.json            — кэш: ключ сцены → результат (файл, GCS, операция, цена)
 *   raw/<scene>.json       — запрос, операция и ответ Veo как есть
 *   raw/<scene>.mp4        — сырое видео сцены, как вернул Veo
 *   sequence-N.mp4         — цельная последовательность (последняя extension-сцена)
 *
 * Сцена с тем же ключом (модель + режим + промпт + источник) не генерируется заново:
 * правка одной сцены в плане не трогает остальные — цепочка extension пересобирается
 * только от изменённой сцены дальше, потому что ключ включает ключ источника.
 * Сбой Veo — ошибка стадии; автоповтор только на сетевую ошибку (не на отказ модели).
 */

export const FILM_DIR = "ai-film";
const RAW_DIR = "raw";

type Cache = Record<string, AiFilmSceneResult>;

export function filmDir(dir: string): string {
  return path.join(dir, FILM_DIR);
}

function loadCache(dir: string): Cache {
  try {
    return JSON.parse(fs.readFileSync(path.join(filmDir(dir), "scenes.json"), "utf8"));
  } catch {
    return {};
  }
}

function saveCache(dir: string, cache: Cache): void {
  fs.mkdirSync(filmDir(dir), { recursive: true });
  fs.writeFileSync(path.join(filmDir(dir), "scenes.json"), JSON.stringify(cache, null, 2));
}

const short = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

export type GenerateProgress = (msg: string, fraction: number) => void;

/** Последний кадр видео → JPEG (первый кадр следующей последовательности). */
async function lastFrame(video: string, out: string): Promise<void> {
  const dur = await probeDuration(video);
  await runFfmpeg(["-ss", Math.max(0, dur - 0.1).toFixed(3), "-i", video, "-frames:v", "1", "-q:v", "2", out]);
}

/** Веб-ошибки, которые имеет смысл повторить один раз; отказ модели — нет. */
const transient = (e: unknown) => /\b(429|5\d\d)\b|ECONNRESET|fetch failed|timeout|EAI_AGAIN/i.test(String((e as any)?.message ?? e));

export async function generateScene(args: {
  dir: string;
  projectId: string;
  plan: AiFilmPlan;
  scene: FilmScene;
  key: string;
  imageGcsUri?: string;
  videoGcsUri?: string;
  onProgress?: (msg: string) => void;
}): Promise<AiFilmSceneResult> {
  const { dir, plan, scene, key } = args;
  const rawDir = path.join(filmDir(dir), RAW_DIR);
  fs.mkdirSync(rawDir, { recursive: true });
  const cost = Math.round(scene.seconds * plan.pricePerSec * 1000) / 1000;
  assertBudget("AI Film Generation", cost);
  const storageUri = `gs://${VEO_BUCKET}/${args.projectId}/${short(key)}/`;
  const req = { model: plan.model, prompt: scene.prompt, durationSeconds: scene.seconds, storageUri, imageGcsUri: args.imageGcsUri, videoGcsUri: args.videoGcsUri };
  const rawJson = path.join(rawDir, `${scene.id}-${short(key)}.json`);
  let operation = "";
  let attempt = 0;
  for (;;) {
    try {
      operation = await startVeo(req);
      fs.writeFileSync(rawJson, JSON.stringify({ key, request: veoBody(req), operation, startedAt: new Date().toISOString() }, null, 2));
      // считаем сразу: операция запущена — деньги, скорее всего, уже списаны
      recordFlat({ stage: "AI Film Generation", provider: "google", model: plan.model, cost, estimated: true });
      const result = await waitVeo(plan.model, operation, (sec) => args.onProgress?.(`сцена ${scene.id}: Veo работает ${Math.round(sec)} с`));
      const file = path.join(rawDir, `${scene.id}-${short(key)}.mp4`);
      await downloadGcs(result.gcsUri, file);
      const dur = await probeDuration(file);
      if (dur < 1) throw new Error(`Veo: сцена ${scene.id} пустая (${dur.toFixed(1)} с)`);
      fs.writeFileSync(rawJson, JSON.stringify({ key, request: veoBody(req), operation, response: result.raw, file: path.relative(dir, file), duration: dur, finishedAt: new Date().toISOString() }, null, 2));
      return { sceneId: scene.id, key, gcsUri: result.gcsUri, file: path.relative(dir, file), operation, seconds: scene.seconds, cost, createdAt: new Date().toISOString() };
    } catch (e) {
      if (attempt === 0 && transient(e) && !operation) {
        attempt++;
        args.onProgress?.(`сцена ${scene.id}: сетевая ошибка, один повтор`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      fs.writeFileSync(rawJson, JSON.stringify({ key, request: veoBody(req), operation, error: String((e as any)?.message ?? e), failedAt: new Date().toISOString() }, null, 2));
      if (operation) recordFlat({ stage: "AI Film Generation", provider: "google", model: plan.model, cost, estimated: true, failed: true });
      throw e;
    }
  }
}

/**
 * Последовательности по плану. Возвращает файлы sequence-N.mp4 (относительно dir)
 * и реальную сумму, потраченную в этом запуске.
 */
export async function generateSequences(args: {
  dir: string;
  projectId: string;
  plan: AiFilmPlan;
  onProgress?: GenerateProgress;
}): Promise<{ files: string[]; spent: number; generated: number; cached: number }> {
  const { dir, plan, projectId } = args;
  const cache = loadCache(dir);
  const files: string[] = [];
  let spent = 0;
  let generated = 0;
  let cached = 0;
  const total = plan.calls;
  let done = 0;
  for (const seq of plan.sequences) {
    let sourceKey: string | null = null;
    let sourceGcs: string | null = null;
    let sourceFile: string | null = null;
    let sourceDur = 0;
    let imageGcs: string | undefined;
    for (const scene of seq.scenes) {
      if (scene.mode === "image") {
        // первый кадр — последний кадр предыдущей последовательности (сгенерированной Veo, не автора)
        const prevFile = files[seq.index - 1];
        if (!prevFile) throw new Error(`AI-фильм: для ${scene.id} нет предыдущей последовательности`);
        const jpg = path.join(filmDir(dir), `seq-${seq.index}-start.jpg`);
        await lastFrame(path.join(dir, prevFile), jpg);
        imageGcs = `gs://${VEO_BUCKET}/${projectId}/frames/seq-${seq.index}-${short(sourceKey ?? prevFile)}.jpg`;
        await uploadGcs(jpg, imageGcs, "image/jpeg");
        sourceKey = `image:${short(fs.readFileSync(jpg).toString("base64"))}`;
      }
      const key = sceneKey(scene, plan.model, sourceKey);
      let res = cache[key];
      if (res && fs.existsSync(path.join(dir, res.file))) {
        cached++;
        args.onProgress?.(`сцена ${scene.id}: из кэша`, done / total);
      } else {
        args.onProgress?.(`сцена ${scene.id}: генерация (${scene.mode}, ${scene.seconds} с)`, done / total);
        res = await generateScene({
          dir,
          projectId,
          plan,
          scene,
          key,
          imageGcsUri: scene.mode === "image" ? imageGcs : undefined,
          videoGcsUri: scene.mode === "extend" ? sourceGcs ?? undefined : undefined,
          onProgress: (m) => args.onProgress?.(m, done / total),
        });
        cache[key] = res;
        saveCache(dir, cache);
        spent += res.cost;
        generated++;
      }
      done++;
      // extension возвращает либо всё видео целиком, либо только новые секунды — по длине видно
      const file = path.join(dir, res.file);
      const dur = await probeDuration(file);
      if (scene.mode === "extend" && sourceFile && dur < sourceDur + scene.seconds - 1.5) {
        const joined = path.join(filmDir(dir), `join-${scene.id}-${short(key)}.mp4`);
        if (!fs.existsSync(joined)) {
          await runFfmpeg([
            "-i", sourceFile, "-i", file,
            "-filter_complex", "[0:v]fps=24,scale=1280:720,setsar=1[a];[1:v]fps=24,scale=1280:720,setsar=1[b];[a][b]concat=n=2:v=1:a=0[v]",
            "-map", "[v]", "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p", joined,
          ]);
        }
        sourceFile = joined;
        sourceDur = await probeDuration(joined);
      } else {
        sourceFile = file;
        sourceDur = dur;
      }
      sourceKey = key;
      sourceGcs = res.gcsUri;
    }
    if (!sourceFile) throw new Error(`AI-фильм: последовательность ${seq.index + 1} без сцен`);
    const out = path.join(filmDir(dir), `sequence-${seq.index}.mp4`);
    fs.copyFileSync(sourceFile, out);
    files.push(path.relative(dir, out));
  }
  return { files, spent, generated, cached };
}
