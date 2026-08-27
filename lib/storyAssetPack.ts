import crypto from "crypto";
import fs from "fs";
import path from "path";
import { mediaComplete, parseJson, mediaLlmAvailable } from "./mediaLlm";
import { StoryResearchPack } from "./storyResearch";
import { ScriptBeat, MediaResearchNeed } from "./scriptBeats";
import { braveVideos, braveImages } from "./braveSearch";
import { analyzeAsset } from "./brollRelevance";
import { fetchVideo, extractorReady, probeVideo } from "./videoFetch";
import { verifySource } from "./storyAssets";
import { addCost } from "./pipelineCost";
import { probe, runFfmpeg } from "./ffmpeg";
import { taste } from "./montageTaste";

const rank = (i: string) => (i === "HIGH" ? 0 : i === "MEDIUM" ? 1 : 2);
/**
 * Потолок длительности исходника. Перебивки берутся из новостных сюжетов на
 * одну-пять минут; получасовое шоу и полный матч не влезают в лимит скачивания,
 * обрываются на середине и просто съедают время.
 */
const MAX_SOURCE_SEC = 600;
const domainOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
};

/**
 * Медиатека истории, версия 2: два слоя.
 *
 * CORE — один глубокий заход за настоящим видео события: если найден нормальный
 * сюжет на минуту-две, он режется на много самостоятельных сегментов и закрывает
 * заметную часть ролика. Это принципиально лучше, чем десять фотографий с разных
 * сайтов.
 * BEAT — точечный добор под те блоки сценария, которые CORE не закрыл. Запрос
 * при этом всегда знает и всю историю (событие, год, участники), и конкретный блок,
 * поэтому это не возврат к слепому поиску по фразе.
 */

export const PACK_VERSION = 2;

/** Счётчики по стадиям: видно, на каком шаге кандидаты исчезают. */
export type StageCounts = {
  videoResults: number;
  sourceVerifyPass: number;
  probeAttempted: number;
  probeOk: number;
  downloadAttempted: number;
  downloadOk: number;
  sourceVideosAccepted: number;
  framesSampled: number;
  segmentsExtracted: number;
  imageResults: number;
  imageVerifyPass: number;
  imagesAccepted: number;
  beforeBeatMatch: number;
  beatCompatible: number;
  /** сколько кандидатов дошло до шорт-листа на скачивание */
  shortlisted: number;
  /** отдельно по YouTube — площадка долго не работала, за ней нужен свой счёт */
  ytUrlsDiscovered: number;
  ytDownloadAttempted: number;
  ytDownloadOk: number;
  ytSourceVideosAccepted: number;
  ytSegments: number;
};
export const stages: StageCounts = {
  videoResults: 0, sourceVerifyPass: 0, probeAttempted: 0, probeOk: 0,
  downloadAttempted: 0, downloadOk: 0, sourceVideosAccepted: 0, framesSampled: 0,
  segmentsExtracted: 0, imageResults: 0, imageVerifyPass: 0, imagesAccepted: 0,
  beforeBeatMatch: 0, beatCompatible: 0, shortlisted: 0,
  ytUrlsDiscovered: 0, ytDownloadAttempted: 0, ytDownloadOk: 0,
  ytSourceVideosAccepted: 0, ytSegments: 0,
};

/** YouTube считаем отдельно: именно он раньше давал 45 находок и 0 скачиваний. */
export const isYoutube = (u: string) => /(^|\.)(youtube\.com|youtu\.be)$/i.test(domainOf(u));
export function resetStages(): void {
  for (const k of Object.keys(stages) as (keyof StageCounts)[]) stages[k] = 0;
}

export type AssetKind = "VIDEO_SEGMENT" | "IMAGE";

export type PackAsset = {
  id: string;
  kind: AssetKind;
  /** файл, готовый к монтажу (уже вырезанный сегмент или картинка) */
  file: string;
  sourceUrl: string;
  sourceDomain: string;
  sourceVideoId?: string;
  segment?: { start: number; end: number };
  description: string;
  role: "EVENT" | "PERSON" | "CONTEXT";
  compatibleBeatIds: string[];
  relatedFactIds: string[];
  verification: { sourceVerified: boolean; visualVerified: boolean; version: number };
};

