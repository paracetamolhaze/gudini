import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getSettings } from "./store";
import { planBrollSegments } from "./ai";
import { Word } from "./transcribe";
import { EditEvent } from "./editPlan";

export type BrollClip = { start: number; end: number; file: string; query: string };

const MIN_LEN = 2.0; // сек
const MAX_LEN = 7.0;

const CACHE_DIR = path.join(process.cwd(), "data", "broll-cache");
const CACHE_INDEX = path.join(CACHE_DIR, "index.json");

type StockCandidate = {
  provider: "pexels" | "pixabay";
  id: string;
  url: string;
  width: number;
  height: number;
  duration: number;
  query: string;
};

type CacheEntry = StockCandidate & { file: string; at: string };

/**
 * Подбирает материал для B_ROLL-событий монтажного плана (параллельно).
 * Приоритет: готовый файл в проекте → Runway (если ключ) → сток (кэш → Pexels → Pixabay).
 * События без материала выбрасываются из плана (останется A-roll).
 */
export async function resolveBrollEvents(dir: string, events: EditEvent[]): Promise<EditEvent[]> {
  const brolls = events.filter((e) => e.type === "B_ROLL");
  const used = new Set<string>(); // не ставить один и тот же сток дважды в ролик
  await Promise.all(
    brolls.map(async (event, k) => {
      const file = `broll${k}.mp4`;
      const full = path.join(dir, file);
      if (fs.existsSync(full)) {
        event.file = file;
        return;
      }
      const queries = [event.query!, ...(event.altQueries ?? [])];
      try {
        if (getSettings().runwayKey && (await generateRunwayVideo(event.query!, full))) {
          event.file = file;
          return;
        }
      } catch (e) {
        console.warn(`Runway «${event.query}»:`, e);
      }
      try {
        if (await fetchStockVideo(queries, event.end - event.start, full, used)) {
          event.file = file;
        }
      } catch (e) {
        console.warn(`Сток «${event.query}»:`, e);
      }
    }),
  );
  // b-ролл без материала → выкидываем событие
  return events.filter((e) => e.type !== "B_ROLL" || e.file);
}

// ===== Fallback-план без ИИ (совместимость со старым конвейером) =====

export async function prepareBroll(dir: string, words: Word[], topic: string): Promise<BrollClip[]> {
  if (words.length < 10) return [];
  let plans = await planBrollSegments(words, topic).catch(() => null);
  if (!plans || !plans.length) plans = heuristicPlan(words);

  const segments: BrollClip[] = [];
  for (const plan of plans.slice(0, 8)) {
    const from = Math.max(0, Math.min(plan.from, words.length - 1));
    const to = Math.max(from, Math.min(plan.to, words.length - 1));
    const start = words[from].start;
    let end = Math.min(words[to].end + 0.15, start + MAX_LEN);
    if (end - start < MIN_LEN) end = start + MIN_LEN;
    const prev = segments[segments.length - 1];
    if (prev && start < prev.end + 0.5) continue;
    segments.push({ start, end, file: `broll${segments.length}.mp4`, query: plan.query });
  }

  const used = new Set<string>();
  const results = await Promise.all(
    segments.map(async (seg) => {
      const full = path.join(dir, seg.file);
      if (fs.existsSync(full)) return seg;
      try {
        if (getSettings().runwayKey && (await generateRunwayVideo(seg.query, full))) return seg;
      } catch (e) {
        console.warn(`Runway «${seg.query}»:`, e);
      }
      try {
        if (await fetchStockVideo([seg.query], seg.end - seg.start, full, used)) return seg;
      } catch (e) {
        console.warn(`Б-ролл «${seg.query}»:`, e);
      }
      return null;
    }),
  );
  return results.filter((c): c is BrollClip => c !== null);
}

