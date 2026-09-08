import fs from "fs";
import path from "path";
import crypto from "crypto";
import { probeDuration, runFfmpeg } from "../ffmpeg";
import { ledger, recordFlat, reserveBudget, releaseBudget } from "../costLedger";
import { shotKey } from "./plan";
import { mimeFor } from "./character";
import { startVeo, waitVeo, downloadGcs, uploadGcs, veoBody, VeoOperationError, VEO_BUCKET, type VeoReference, type VeoRequest } from "./veo";
import type { AiFilmPlan, AiFilmShotResult, CharacterProfile, ContinuityGroup, FilmShot, GroupClip } from "./types";

/**
 * Генерация v2 по графу зависимостей. Всё лежит в <проект>/ai-film/:
 *   shots.json          — кэш: ключ shot → результат (файл, GCS, операция, цена)
 *   raw/<shot>-<key>.json / .mp4 — запрос, операция, ответ и сырое видео как есть
 *   group-<id>.mp4      — клип группы (для цепочки — последняя extension)
 *
 * Независимые группы идут параллельно через пул (AI_FILM_VEO_CONCURRENCY), цепочка —
 * последовательно. Ключ shot включает промпт, параметры, хэш эталонов и ключ источника:
 * правка независимого shot не трогает остальные, правка первого shot цепочки
 * пересобирает только её. Принятая Vertex операция сохраняется до опроса: если ответ
 * потерялся, повторный запуск опрашивает её, а не платит за новую.
 */

export const FILM_DIR = "ai-film";
const RAW_DIR = "raw";

type Cache = Record<string, AiFilmShotResult>;

export function filmDir(dir: string): string {
  return path.join(dir, FILM_DIR);
}

function loadCache(dir: string): Cache {
  try {
    return JSON.parse(fs.readFileSync(path.join(filmDir(dir), "shots.json"), "utf8"));
  } catch {
    return {};
  }
}

let saveChain = Promise.resolve();
function saveCache(dir: string, cache: Cache): Promise<void> {
  saveChain = saveChain.then(() => {
    fs.mkdirSync(filmDir(dir), { recursive: true });
    fs.writeFileSync(path.join(filmDir(dir), "shots.json"), JSON.stringify(cache, null, 2));
  });
  return saveChain;
}

const short = (s: string | Buffer) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

export type GenerateProgress = (msg: string, fraction: number) => void;

/** Эталоны героя → GCS (идемпотентно, по хэшу содержимого). Только картинки персонажа, не видео автора. */
export async function uploadReferences(character: CharacterProfile): Promise<VeoReference[]> {
  const out: VeoReference[] = [];
  for (const file of character.referenceFiles) {
    const ext = path.extname(file).toLowerCase() || ".png";
    const uri = `gs://${VEO_BUCKET}/characters/${character.id}/${short(fs.readFileSync(file))}${ext}`;
    await uploadGcs(file, uri, mimeFor(file));
    out.push({ gcsUri: uri, mimeType: mimeFor(file) });
  }
  return out;
}

/** Небольшой пул: не больше n задач одновременно; после первой ошибки новые не стартуют. */
export async function runPool<T>(tasks: (() => Promise<T>)[], n: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < tasks.length && failed == null) {
      const i = next++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        if (failed == null) failed = e;
      }
    }
  };
  await Promise.all(new Array(Math.max(1, Math.min(n, tasks.length))).fill(0).map(worker));
  if (failed != null) throw failed;
  return results;
}

type RawRecord = { key: string; request: unknown; operation?: string; response?: unknown; file?: string; duration?: number; error?: string; terminalError?: boolean; startedAt?: string; finishedAt?: string; failedAt?: string };