export type BeatCoverage = {
  beatId: string;
  text: string;
  need: string;
  videos: number;
  images: number;
  covered: boolean;
};

export type StoryAssetPackV2 = {
  storyId: string;
  version: number;
  assets: PackAsset[];
  coverage: BeatCoverage[];
  coverageRatio: number;
  sourceVideos: { id: string; url: string; durationSec: number; segments: number; method?: string }[];
  stages?: StageCounts;
  createdAt: string;
};

const sid = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);

/** Запросы за ГЛАВНЫМ видео истории: событие целиком, разными формулировками. */
function coreVideoQueries(r: StoryResearchPack): string[] {
  const year = r.eventYear ? String(r.eventYear) : "";
  const person = r.entities.find((e) => e.type === "PERSON")?.name ?? "";
  const teams = r.entities.filter((e) => e.type === "TEAM").map((e) => e.name);
  const event = r.entities.find((e) => e.type === "EVENT")?.name ?? "";
  return [
    r.canonicalEvent,
    [person, "injury", year].filter(Boolean).join(" "),
    [person, teams[0], teams[1], year].filter(Boolean).join(" "),
    [person, event].filter(Boolean).join(" "),
    [teams[0], teams[1], event, "highlights"].filter(Boolean).join(" "),
    [person, "stretcher OR injured OR celebration", year].filter(Boolean).join(" "),
  ].filter((q) => q.trim().length > 6);
}

/**
 * Оценка кандидата ПО МЕТАДАННЫМ, до всякого скачивания.
 *
 * Смысл: находок обычно несколько десятков, а качать имеет смысл единицы.
 * Порядок выдачи Brave к сюжету отношения не имеет, поэтому сначала считаем,
 * насколько заголовок/описание/канал совпадают с историей, и грузим только верх списка.
 */
export function scoreCandidate(
  c: { title?: string; description?: string; publisher?: string; url: string; age?: string },
  r: StoryResearchPack,
): number {
  const hay = `${c.title ?? ""} ${c.description ?? ""} ${c.publisher ?? ""}`.toLowerCase();
  if (!hay.trim()) return 0;
  let score = 0;

  // участники истории — самый сильный признак
  for (const e of r.entities) {
    const names = [e.name, ...(e.aliases ?? [])].map((n) => n.toLowerCase()).filter((n) => n.length > 2);
    if (names.some((n) => hay.includes(n))) score += e.type === "PERSON" ? 3 : 2;
  }

  // слова канонического события
  const evWords = r.canonicalEvent
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3);
  const hits = evWords.filter((w) => hay.includes(w)).length;
  score += Math.min(4, hits);

  // год события в заголовке — сильный сигнал против «похожего, но другого» матча
  if (r.eventYear) {
    const y = String(r.eventYear);
    if (hay.includes(y)) score += 3;
    const otherYear = hay.match(/\b(19|20)\d{2}\b/g)?.some((m) => m !== y);
    if (otherYear && !hay.includes(y)) score -= 2;
  }

  // тип материала: нужен сюжет, а не разбор/подкаст/нарезка приколов
  if (/highlights?|full match|documentary|interview|analysis|reaction|podcast|compilation|top \d+/i.test(hay)) score -= 1;
  if (/news|report|moment|footage|clip|live/i.test(hay)) score += 1;

  return score;
}

/** Запрос под конкретный блок: контекст истории + что нужно показать. */
function beatQueries(r: StoryResearchPack, need: MediaResearchNeed): string[] {
  const year = r.eventYear ? String(r.eventYear) : "";
  const ents = need.entities.length ? need.entities.join(" ") : r.entities[0]?.name ?? "";
  const event = r.entities.find((e) => e.type === "EVENT")?.name ?? "";
  return [
    [ents, need.visualDescription].filter(Boolean).join(" ").slice(0, 120),
    [ents, need.visualDescription.split(" ").slice(0, 5).join(" "), year].filter(Boolean).join(" "),
    [need.visualDescription, event].filter(Boolean).join(" ").slice(0, 120),
  ].filter((q) => q.trim().length > 6);
}

/**
 * Режет исходное видео на самостоятельные сегменты: сэмплирует кадры, описывает
 * зрением и оставляет визуально разные моменты. Один сюжет даёт несколько вставок.
 */