function heuristicPlan(words: Word[]): { from: number; to: number; query: string }[] {
  const spots = [0.15, 0.32, 0.5, 0.68, 0.85];
  return spots.map((fraction) => {
    const center = Math.floor(words.length * fraction);
    const from = Math.max(2, center - 1);
    const to = Math.min(words.length - 1, from + 2);
    const query = words
      .slice(from, to + 1)
      .map((w) => w.word.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean)
      .join(" ");
    return { from, to, query };
  });
}

// ===== Сток: кандидаты с нескольких запросов, ранжирование, кэш =====

/** Ищет лучший стоковый ролик по списку запросов, скачивает в outPath. */
export async function fetchStockVideo(
  queries: string[],
  minDuration: number,
  outPath: string,
  used: Set<string> = new Set(),
): Promise<boolean> {
  const clean = queries.map((q) => q.trim()).filter(Boolean);
  if (!clean.length) return false;

  // кэш: точное совпадение запроса
  for (const query of clean) {
    const hit = cacheLookup(query, minDuration, used);
    if (hit) {
      fs.copyFileSync(path.join(CACHE_DIR, hit.file), outPath);
      used.add(`${hit.provider}:${hit.id}`);
      return true;
    }
  }

  for (const query of clean) {
    const candidates = [...(await searchPexels(query)), ...(await searchPixabay(query))];
    const scored = candidates
      .filter((c) => !used.has(`${c.provider}:${c.id}`) && c.duration >= Math.max(2, minDuration))
      .map((c) => ({ c, score: scoreCandidate(c) }))
      .sort((a, b) => b.score - a.score);

    for (const { c } of scored.slice(0, 3)) {
      try {
        const download = await fetch(c.url);
        if (!download.ok) continue;
        const buffer = Buffer.from(await download.arrayBuffer());
        if (buffer.length < 50_000) continue;
        fs.writeFileSync(outPath, buffer);
        used.add(`${c.provider}:${c.id}`);
        cacheStore(c, buffer);
        return true;
      } catch {}
    }
  }
  return false;
}

function scoreCandidate(c: StockCandidate): number {
  let score = 0;
  if (c.height > c.width) score += 2; // вертикаль предпочтительна (иначе будет cover-crop)
  score += 1 - Math.min(1, Math.abs(c.width - 1080) / 1080); // разрешение ближе к 1080
  if (c.duration >= 5 && c.duration <= 60) score += 0.5; // короткие клипы, не часовые записи
  return score;
}

async function searchPexels(query: string): Promise<StockCandidate[]> {
  const key = getSettings().pexelsKey;
  if (!key) return [];
  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "portrait");
  url.searchParams.set("per_page", "8");
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) return [];
  const json: any = await res.json();
  const out: StockCandidate[] = [];
  for (const video of json.videos ?? []) {
    const files = (video.video_files ?? [])
      .filter((f: any) => f.link && f.width >= 540 && f.width <= 1600)
      .sort((a: any, b: any) => Math.abs(a.width - 1080) - Math.abs(b.width - 1080));
    if (!files[0]) continue;
    out.push({
      provider: "pexels",
      id: String(video.id),
      url: files[0].link,
      width: files[0].width,
      height: files[0].height,
      duration: video.duration ?? 0,
      query,
    });
  }
  return out;
}

async function searchPixabay(query: string): Promise<StockCandidate[]> {
  const key = getSettings().pixabayKey;
  if (!key) return [];
  const url = new URL("https://pixabay.com/api/videos/");
  url.searchParams.set("key", key);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", "8");
  url.searchParams.set("safesearch", "true");
  const res = await fetch(url);
  if (!res.ok) return [];
  const json: any = await res.json();
  const out: StockCandidate[] = [];
  for (const hit of json.hits ?? []) {
    const variant = hit.videos?.large?.url ? hit.videos.large : hit.videos?.medium;
    if (!variant?.url) continue;
    out.push({
      provider: "pixabay",
      id: String(hit.id),
      url: variant.url,
      width: variant.width ?? 0,
      height: variant.height ?? 0,
      duration: hit.duration ?? 0,
      query,
    });
  }
  return out;
}