export async function generateShot(args: {
  dir: string;
  projectId: string;
  shot: FilmShot;
  key: string;
  references: VeoReference[];
  videoGcsUri?: string;
  onProgress?: (msg: string) => void;
}): Promise<AiFilmShotResult> {
  const { dir, shot, key } = args;
  const rawDir = path.join(filmDir(dir), RAW_DIR);
  fs.mkdirSync(rawDir, { recursive: true });
  const rawJson = path.join(rawDir, `${shot.id}-${key}.json`);
  const file = path.join(rawDir, `${shot.id}-${key}.mp4`);
  const req: VeoRequest = {
    model: shot.model,
    prompt: shot.prompt,
    durationSeconds: shot.veoSeconds,
    storageUri: `gs://${VEO_BUCKET}/${args.projectId}/${key}/`,
    aspectRatio: shot.aspectRatio,
    resolution: shot.resolution,
    videoGcsUri: shot.mode === "extend" ? args.videoGcsUri : undefined,
    referenceImages: shot.useReferences ? args.references : undefined,
  };
  if (shot.mode === "extend" && !req.videoGcsUri) throw new Error(`AI-фильм: у extension ${shot.id} нет исходного видео`);
  const write = (rec: RawRecord) => fs.writeFileSync(rawJson, JSON.stringify(rec, null, 2));

  // потерянный ответ прошлого запуска: операция принята — опрашиваем её, не платим заново
  let operation = "";
  try {
    const prev = JSON.parse(fs.readFileSync(rawJson, "utf8")) as RawRecord;
    if (prev.key === key && prev.operation && !prev.terminalError) {
      operation = prev.operation;
      args.onProgress?.(`shot ${shot.id}: операция уже была запущена, продолжаю опрос`);
    }
  } catch {}

  const reservation = reserveBudget("AI Film Generation", operation ? 0 : shot.cost);
  try {
    if (!operation) {
      operation = await startVeo(req, (attempt, why) => args.onProgress?.(`shot ${shot.id}: повтор запуска ${attempt} (${why})`));
      write({ key, request: veoBody(req), operation, startedAt: new Date().toISOString() });
      // считаем сразу: операция принята — деньги, скорее всего, уже списаны
      recordFlat({ stage: "AI Film Generation", provider: "google", model: shot.model, cost: shot.cost, estimated: true });
      // The accepted call is now in the ledger; do not also count its reservation
      // while the other groups are waiting to start.
      releaseBudget(reservation);
    }
    const result = await waitVeo(shot.model, operation, (sec) => args.onProgress?.(`shot ${shot.id}: Veo работает ${Math.round(sec)} с`));
    await downloadGcs(result.gcsUri, file);
    const dur = await probeDuration(file);
    if (dur < 1) throw new Error(`Veo: shot ${shot.id} пустой (${dur.toFixed(1)} с)`);
    write({ key, request: veoBody(req), operation, response: result.raw, file: path.relative(dir, file), duration: dur, finishedAt: new Date().toISOString() });
    return { shotId: shot.id, key, gcsUri: result.gcsUri, file: path.relative(dir, file), operation, veoSeconds: shot.veoSeconds, cost: shot.cost, createdAt: new Date().toISOString() };
  } catch (e) {
    write({ key, request: veoBody(req), operation, error: String((e as any)?.message ?? e), terminalError: e instanceof VeoOperationError, failedAt: new Date().toISOString() });
    if (operation) recordFlat({ stage: "AI Film Generation", provider: "google", model: shot.model, cost: 0, estimated: true, failed: true });
    throw new Error(`AI-фильм, shot ${shot.id} (${shot.mode}, ${shot.veoSeconds} с): ${String((e as any)?.message ?? e)}`);
  } finally {
    releaseBudget(reservation);
  }
}