async function cutSegments(
  file: string,
  dir: string,
  videoId: string,
  wanted: number,
): Promise<{ assets: Omit<PackAsset, "compatibleBeatIds" | "relatedFactIds" | "role">[]; duration: number }> {
  let duration = 0;
  try {
    duration = (await probe(file)).duration;
  } catch {
    return { assets: [], duration: 0 };
  }
  if (duration < 4) return { assets: [], duration };

  const samples = Math.min(wanted, Math.max(3, Math.floor(duration / 8)));
  const out: Omit<PackAsset, "compatibleBeatIds" | "relatedFactIds" | "role">[] = [];
  const seenDesc: string[] = [];
  const failures: string[] = [];

  for (let i = 0; i < samples; i++) {
    const at = ((i + 0.5) / samples) * Math.max(0, duration - 3);
    const frame = path.join(dir, `probe-${videoId}-${i}.jpg`);
    try {
      await runFfmpeg(
        ["-ss", at.toFixed(2), "-i", path.basename(file), "-frames:v", "1", "-q:v", "4", path.basename(frame)],
        { cwd: dir },
      );
      stages.framesSampled++;
      const an = await analyzeAsset(`seg:${videoId}:${i}`, "", fs.readFileSync(frame));
      addCost({ visionCalls: 1 });
      if (!an) throw new Error("зрение не описало кадр");
      if (an.isScreenshot || an.hasLargeWatermark) continue;
      // почти одинаковые кадры не плодим: сегменты должны отличаться
      if (seenDesc.some((d) => similar(d, an.description))) continue;
      seenDesc.push(an.description);

      const clip = path.join(dir, `seg-${videoId}-${i}.mp4`);
      await runFfmpeg(
        [
          "-ss", at.toFixed(2),
          "-i", path.basename(file),
          "-t", "3.2",
          "-an",
          "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
          "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast",
          path.basename(clip),
        ],
        { cwd: dir },
      );
      out.push({
        id: sid(`${videoId}:${i}`),
        kind: "VIDEO_SEGMENT",
        file: path.basename(clip),
        sourceUrl: "",
        sourceDomain: "",
        sourceVideoId: videoId,
        segment: { start: Number(at.toFixed(2)), end: Number((at + 3.2).toFixed(2)) },
        description: an.description,
        verification: { sourceVerified: true, visualVerified: true, version: PACK_VERSION },
      });
      stages.segmentsExtracted++;
    } catch (e: any) {
      // Отказ отдельного кадра — нормальная жизнь (битый кадр, неудачная нарезка).
      // А вот отказ ВСЕХ кадров означает сломанную стадию, и делать вид,
      // что материала просто нет, нельзя — это уже уничтожило готовые сегменты.
      failures.push(String(e?.message ?? e).slice(0, 120));
    } finally {
      try {
        fs.rmSync(frame, { force: true });
      } catch {}
    }
  }
  if (!out.length && failures.length === samples) {
    throw new Error(`Разбор исходного видео не выполнен ни на одном кадре: ${failures[0]}`);
  }
  return { assets: out, duration };
}

function similar(a: string, b: string): boolean {
  const A = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const B = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (!A.size || !B.size) return false;
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.min(A.size, B.size) > 0.75;
}

const MATCH_SYSTEM = `Ты — ассистент монтажёра. Тебе дают историю, список ВИЗУАЛЬНЫХ БЛОКОВ сценария
и список найденных материалов с описанием того, что на них видно.

Для каждого материала укажи, какие блоки он может закрыть, и его честную роль:
EVENT — видно само событие/действие истории;
PERSON — виден участник вне события;
CONTEXT — обстановка истории.

Материал, где другие команды, другие люди, другой инцидент или другой турнир, к истории
не относится — верни для него пустой compatibleBeatIds и role CONTEXT.
Не присваивай EVENT, если на кадре не происходит именно описанное в истории действие.

Ответь СТРОГО валидным JSON:
{"items":[{"id":"...","role":"EVENT","beatIds":["b1_ab"],"factIds":["f1"]}]}`;