// ===== Кэш скачанных ассетов =====

function readCache(): CacheEntry[] {
  try {
    return JSON.parse(fs.readFileSync(CACHE_INDEX, "utf8"));
  } catch {
    return [];
  }
}

function cacheLookup(query: string, minDuration: number, used: Set<string>): CacheEntry | null {
  const q = query.toLowerCase();
  const entries = readCache().filter(
    (e) =>
      e.query.toLowerCase() === q &&
      e.duration >= Math.max(2, minDuration) &&
      !used.has(`${e.provider}:${e.id}`) &&
      fs.existsSync(path.join(CACHE_DIR, e.file)),
  );
  return entries.sort((a, b) => scoreCandidate(b) - scoreCandidate(a))[0] ?? null;
}

function cacheStore(c: StockCandidate, buffer: Buffer) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const file = crypto.createHash("sha1").update(`${c.provider}:${c.id}`).digest("hex").slice(0, 16) + ".mp4";
    fs.writeFileSync(path.join(CACHE_DIR, file), buffer);
    const index = readCache().filter((e) => !(e.provider === c.provider && e.id === c.id));
    index.push({ ...c, file, at: new Date().toISOString() });
    fs.writeFileSync(CACHE_INDEX, JSON.stringify(index, null, 2));
  } catch {}
}

// ===== Runway: ИИ-генерация перебивки под точную фразу =====

const RUNWAY_BASE = "https://api.dev.runwayml.com/v1";

async function generateRunwayVideo(query: string, outPath: string): Promise<boolean> {
  const key = getSettings().runwayKey;
  if (!key || !query.trim()) return false;
  const headers = {
    Authorization: `Bearer ${key}`,
    "X-Runway-Version": "2024-11-06",
    "Content-Type": "application/json",
  };

  // 1) кадр по описанию
  const imageTask = await runwayPost("/text_to_image", headers, {
    model: "gen4_image",
    promptText: `${query}, vertical cinematic shot, realistic, high detail`,
    ratio: "1080:1920",
  });
  const imageUrl = await runwayWait(imageTask, headers);

  // 2) оживляем кадр в 5-секундный клип
  const videoTask = await runwayPost("/image_to_video", headers, {
    model: "gen4_turbo",
    promptImage: imageUrl,
    promptText: query,
    ratio: "720:1280",
    duration: 5,
  });
  const videoUrl = await runwayWait(videoTask, headers);

  const download = await fetch(videoUrl);
  if (!download.ok) throw new Error(`Runway download: ${download.status}`);
  const buffer = Buffer.from(await download.arrayBuffer());
  if (buffer.length < 50_000) throw new Error("Runway вернул пустой файл");
  fs.writeFileSync(outPath, buffer);
  return true;
}

async function runwayPost(endpoint: string, headers: Record<string, string>, body: unknown): Promise<string> {
  const res = await fetch(RUNWAY_BASE + endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Runway ${endpoint}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json: any = await res.json();
  if (!json.id) throw new Error(`Runway ${endpoint}: нет id задачи`);
  return json.id;
}

/** Ждёт завершения задачи Runway (до 5 минут), возвращает URL результата. */
async function runwayWait(taskId: string, headers: Record<string, string>): Promise<string> {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${RUNWAY_BASE}/tasks/${taskId}`, { headers });
    if (!res.ok) throw new Error(`Runway task: ${res.status}`);
    const json: any = await res.json();
    if (json.status === "SUCCEEDED") {
      const url = Array.isArray(json.output) ? json.output[0] : json.output;
      if (!url) throw new Error("Runway: задача завершилась без результата");
      return String(url);
    }
    if (json.status === "FAILED" || json.status === "CANCELLED") {
      throw new Error(`Runway: ${json.status} ${json.failure ?? json.failureCode ?? ""}`);
    }
  }
  throw new Error("Runway: задача не завершилась за 5 минут");
}
