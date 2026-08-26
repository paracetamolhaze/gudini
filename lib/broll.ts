import fs from "fs";
import path from "path";
import { getSettings } from "./store";
import { planBrollSegments } from "./ai";
import { Word } from "./transcribe";

export type BrollClip = { start: number; end: number; file: string; query: string };

const MIN_LEN = 2.0; // сек
const MAX_LEN = 5.0;

/**
 * Готовит перебивки: ИИ (или эвристика) выбирает фразы, для каждой берётся ролик.
 * Приоритет источника: файл broll{k}.mp4 в проекте → Runway (ИИ-генерация, если есть ключ) →
 * сток Pexels/Pixabay. Без источников возвращает пустой список — монтаж идёт без перебивок.
 */
export async function prepareBroll(dir: string, words: Word[], topic: string): Promise<BrollClip[]> {
  if (words.length < 10) return [];

  // --- выбор фраз ---
  let plans = await planBrollSegments(words, topic).catch(() => null);
  if (!plans || !plans.length) plans = heuristicPlan(words);

  // --- раскладка по времени без пересечений ---
  const segments: BrollClip[] = [];
  for (const plan of plans.slice(0, 6)) {
    const from = Math.max(0, Math.min(plan.from, words.length - 1));
    const to = Math.max(from, Math.min(plan.to, words.length - 1));
    const start = words[from].start;
    let end = Math.min(words[to].end + 0.15, start + MAX_LEN);
    if (end - start < MIN_LEN) end = start + MIN_LEN;
    const prev = segments[segments.length - 1];
    if (prev && start < prev.end + 0.8) continue;
    segments.push({ start, end, file: `broll${segments.length}.mp4`, query: plan.query });
  }

  // --- материалы (параллельно) ---
  const results = await Promise.all(
    segments.map(async (seg) => {
      const full = path.join(dir, seg.file);
      if (fs.existsSync(full)) return seg;
      const runway = Boolean(getSettings().runwayKey);
      try {
        if (runway && (await generateRunwayVideo(seg.query, full))) return seg;
      } catch (e) {
        console.warn(`Runway «${seg.query}» не сгенерировался:`, e);
      }
      try {
        if (await fetchStockVideo(seg.query, seg.end - seg.start, full)) return seg;
      } catch (e) {
        console.warn(`Б-ролл «${seg.query}» не скачался:`, e);
      }
      return null;
    }),
  );

  return results.filter((c): c is BrollClip => c !== null);
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

/** Эвристика без ИИ: окна по 3 слова равномерно по ролику, запрос — сами слова. */
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

/** Ищет и скачивает стоковый ролик: сначала Pexels, затем Pixabay. */
export async function fetchStockVideo(query: string, minDuration: number, outPath: string): Promise<boolean> {
  if (!query.trim()) return false;
  if (await fetchPexels(query, minDuration, outPath)) return true;
  return fetchPixabay(query, minDuration, outPath);
}

async function fetchPexels(query: string, minDuration: number, outPath: string): Promise<boolean> {
  const key = getSettings().pexelsKey;
  if (!key) return false;

  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "portrait");
  url.searchParams.set("per_page", "5");
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) throw new Error(`Pexels: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json: any = await res.json();

  for (const video of json.videos ?? []) {
    if ((video.duration ?? 0) < Math.max(2, minDuration)) continue;
    // портретный файл разумного размера (720–1440 по ширине)
    const files = (video.video_files ?? [])
      .filter((f: any) => f.height > f.width && f.width >= 540 && f.width <= 1440 && f.link)
      .sort((a: any, b: any) => Math.abs(a.width - 1080) - Math.abs(b.width - 1080));
    const file = files[0];
    if (!file) continue;
    const download = await fetch(file.link);
    if (!download.ok) continue;
    const buffer = Buffer.from(await download.arrayBuffer());
    if (buffer.length < 50_000) continue;
    fs.writeFileSync(outPath, buffer);
    return true;
  }
  return false;
}

async function fetchPixabay(query: string, minDuration: number, outPath: string): Promise<boolean> {
  const key = getSettings().pixabayKey;
  if (!key) return false;

  const url = new URL("https://pixabay.com/api/videos/");
  url.searchParams.set("key", key);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", "5");
  url.searchParams.set("safesearch", "true");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json: any = await res.json();

  for (const hit of json.hits ?? []) {
    if ((hit.duration ?? 0) < Math.max(2, minDuration)) continue;
    const variant = hit.videos?.large?.url ? hit.videos.large : hit.videos?.medium;
    if (!variant?.url) continue;
    const download = await fetch(variant.url);
    if (!download.ok) continue;
    const buffer = Buffer.from(await download.arrayBuffer());
    if (buffer.length < 50_000) continue;
    fs.writeFileSync(outPath, buffer);
    return true;
  }
  return false;
}