/** Сопоставляет материалы с блоками сценария одним вызовом. */
async function matchToBeats(
  assets: PackAsset[],
  beats: ScriptBeat[],
  research: StoryResearchPack,
): Promise<PackAsset[]> {
  if (!assets.length) return assets;
  if (!mediaLlmAvailable()) {
    throw new Error("Сопоставление с блоками невозможно: нет доступного LLM-провайдера");
  }
  const beatList = beats
    .filter((b) => b.visualNeed !== "NONE")
    .map((b) => `[${b.id}] (${b.visualNeed}) ${b.text}`)
    .join("\n");
  const assetList = assets.map((a) => `id=${a.id} [${a.kind}] ${a.description.slice(0, 120)}`).join("\n");

  try {
    const raw = await mediaComplete({
      system: MATCH_SYSTEM,
      maxTokens: 6000,
      user:
        `История: ${research.canonicalEvent}\nУчастники: ${research.entities.map((e) => e.name).join(", ")}\n\n` +
        `Блоки сценария:\n${beatList}\n\nМатериалы:\n${assetList}`,
    });
    addCost({ researchLlmCalls: 1 });
    const json = parseJson<any>(raw, "Сопоставление с блоками");
    const byId = new Map<string, any>((Array.isArray(json.items) ? json.items : []).map((i: any) => [String(i.id), i]));
    const beatIds = new Set(beats.map((b) => b.id));
    const factIds = new Set(research.facts.map((f) => f.id));

    return assets.map((a) => {
      const info = byId.get(a.id);
      if (!info) return { ...a, compatibleBeatIds: [], role: "CONTEXT" as const };
      return {
        ...a,
        role: (["EVENT", "PERSON", "CONTEXT"] as const).includes(info.role) ? info.role : "CONTEXT",
        compatibleBeatIds: (Array.isArray(info.beatIds) ? info.beatIds.map(String) : []).filter((b: string) =>
          beatIds.has(b),
        ),
        relatedFactIds: (Array.isArray(info.factIds) ? info.factIds.map(String) : []).filter((f: string) =>
          factIds.has(f),
        ),
      };
    });
  } catch (e: any) {
    // Сбой сопоставления НЕЛЬЗЯ превращать в пустую медиатеку: однажды это уже
    // выбросило 9 готовых видео-сегментов и дало «0 ассетов» вместо явной ошибки.
    throw new Error(`Сопоставление с блоками не выполнено: ${String(e?.message ?? e).slice(0, 160)}`);
  }
}

/**
 * Собирает медиатеку под конкретный сценарий.
 * Сначала CORE (главное видео истории), потом BEAT (добор под незакрытые блоки).
 */