/** Цепочка группы: text → extend → extend; клип группы — последний файл (или склейка, если extension вернул только хвост). */
async function generateGroup(args: {
  dir: string;
  projectId: string;
  plan: AiFilmPlan;
  group: ContinuityGroup;
  references: VeoReference[];
  refHash: string;
  cache: Cache;
  onProgress?: (msg: string) => void;
}): Promise<{ clip: GroupClip; generated: number; cached: number }> {
  const { dir, plan, group, cache } = args;
  const shots = group.shotIds.map((id) => plan.shots.find((s) => s.id === id)!);
  let sourceKey: string | null = null;
  let sourceGcs: string | null = null;
  let sourceFile: string | null = null;
  let sourceDur = 0;
  let generated = 0;
  let cached = 0;
  for (const shot of shots) {
    const key = shotKey(shot, args.refHash, sourceKey);
    let res = cache[key];
    if (res && fs.existsSync(path.join(dir, res.file))) {
      cached++;
      args.onProgress?.(`shot ${shot.id}: из кэша`);
    } else {
      args.onProgress?.(`shot ${shot.id}: генерация (${shot.mode}, ${shot.veoSeconds} с, ${shot.aspectRatio}${shot.useReferences ? ", с эталонами" : ""})`);
      res = await generateShot({ dir, projectId: args.projectId, shot, key, references: args.references, videoGcsUri: sourceGcs ?? undefined, onProgress: args.onProgress });
      cache[key] = res;
      await saveCache(dir, cache);
      generated++;
    }
    const file = path.join(dir, res.file);
    const dur = await probeDuration(file);
    // extension возвращает либо всё видео целиком, либо только новые секунды — по длине видно
    if (shot.mode === "extend" && sourceFile && dur < sourceDur + shot.veoSeconds - 1.5) {
      const joined = path.join(filmDir(dir), `join-${shot.id}-${key}.mp4`);
      if (!fs.existsSync(joined)) {
        const size = shot.aspectRatio === "9:16" ? "720:1280" : "1280:720";
        await runFfmpeg([
          "-i", sourceFile, "-i", file,
          "-filter_complex", `[0:v]fps=24,scale=${size},setsar=1[a];[1:v]fps=24,scale=${size},setsar=1[b];[a][b]concat=n=2:v=1:a=0[v]`,
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
  if (!sourceFile) throw new Error(`AI-фильм: группа ${group.id} без shots`);
  const out = path.join(filmDir(dir), `group-${group.id}.mp4`);
  fs.copyFileSync(sourceFile, out);
  return { clip: { groupId: group.id, file: path.relative(dir, out), seconds: sourceDur }, generated, cached };
}

/** Все группы плана: независимые параллельно (пул), цепочки внутри себя последовательно. */
export async function generateGroups(args: {
  dir: string;
  projectId: string;
  plan: AiFilmPlan;
  character: CharacterProfile;
  concurrency: number;
  onProgress?: GenerateProgress;
}): Promise<{ clips: GroupClip[]; spent: number; generated: number; cached: number }> {
  const { dir, plan, character } = args;
  const spentBefore = ledger().filter((e) => e.stage === "AI Film Generation").reduce((sum, e) => sum + e.estimatedCost, 0);
  const cache = loadCache(dir);
  const needRefs = plan.shots.some((s) => s.useReferences);
  const references = needRefs ? await uploadReferences(character) : [];
  const total = Math.max(1, plan.shots.length);
  let done = 0;
  const progress = (msg: string) => args.onProgress?.(msg, done / total);
  // длинные цепочки первыми — так пул заканчивает раньше
  const order = [...plan.groups].sort((a, b) => b.shotIds.length - a.shotIds.length);
  const results = await runPool(
    order.map((group) => async () => {
      const r = await generateGroup({ dir, projectId: args.projectId, plan, group, references, refHash: character.refHash, cache, onProgress: progress });
      done += group.shotIds.length;
      args.onProgress?.(`группа ${group.id} готова`, done / total);
      return r;
    }),
    args.concurrency,
  );
  const byId = new Map(results.map((r) => [r.clip.groupId, r]));
  const clips = plan.groups.map((g) => byId.get(g.id)!.clip);
  return {
    clips,
    spent: Number((ledger().filter((e) => e.stage === "AI Film Generation").reduce((sum, e) => sum + e.estimatedCost, 0) - spentBefore).toFixed(6)),
    generated: results.reduce((a, r) => a + r.generated, 0),
    cached: results.reduce((a, r) => a + r.cached, 0),
  };
}
