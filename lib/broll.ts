import fs from "fs";
import path from "path";
import { getSettings } from "./store";
import { planBrollSegments } from "./ai";
import { Word } from "./transcribe";

export type BrollClip = { start: number; end: number; file: string; query: string };

const MIN_LEN = 1.2; // сек
const MAX_LEN = 4.0;

/**
 * Готовит перебивки: ИИ (или эвристика) выбирает фразы, для каждой берётся ролик:
 * уже лежащий в проекте broll{k}.mp4 или скачанный со стока Pexels.
 * Без источников видео возвращает пустой список — монтаж идёт без перебивок.
 */
export async function prepareBroll(dir: string, words: Word[], topic: string): Promise<BrollClip[]> {
  if (words.length < 10) return [];

  // --- выбор фраз ---
  let plans = await planBrollSegments(words, topic).catch(() => null);
  if (!plans || !plans.length) plans = heuristicPlan(words);

  const clips: BrollClip[] = [];
  let k = 0;
  for (const plan of plans.slice(0, 4)) {
    const from = Math.max(0, Math.min(plan.from, words.length - 1));
    const to = Math.max(from, Math.min(plan.to, words.length - 1));
    let start = words[from].start;
    let end = Math.min(words[to].end + 0.15, start + MAX_LEN);
    if (end - start < MIN_LEN) end = start + MIN_LEN;
    // не пересекаться с предыдущей перебивкой
    const prev = clips[clips.length - 1];
    if (prev && start < prev.end + 0.8) continue;

    const file = `broll${k}.mp4`;
    const full = path.join(dir, file);
    let ok = fs.existsSync(full);
    if (!ok) {
      try {
        ok = await fetchStockVideo(plan.query, end - start, full);
      } catch (e) {
        console.warn(`Б-ролл «${plan.query}» не скачался:`, e);
      }
    }
    if (ok) {
      clips.push({ start, end, file, query: plan.query });
      k++;
    }
  }
  return clips;
}

/** Эвристика без ИИ: три окна по 3 слова на 25/50/75% ролика, запрос — сами слова. */
function heuristicPlan(words: Word[]): { from: number; to: number; query: string }[] {
  const spots = [0.25, 0.5, 0.75];
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

/** Ищет и скачивает вертикальный стоковый ролик с Pexels. */
export async function fetchStockVideo(query: string, minDuration: number, outPath: string): Promise<boolean> {
  const key = getSettings().pexelsKey;
  if (!key || !query.trim()) return false;

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