export async function buildAssetPack(
  research: StoryResearchPack,
  beats: ScriptBeat[],
  needs: MediaResearchNeed[],
  dir: string,
): Promise<StoryAssetPackV2> {
  const T0 = taste();
  const mediaDir = path.join(dir, "story-assets");
  fs.mkdirSync(mediaDir, { recursive: true });
  const assets: PackAsset[] = [];
  const sourceVideos: StoryAssetPackV2["sourceVideos"] = [];
  const seenVideo = new Set<string>();

  console.log(`Медиатека: экстрактор видео ${(await extractorReady()) ? "доступен" : "не установлен"}`);

  // ---------- CORE: главное видео истории ----------
  // Сперва собираем ВСЕХ кандидатов по всем запросам, потом ранжируем по метаданным
  // и качаем только верх списка. Качать всё подряд в порядке выдачи — трата времени:
  // из полусотни находок полезны единицы, и порядок Brave их не выделяет.
  const pool = new Map<string, { v: any; score: number }>();
  for (const q of coreVideoQueries(research)) {
    for (const v of await braveVideos(q)) {
      stages.videoResults++;
      if (isYoutube(v.url)) stages.ytUrlsDiscovered++;
      const vid = sid(v.url);
      if (pool.has(vid)) continue;
      const src = verifySource(
        { title: v.title, description: v.description, sourceUrl: v.url, publisher: v.publisher },
        research,
      );
      if (!src.ok) continue;
      stages.sourceVerifyPass++;
      pool.set(vid, { v, score: scoreCandidate(v, research) });
    }
  }

  const shortlist = [...pool.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, T0.core_download_shortlist);
  stages.shortlisted = shortlist.length;
  console.log(
    `CORE: кандидатов ${pool.size} → в шорт-лист ${shortlist.length} ` +
      `(лучший балл ${shortlist[0]?.[1].score ?? 0}, худший ${shortlist[shortlist.length - 1]?.[1].score ?? 0})`,
  );

  let coreSegments = 0;
  for (const [vid, { v, score }] of shortlist) {
    if (coreSegments >= 12) break;
    seenVideo.add(vid);
    const yt = isYoutube(v.url);

    // разведка: доступен ли поток и какой длины ролик — до скачивания
    if (!v.directUrl) {
      stages.probeAttempted++;
      const pr = await probeVideo(v.url);
      if (pr.ok) stages.probeOk++;
      console.log(
        `  [${score}] probe ${pr.platform} ${pr.ok ? `OK ${pr.durationSec ?? "?"}с (${pr.extractor})` : `— ${pr.reason}`}`,
      );
      if (!pr.ok) continue;
      // многочасовые трансляции и полные матчи для перебивок бесполезны
      if (pr.durationSec && pr.durationSec > MAX_SOURCE_SEC) {
        console.log(`  пропуск: длительность ${Math.round(pr.durationSec / 60)} мин — это не новостной сюжет`);
        continue;
      }
    }
    const raw = path.join(mediaDir, `src-${vid}.mp4`);
    stages.downloadAttempted++;
    if (yt) stages.ytDownloadAttempted++;
    const got = await fetchVideo(v.directUrl, v.url, raw);
    if (!got.ok) {
      console.log(`  скачивание ${v.url.slice(0, 55)} → ${got.reason}`);
      continue;
    }
    stages.downloadOk++;
    if (yt) stages.ytDownloadOk++;

    const cut = await cutSegments(raw, mediaDir, vid, 6);
    try {
      fs.rmSync(raw, { force: true });
    } catch {}
    if (!cut.assets.length) continue;
    stages.sourceVideosAccepted++;
    if (yt) {
      stages.ytSourceVideosAccepted++;
      stages.ytSegments += cut.assets.length;
    }
    sourceVideos.push({ id: vid, url: v.url, durationSec: cut.duration, segments: cut.assets.length, method: got.method });
    console.log(`  ПРИНЯТО ${domainOf(v.url)} ${cut.duration.toFixed(0)}с → ${cut.assets.length} сегментов`);
    for (const a of cut.assets) {
      assets.push({
        ...a,
        sourceUrl: v.url,
        sourceDomain: domainOf(v.url),
        compatibleBeatIds: [],
        relatedFactIds: [],
        role: "CONTEXT",
      });
    }
    coreSegments += cut.assets.length;
  }

  // ---------- BEAT: добор под блоки. VIDEO-FIRST: видео ищется раньше картинок ----------
  const T = taste();
  const ordered = [...needs].sort((a, b) => rank(a.importance) - rank(b.importance));
  const seenImage = new Set<string>();

  for (const need of ordered) {
    if (assets.length >= 30) break;
    const covered = () => assets.some((a) => a.compatibleBeatIds.includes(need.beatId));
    const queries = beatQueries(research, need);

    // 1) ВИДЕО под конкретный блок
    const videoBudget = need.importance === "HIGH" ? T.beat_video_queries : Math.max(1, T.beat_video_queries - 1);
    let gotVideo = false;
    for (const q of queries.slice(0, videoBudget)) {
      if (gotVideo || assets.length >= 30) break;
      for (const v of (await braveVideos(q)).slice(0, 6)) {
        if (gotVideo || assets.length >= 30) break;
        stages.videoResults++;
        if (isYoutube(v.url)) stages.ytUrlsDiscovered++;
        const vid = sid(v.url);
        if (seenVideo.has(vid)) continue;
        const src = verifySource({ title: v.title, description: v.description, sourceUrl: v.url, publisher: v.publisher }, research);
        if (!src.ok) continue;
        seenVideo.add(vid);

        stages.sourceVerifyPass++;
        if (!v.directUrl) {
          stages.probeAttempted++;
          const pr = await probeVideo(v.url);
          if (pr.ok) stages.probeOk++;
          if (!pr.ok) continue;
          if (pr.durationSec && pr.durationSec > MAX_SOURCE_SEC) continue;
        }
        const raw = path.join(mediaDir, `src-${vid}.mp4`);
        const ytB = isYoutube(v.url);
        stages.downloadAttempted++;
        if (ytB) stages.ytDownloadAttempted++;
        const got = await fetchVideo(v.directUrl, v.url, raw);
        if (!got.ok) continue;
        stages.downloadOk++;
        if (ytB) stages.ytDownloadOk++;
        const cut = await cutSegments(raw, mediaDir, vid, 4);
        try {
          fs.rmSync(raw, { force: true });
        } catch {}
        if (!cut.assets.length) continue;
        stages.sourceVideosAccepted++;
        if (ytB) {
          stages.ytSourceVideosAccepted++;
          stages.ytSegments += cut.assets.length;
        }
        console.log(`  ПРИНЯТО ${domainOf(v.url)} ${cut.duration.toFixed(0)}с → ${cut.assets.length} сегментов`);
        sourceVideos.push({ id: vid, url: v.url, durationSec: cut.duration, segments: cut.assets.length, method: got.method });
        for (const a of cut.assets) {
          assets.push({
            ...a,
            sourceUrl: v.url,
            sourceDomain: domainOf(v.url),
            compatibleBeatIds: [],
            relatedFactIds: [],
            role: "CONTEXT",
          });
        }
        gotVideo = true;
      }
    }

    // 2) ИЗОБРАЖЕНИЯ — только если видео под этот блок не нашлось
    if (gotVideo) continue;
    for (const q of queries.slice(0, T.beat_image_queries)) {
      for (const im of (await braveImages(q)).slice(0, 6)) {
        if (assets.length >= 30) break;
        stages.imageResults++;
        const key = im.imageUrl.split("?")[0];
        if (seenImage.has(key)) continue;
        const src = verifySource({ title: im.title, description: im.description, sourceUrl: im.url }, research);
        if (!src.ok) continue;
        stages.imageVerifyPass++;
        seenImage.add(key);

        const id = sid(key);
        const file = path.join(mediaDir, `img-${id}.jpg`);
        try {
          const res = await fetch(im.imageUrl, { headers: { "User-Agent": "Gudini/1.0" } });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 10_000) continue;
          const an = await analyzeAsset(`img:${id}`, "", buf);
          addCost({ visionCalls: 1 });
          if (!an || an.isScreenshot || an.hasLargeText || an.hasLargeWatermark) continue;
          fs.writeFileSync(file, buf);
          stages.imagesAccepted++;
          assets.push({
            id,
            kind: "IMAGE",
            file: path.basename(file),
            sourceUrl: im.url,
            sourceDomain: domainOf(im.url),
            description: an.description,
            role: "CONTEXT",
            compatibleBeatIds: [],
            relatedFactIds: [],
            verification: { sourceVerified: true, visualVerified: true, version: PACK_VERSION },
          });
        } catch {}
      }
    }
  }

  // ---------- сопоставление с блоками ----------
  stages.beforeBeatMatch = assets.length;
  const matched = await matchToBeats(assets, beats, research);
  const usable = matched.filter((a) => a.compatibleBeatIds.length);
  stages.beatCompatible = usable.length;
  if (assets.length > 0 && usable.length === 0) {
    throw new Error(
      `Медиатека собрала ${assets.length} материалов, но ни один не сопоставлен с блоками сценария. ` +
        "Это сбой сопоставления, а не отсутствие материала — пустой пакет не возвращаем.",
    );
  }
  console.log(`  сопоставление с блоками: ${assets.length} -> ${usable.length}`);

  const visual = beats.filter((b) => b.visualNeed !== "NONE");
  const coverage: BeatCoverage[] = visual.map((b) => {
    const fit = usable.filter((a) => a.compatibleBeatIds.includes(b.id));
    return {
      beatId: b.id,
      text: b.text.slice(0, 60),
      need: b.visualNeed,
      videos: fit.filter((a) => a.kind === "VIDEO_SEGMENT").length,
      images: fit.filter((a) => a.kind === "IMAGE").length,
      covered: fit.length > 0,
    };
  });
  const coverageRatio = visual.length ? Number((coverage.filter((c) => c.covered).length / visual.length).toFixed(2)) : 0;

  const pack: StoryAssetPackV2 = {
    storyId: research.storyId,
    version: PACK_VERSION,
    assets: usable,
    coverage,
    coverageRatio,
    sourceVideos,
    stages: { ...stages },
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(dir, "story-asset-pack.json"), JSON.stringify(pack, null, 2), "utf8");
  } catch {}
  return pack;
}
