import crypto from "crypto";
import fs from "fs";
import path from "path";
import { mediaComplete, parseJson, mediaLlmAvailable } from "./mediaLlm";
import { StoryResearchPack } from "./storyResearch";
import { ScriptBeat, MediaResearchNeed } from "./scriptBeats";
import { braveVideos, braveImages } from "./braveSearch";
import { analyzeAsset, analyzeFrames, qcReject } from "./brollRelevance";
import { fetchVideo, fetchVideoSections, extractorReady, probeVideo } from "./videoFetch";
import { verifySource } from "./storyAssets";
import { addCost } from "./pipelineCost";
import { probe, runFfmpeg } from "./ffmpeg";
import { taste } from "./montageTaste";
import { frameHash, groupScenes } from "./sceneHash";
import { CARD_FILTER, sourceBigEnough, GOOD_SOURCE } from "./topInset";
import { hasBlackBars } from "./blackBars";

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

/**
 * Версия формата медиатеки. 3 — только неподвижные картинки в единой геометрии
 * карточки: видео-сегменты, обрезанные под вертикаль, для нового стиля
 * непригодны, и пакет прошлой версии переиспользовать нельзя.
 */
export const PACK_VERSION = 3;

/**
 * Версия правил визуального контроля. Меняется, когда отбор материала становится
 * строже: тогда старый пакет действительно невалиден и пересборка оправдана.
 *
 * Профиль монтажа (темп, длительности, вкус) сюда НЕ входит: он влияет на то,
 * как материал расставлен, а не на то, годится ли он. Менять темп и заново
 * платить за поиск и зрение было бы бессмысленно.
 */
export const QC_RULES_VERSION = 3;

/**
 * Версия стратегии поиска и нарезки. Порядок «видео или фото сначала» определяет,
 * ЧТО окажется в пакете, а геометрия сегмента — пригоден ли он для верхней
 * вставки: сегменты, обрезанные под вертикаль, в ней выглядят узкой полоской.
 * Профиль монтажа сюда не входит: он влияет на расстановку, а не на пригодность.
 */
export const RETRIEVAL_VERSION = 4;

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
  /** сколько кадров отсеял визуальный контроль и по каким причинам */
  qcRejected: number;
  qcRejectedLargeText: number;
  qcRejectedReaction: number;
  qcRejectedExplainerSkit: number;
  qcRejectedOther: number;
  /** сегментов подрезано до чистой границы окна */
  segmentsTrimmed: number;
  /** источник о другом событии/турнире — отсев ещё до скачивания */
  wrongEventRejected: number;
};
export const stages: StageCounts = {
  videoResults: 0, sourceVerifyPass: 0, probeAttempted: 0, probeOk: 0,
  downloadAttempted: 0, downloadOk: 0, sourceVideosAccepted: 0, framesSampled: 0,
  segmentsExtracted: 0, imageResults: 0, imageVerifyPass: 0, imagesAccepted: 0,
  beforeBeatMatch: 0, beatCompatible: 0, shortlisted: 0,
  ytUrlsDiscovered: 0, ytDownloadAttempted: 0, ytDownloadOk: 0,
  ytSourceVideosAccepted: 0, ytSegments: 0,
  qcRejected: 0, qcRejectedLargeText: 0, qcRejectedReaction: 0,
  qcRejectedExplainerSkit: 0, qcRejectedOther: 0, segmentsTrimmed: 0, wrongEventRejected: 0,
};

/** Причины отсева копятся, чтобы в отчёте было видно не только «сколько», но и «почему». */
export const qcReasons: string[] = [];

/** Раскладывает причину отказа по классам мусора для отчёта. */
function countQcReason(reason: string): void {
  stages.qcRejected++;
  qcReasons.push(reason);
  if (/текст/.test(reason)) stages.qcRejectedLargeText++;
  else if (/реакц|призыв|интерфейс|заставка/.test(reason)) stages.qcRejectedReaction++;
  else if (/постановка|скетч|объяснялка/.test(reason)) stages.qcRejectedExplainerSkit++;
  else if (/полосы/.test(reason)) stages.qcRejectedOther++;
  else stages.qcRejectedOther++;
}

/** YouTube считаем отдельно: именно он раньше давал 45 находок и 0 скачиваний. */
export const isYoutube = (u: string) => /(^|\.)(youtube\.com|youtu\.be)$/i.test(domainOf(u));
export function resetStages(): void {
  for (const k of Object.keys(stages) as (keyof StageCounts)[]) stages[k] = 0;
  qcReasons.length = 0;
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
  /** номер визуальной сцены внутри исходника: почти одинаковые планы делят один номер */
  sceneId?: string;
  /** смысловая сцена: празднование, носилки, пресс-конференция — из разбора кадра */
  sceneFamily?: string;
  segment?: { start: number; end: number };
  /** реальный размер исходника до приведения к карточке — для контроля качества */
  sourceResolution?: string;
  description: string;
  role: "EVENT" | "PERSON" | "CONTEXT";
  compatibleBeatIds: string[];
  /** оценка совместимости с каждым блоком: 1 обстановка, 2 хорошо, 3 точно */
  beatScores?: Record<string, number>;
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
  /** лучшая оценка совместимости среди подошедших материалов: 3 точно, 2 хорошо, 1 обстановка */
  bestScore: number;
  /** идентификаторы лучших материалов — с ними и должен работать режиссёр */
  bestAssetIds: string[];
  /** сколько разных визуальных сцен доступно блоку: пять кадров одного плана — это одна */
  scenes: number;
};

export type StoryAssetPackV2 = {
  storyId: string;
  version: number;
  /** отпечаток входных данных: по нему видно, устарел ли пакет */
  fingerprint?: string;
  assets: PackAsset[];
  coverage: BeatCoverage[];
  /** доля блоков, у которых есть хоть какой-то материал (оценка >= 1) */
  coverageRatio: number;
  /** доля блоков с честным материалом (оценка >= 2) — она и важна для монтажа */
  hardCoverageRatio: number;
  /** сколько разных визуальных сцен в медиатеке: двадцать сегментов могут быть четырьмя планами */
  uniqueScenes: number;
  sourceVideos: { id: string; url: string; durationSec: number; segments: number; method?: string }[];
  stages?: StageCounts;
  createdAt: string;
};

const sid = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);

/**
 * Отпечаток входных данных медиатеки.
 *
 * Пересборка пакета стоит денег: это поиск, скачивание, зрение и сопоставление.
 * Платить второй раз имеет смысл, только если изменилось что-то, от чего пакет
 * зависит: сама история, её факты, блоки сценария или версия правил отбора.
 * Повторный рендер того же ролика новых расходов вызывать не должен.
 */
export function packFingerprint(
  research: StoryResearchPack,
  beats: ScriptBeat[],
  needs: MediaResearchNeed[] = [],
): string {
  const payload = JSON.stringify({
    // личность истории и её содержание
    story: research.storyId,
    event: research.canonicalEvent,
    year: research.eventYear ?? null,
    facts: research.facts.map((f) => f.id).sort(),
    entities: research.entities.map((e) => e.name).sort(),
    // блоки сценария и план медиа-исследования
    beats: beats.map((b) => `${b.id}:${b.visualNeed}`),
    // тип истории меняет правила отбора: пакет, собранный «как для новостей», пересобирается
    kind: research.kind ?? "NEWS_EVENT",
    needs: needs.map((n) => `${n.beatId}:${n.intent}:${n.preferredMedia}`).sort(),
    // версии проверок: их ужесточение делает уже собранный пакет невалидным
    verificationVersion: PACK_VERSION,
    qcRulesVersion: QC_RULES_VERSION,
    retrievalVersion: RETRIEVAL_VERSION,
  });
  return crypto.createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

/**
 * Готовый пакет для этих же входных данных, если он уже собран и оплачен.
 * Возвращает null, когда отпечаток не совпал — тогда пересборка оправдана.
 */
export function reusablePack(dir: string, fingerprint: string): StoryAssetPackV2 | null {
  try {
    const file = path.join(dir, "story-asset-pack.json");
    if (!fs.existsSync(file)) return null;
    const pack = JSON.parse(fs.readFileSync(file, "utf8")) as StoryAssetPackV2;
    if (pack.fingerprint !== fingerprint || pack.version !== PACK_VERSION) return null;
    // файлы материалов должны быть на месте, иначе пакет только на бумаге
    const media = path.join(dir, "story-assets");
    const alive = pack.assets.filter((a) => fs.existsSync(path.join(media, a.file)));
    if (alive.length !== pack.assets.length || !alive.length) return null;
    return pack;
  } catch {
    return null;
  }
}

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
  if ((r.kind ?? "NEWS_EVENT") !== "NEWS_EVENT") {
    // не новости: год и «событие» не помогают, помогает название темы и то, что в кадре
    const title = event || r.entities[0]?.name || r.topic;
    return [
      [need.visualDescription, title].filter(Boolean).join(" ").slice(0, 120),
      [title, ents !== title ? ents : "", need.visualDescription.split(" ").slice(0, 6).join(" ")].filter(Boolean).join(" ").slice(0, 120),
      [need.visualDescription, "official still poster"].join(" ").slice(0, 120),
    ].filter((q) => q.trim().length > 6);
  }
  return [
    [ents, need.visualDescription].filter(Boolean).join(" ").slice(0, 120),
    [ents, need.visualDescription.split(" ").slice(0, 5).join(" "), year].filter(Boolean).join(" "),
    [need.visualDescription, event].filter(Boolean).join(" ").slice(0, 120),
  ].filter((q) => q.trim().length > 6);
}

/** Длина окна сегмента и точки его проверки: начало, четверти, конец. */
export const SEGMENT_WINDOW = 3.2;
/** Ширина кадра, отправляемого на контроль качества. Классификации хватает. */
export const QC_FRAME_WIDTH = 384;
export const WINDOW_OFFSETS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Короче полутора секунд вставка бессмысленна. */
export const MIN_CLEAN_SEC = 1.5;

export type WindowDecision = {
  decision: "PASS" | "TRIM" | "REJECT";
  /** сколько секунд окна признано чистыми */
  usableSec: number;
  /** какая точка испортила окно (индекс в WINDOW_OFFSETS), -1 если все чистые */
  firstBadIndex: number;
  reason: string;
  /** исход по каждой точке окна — без пропусков */
  points: { offsetFrac: number; atSec: number; verdict: string | null }[];
};

/**
 * Решение по ВСЕМУ окну сегмента, а не по одному кадру.
 *
 * Проверка единственной «представительной» точки признавала чистыми три секунды,
 * внутри которых могла быть чужая финальная карточка с «SUBSCRIBE» — так она и
 * попала в готовый ролик. Здесь известен исход каждой точки окна: грязь в хвосте
 * позволяет подрезать окно до чистой границы, грязь в начале или середине —
 * повод отказаться от сегмента целиком.
 */
export function segmentWindowDecision(
  analyses: (import("./brollRelevance").AssetAnalysis | null)[],
  windowSec = SEGMENT_WINDOW,
  staged = false,
): WindowDecision {
  const points = WINDOW_OFFSETS.map((frac, i) => ({
    offsetFrac: frac,
    atSec: Number((windowSec * frac).toFixed(2)),
    verdict: analyses[i] ? qcReject(analyses[i]!, { factualBeat: true, staged }) : "кадр не описан",
  }));

  let cleanParts = 0;
  while (cleanParts < points.length && points[cleanParts].verdict === null) cleanParts++;
  const firstBadIndex = points.findIndex((p) => p.verdict !== null);

  if (cleanParts === 0) {
    return {
      decision: "REJECT",
      usableSec: 0,
      firstBadIndex,
      reason: String(points[0].verdict),
      points,
    };
  }
  if (firstBadIndex < 0) {
    return { decision: "PASS", usableSec: windowSec, firstBadIndex: -1, reason: "всё окно чистое", points };
  }

  const usableSec = Number((windowSec * WINDOW_OFFSETS[cleanParts - 1]).toFixed(2));
  if (usableSec < MIN_CLEAN_SEC) {
    return {
      decision: "REJECT",
      usableSec,
      firstBadIndex,
      reason: `${points[firstBadIndex].verdict} на ${points[firstBadIndex].atSec}с — чистыми остаются только ${usableSec}с`,
      points,
    };
  }
  return {
    decision: "TRIM",
    usableSec,
    firstBadIndex,
    reason: `${points[firstBadIndex].verdict} на ${points[firstBadIndex].atSec}с — окно подрезано до ${usableSec}с`,
    points,
  };
}

/**
 * Выбор стоп-кадра ПОД СМЫСЛ, а не «первый чистый в окне».
 *
 * Кадры одного окна описаны все; равномерная сетка попадает куда попало — под
 * «спорит с судьёй» уходил мяч в сетке. Здесь среди чистых кадров окна берётся
 * тот, чьё описание сильнее всего пересекается с тем, что ищут блоки сценария.
 * Считается по словам, локально, бесплатно.
 */
const stop = new Set(["with","from","that","this","they","their","there","near","into","onto","over","under","while","after","before","during","being","some","other","another","which","have","has","are","were","been"]);
const tokens = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !stop.has(w));

export function pickFrameForNeeds<T extends { description: string }>(
  frames: (T | null)[],
  needs: { visualDescription: string }[],
): { index: number; score: number } {
  let best = { index: frames.findIndex((f) => f !== null), score: 0 };
  if (!needs.length) return best;
  const needTokens = needs.map((n) => new Set(tokens(n.visualDescription)));
  frames.forEach((f, i) => {
    if (!f) return;
    const desc = tokens(f.description);
    let score = 0;
    for (const nt of needTokens) {
      const hit = desc.filter((w) => nt.has(w)).length;
      score = Math.max(score, hit);
    }
    if (score > best.score) best = { index: i, score };
  });
  return best;
}

/**
 * Режет исходное видео на самостоятельные сегменты: сэмплирует кадры, описывает
 * зрением и оставляет визуально разные моменты. Один сюжет даёт несколько вставок.
 */
export type SectionSource = { duration: number; sections: { index: number; start: number; file: string }[] };

/**
 * Окна для стоп-кадров: одна формула и для целого файла, и для скачивания
 * кусками — индексы кадров в кэше зрения (seg:{video}:{i}) совпадают.
 */
export function planWindows(duration: number, wanted: number): { samples: number; windows: { index: number; at: number }[] } {
  const samples = Math.min(wanted, Math.max(3, Math.floor(duration / 8)));
  const windows = Array.from({ length: samples }, (_, i) => ({ index: i, at: ((i + 0.5) / samples) * Math.max(0, duration - SEGMENT_WINDOW) }));
  return { samples, windows };
}

export async function cutSegments(
  source: string | SectionSource,
  dir: string,
  videoId: string,
  wanted: number,
  needs: MediaResearchNeed[] = [],
  staged = false,
): Promise<{ assets: Omit<PackAsset, "compatibleBeatIds" | "relatedFactIds" | "role">[]; duration: number }> {
  let duration = 0;
  if (typeof source === "string") {
    try {
      duration = (await probe(source)).duration;
    } catch {
      return { assets: [], duration: 0 };
    }
  } else {
    duration = source.duration;
  }
  if (duration < 4) return { assets: [], duration };
  // Откуда брать кадр момента t окна i: из целого файла — как есть; из куска —
  // по локальному времени (кусок начинается ровно с начала окна).
  const frameSrc = (t: number, i: number): { file: string; t: number } => {
    if (typeof source === "string") return { file: source, t };
    const sec = source.sections.find((x) => x.index === i);
    if (!sec) throw new Error(`окно ${i} не скачано`);
    return { file: sec.file, t: Math.max(0, t - sec.start) };
  };

  const { samples, windows } = planWindows(duration, wanted);
  const out: Omit<PackAsset, "compatibleBeatIds" | "relatedFactIds" | "role">[] = [];
  const seenDesc: string[] = [];
  const failures: string[] = [];
  let trimmedSegments = 0;

  // 1) Снимаем кадры ПО ВСЕМУ окну будущего сегмента, а не одну «представительную»
  // точку. Проверка одного кадра признавала чистыми три секунды, внутри которых
  // могла быть чужая финальная карточка с «SUBSCRIBE» — так она и попала в ролик.
  const WINDOW = SEGMENT_WINDOW;
  const OFFSETS = WINDOW_OFFSETS;
  const shots: { at: number; frame: string; buffer: Buffer; hash: bigint | null; sample: number; part: number }[] = [];
  for (const { index: i, at } of windows) {
    for (const [p, frac] of OFFSETS.entries()) {
      const t = Math.min(at + WINDOW * frac, Math.max(0, duration - 0.05));
      const src = frameSrc(t, i);
      const frame = path.join(dir, `probe-${videoId}-${i}-${p}.jpg`);
      try {
        // Кадр для контроля качества нужен модели только чтобы понять, что на нём.
        // Полное разрешение здесь — деньги на ветер: токенов в разы больше, а
        // «SUBSCRIBE» и заставка одинаково видны на уменьшенной копии.
        await runFfmpeg(
          [
            "-ss", src.t.toFixed(2), "-i", path.basename(src.file), "-frames:v", "1",
            "-vf", `scale=${QC_FRAME_WIDTH}:-2`, "-q:v", "6", path.basename(frame),
          ],
          { cwd: dir },
        );
        stages.framesSampled++;
        shots.push({ at, frame, buffer: fs.readFileSync(frame), hash: await frameHash(frame, dir), sample: i, part: p });
      } catch (e: any) {
        failures.push(String(e?.message ?? e).slice(0, 120));
      }
    }
  }

  // 2) один запрос на всё видео вместо запроса на каждый кадр
  let analyses: (Awaited<ReturnType<typeof analyzeFrames>>[number])[] = [];
  try {
    analyses = await analyzeFrames(`seg:${videoId}`, shots.map((x) => x.buffer));
    addCost({ visionCalls: 1 });
  } catch (e: any) {
    for (const x of shots) {
      try {
        fs.rmSync(x.frame, { force: true });
      } catch {}
    }
    throw new Error(`Разбор кадров не выполнен: ${String(e?.message ?? e).slice(0, 120)}`);
  }

  // 3) почти одинаковые планы получают один номер сцены — это считается локально
  const sceneOf = groupScenes(shots.map((x) => x.hash));

  // 4) РЕШЕНИЕ ПО ОКНУ ЦЕЛИКОМ, а не по одному кадру.
  // Для каждого окна известно, какие его части чистые. Если грязная только
  // хвостовая часть — окно подрезается до чистой границы; если грязь в начале
  // или в середине — сегмент не берём вовсе.
  const MIN_CLEAN = 1.5;
  for (let i = 0; i < samples; i++) {
    const parts = shots
      .map((sh, idx) => ({ sh, an: analyses[idx] }))
      .filter((x) => x.sh.sample === i)
      .sort((a, b) => a.sh.part - b.sh.part);
    if (!parts.length) continue;

    const at = parts[0].sh.at;
    const decision = segmentWindowDecision(parts.map((x) => x.an ?? null), WINDOW, staged);
    if (decision.decision === "REJECT") {
      countQcReason(decision.reason);
      continue;
    }
    const segLen = decision.usableSec;
    if (decision.decision === "TRIM") {
      trimmedSegments++;
      stages.segmentsTrimmed++;
    }

    // среди чистых частей окна выбираем кадр под смысл блоков, а не первый попавшийся
    const cleanParts = parts.slice(0, decision.firstBadIndex < 0 ? parts.length : decision.firstBadIndex);
    const choice = pickFrameForNeeds(cleanParts.map((x) => x.an ?? null), needs);
    const chosen = cleanParts[Math.max(0, choice.index)] ?? parts[0];
    const an = chosen.an!;
    const frameAt = at + WINDOW * OFFSETS[chosen.sh.part];
    // почти одинаковые кадры не плодим: сегменты должны отличаться
    if (seenDesc.some((d) => similar(d, an.description))) continue;
    seenDesc.push(an.description);

    // Верхняя карточка — только неподвижная картинка. Из проверенного исходника
    // берётся чистый стоп-кадр в максимальном качестве и сразу приводится к
    // единой геометрии карточки. Никаких вертикальных обрезок: раньше сегменты
    // резались под 1080×1920, и в карточке они выглядели узкой полоской.
    const still = path.join(dir, `still-${videoId}-${i}.jpg`);
    try {
      const src = frameSrc(frameAt, i);
      const sourceInfo = await probe(src.file);
      if (!sourceBigEnough(sourceInfo.width, sourceInfo.height)) {
        countQcReason(`исходник ${sourceInfo.width}×${sourceInfo.height} меньше карточки`);
        continue;
      }
      await runFfmpeg(
        ["-ss", src.t.toFixed(2), "-i", path.basename(src.file), "-frames:v", "1", "-vf", CARD_FILTER, "-q:v", "2", path.basename(still)],
        { cwd: dir },
      );
      // чёрные полосы внутри кадра обрезкой не лечатся — такой стоп-кадр не берём
      if (await hasBlackBars(still, dir)) {
        countQcReason("чёрные полосы внутри кадра");
        fs.rmSync(still, { force: true });
        continue;
      }
      out.push({
        id: sid(`${videoId}:${i}`),
        kind: "IMAGE",
        file: path.basename(still),
        sourceUrl: "",
        sourceDomain: "",
        sourceVideoId: videoId,
        sceneId: `${videoId}-s${sceneOf[shots.indexOf(parts[0].sh)]}`,
        sceneFamily: an.sceneFamily,
        segment: { start: Number(frameAt.toFixed(2)), end: Number((frameAt + 0.04).toFixed(2)) },
        sourceResolution: `${sourceInfo.width}×${sourceInfo.height}`,
        description: an.description,
        verification: { sourceVerified: true, visualVerified: true, version: PACK_VERSION },
      });
      stages.segmentsExtracted++;
    } catch (e: any) {
      failures.push(String(e?.message ?? e).slice(0, 120));
    }
  }
  for (const sh of shots) {
    try {
      fs.rmSync(sh.frame, { force: true });
    } catch {}
  }

  if (!out.length && failures.length >= samples) {
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

const MATCH_SYSTEM = `Ты — ассистент монтажёра. Тебе дают историю, пронумерованные ВИЗУАЛЬНЫЕ БЛОКИ
сценария и пронумерованные МАТЕРИАЛЫ с описанием того, что на них видно.

Построй МАТРИЦУ совместимости: для каждой пары «блок × материал» дай оценку

3 — на кадре именно то, о чём говорит блок;
2 — кадр хорошо иллюстрирует смысл блока, пусть и не буквально;
1 — кадр годится как обстановка, прямой связи нет;
0 — не подходит.

Оценивай ПО СМЫСЛУ, а не по совпадению слов. Блок «после финального свистка все бегут
праздновать» и материал «England players celebrating near the sideline» — это оценка 3,
хотя слов «final whistle» в описании нет.

Один материал может подходить НЕСКОЛЬКИМ блокам — так и укажи, не выбирай один.
Материал не «занимается» блоком навсегда: расстановкой займётся режиссёр.

ВАЖНО О ПРОИСХОЖДЕНИИ: все материалы уже прошли проверку источника — они относятся
ИМЕННО К ЭТОЙ истории. Для новостного события кадр стадиона, трибун, скамейки или
команды — это обстановка ЭТОГО матча, а не случайный сток; для фильма постер,
кадр из трейлера или промо-фото актёра — это материал самого фильма. Поэтому для
блока CONTEXT такой кадр — оценка 2 или 3, а не 1.
Для блока ENTITY портрет или крупный план названного участника — оценка 3.

Ставь 0, если на кадре другая команда, другие люди, другой инцидент или другой турнир.
Оценку 3 для EXACT_EVENT не ставь, если на кадре не происходит именно описанное действие.

Для каждого материала укажи честную роль:
EVENT — видно само событие истории;
PERSON — виден участник вне события;
CONTEXT — обстановка.

Отвечай компактно и СТРОГО валидным JSON. Пары с оценкой 0 не перечисляй:
{"items":[{"a":1,"role":"EVENT","factIds":["f1"],"scores":{"3":3,"7":2}}]}
где ключ "a" — номер материала, ключи внутри scores — номера блоков.`;

/** Сопоставляет материалы с блоками сценария одним вызовом. */
export async function matchToBeats(
  assets: PackAsset[],
  beats: ScriptBeat[],
  research: StoryResearchPack,
): Promise<PackAsset[]> {
  if (!assets.length) return assets;
  if (!mediaLlmAvailable()) {
    throw new Error("Сопоставление с блоками невозможно: нет доступного LLM-провайдера");
  }
  // нумерация вместо длинных идентификаторов: короче запрос и меньше шансов на опечатку
  const visualBeats = beats.filter((b) => b.visualNeed !== "NONE");
  // Участники блока показываются явно: хук «первый футболист, который не провёл на
  // поле ни секунды» не называет героя по имени, и без этого портрет героя получал 0.
  const beatList = visualBeats
    .map((b, i) => `${i + 1}. (${b.visualNeed}${b.entities.length ? ": " + b.entities.join(", ") : ""}) ${b.text}`)
    .join("\n");
  const assetList = assets
    .map((a, i) => `${i + 1}. [${a.kind === "VIDEO_SEGMENT" ? "видео" : "фото"}] ${a.description.slice(0, 130)}`)
    .join("\n");

  try {
    const raw = await mediaComplete({
      system: MATCH_SYSTEM,
      maxTokens: 8000,
      stage: "Beat Matching",
      user:
        `История: ${research.canonicalEvent}\nУчастники: ${research.entities.map((e) => e.name).join(", ")}\n\n` +
        `Блоки сценария:\n${beatList}\n\nМатериалы:\n${assetList}`,
    });
    addCost({ researchLlmCalls: 1 });
    const json = parseJson<any>(raw, "Сопоставление с блоками");
    const factIds = new Set(research.facts.map((f) => f.id));
    const byIndex = new Map<number, any>(
      (Array.isArray(json.items) ? json.items : []).map((i: any) => [Number(i.a), i]),
    );

    return assets.map((a, i) => {
      const info = byIndex.get(i + 1);
      if (!info) return { ...a, compatibleBeatIds: [], beatScores: {}, role: "CONTEXT" as const };

      // оценки превращаются в идентификаторы блоков ЗДЕСЬ, детерминированным кодом
      const beatScores: Record<string, number> = {};
      for (const [k, v] of Object.entries(info.scores ?? {})) {
        const beat = visualBeats[Number(k) - 1];
        const score = Number(v);
        if (!beat || !Number.isFinite(score) || score <= 0) continue;
        beatScores[beat.id] = Math.min(3, Math.max(1, Math.round(score)));
      }
      return {
        ...a,
        role: (["EVENT", "PERSON", "CONTEXT"] as const).includes(info.role) ? info.role : "CONTEXT",
        beatScores,
        compatibleBeatIds: Object.keys(beatScores),
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
/** Покрытие блоков по сопоставленным материалам. Отдельно, чтобы пересчитывать без пересборки. */
export function computeCoverage(
  usable: PackAsset[],
  beats: ScriptBeat[],
): { coverage: BeatCoverage[]; coverageRatio: number; hardCoverageRatio: number; uniqueScenes: number } {
  const visual = beats.filter((b) => b.visualNeed !== "NONE");
  const coverage: BeatCoverage[] = visual.map((b) => {
    const fit = usable.filter((a) => a.compatibleBeatIds.includes(b.id));
    const scoreOf = (a: PackAsset) => a.beatScores?.[b.id] ?? 1;
    const bestScore = fit.reduce((m, a) => Math.max(m, scoreOf(a)), 0);
    return {
      beatId: b.id,
      text: b.text.slice(0, 60),
      need: b.visualNeed,
      videos: fit.filter((a) => a.kind === "VIDEO_SEGMENT").length,
      images: fit.filter((a) => a.kind === "IMAGE").length,
      covered: fit.length > 0,
      bestScore,
      // лучшие материалы: видео впереди фото при равной оценке
      bestAssetIds: fit
        .filter((a) => scoreOf(a) === bestScore)
        .sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "VIDEO_SEGMENT" ? -1 : 1))
        .slice(0, 4)
        .map((a) => a.id),
      scenes: new Set(fit.map((a) => a.sceneId ?? a.id)).size,
    };
  });
  const denom = Math.max(1, visual.length);
  // мягкое покрытие — «хоть что-то есть», жёсткое — «есть честный материал»
  const coverageRatio = visual.length ? Number((coverage.filter((c) => c.bestScore >= 1).length / denom).toFixed(2)) : 0;
  const hardCoverageRatio = visual.length
    ? Number((coverage.filter((c) => c.bestScore >= 2).length / denom).toFixed(2))
    : 0;
  const uniqueScenes = new Set(usable.map((a) => a.sceneId ?? a.id)).size;
  return { coverage, coverageRatio, hardCoverageRatio, uniqueScenes };
}

export async function buildAssetPack(
  research: StoryResearchPack,
  beats: ScriptBeat[],
  needs: MediaResearchNeed[],
  dir: string,
): Promise<StoryAssetPackV2> {
  const T0 = taste();
  const fingerprint = packFingerprint(research, beats, needs);
  const existing = reusablePack(dir, fingerprint);
  if (existing) {
    console.log(
      `Медиатека уже собрана для этих данных (отпечаток ${fingerprint}): ` +
        `${existing.assets.length} материалов. Повторная сборка не нужна и не оплачивается.`,
    );
    return existing;
  }
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
      if (!src.ok) {
        if (src.reasons.some((r) => /соревновании|год не совпадает/.test(r))) stages.wrongEventRejected++;
        continue;
      }
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

  /** Сколько видео обрабатывается одновременно: загрузка и зрение — ожидание сети, не процессор. */
  const PARALLEL = 3;
  /** не новости: постеры, титульные карточки и снятые сцены — материал, а не подделка */
  const staged = (research.kind ?? "NEWS_EVENT") !== "NEWS_EVENT";
  if (staged) console.log(`  тип истории: ${research.kind} — постеры и кадры из фильма допускаются, проверка источников по теме`);
  type VideoCand = { url: string; directUrl?: string };
  /**
   * Получить стоп-кадры из ролика: скачиваются только окна (--download-sections),
   * а не весь файл; если куски не отдались — целиком, как раньше. Временные файлы
   * удаляются в любом случае.
   */
  const acquire = async (
    vid: string,
    v: VideoCand,
    durationSec: number | undefined,
    wanted: number,
  ): Promise<{ cut: Awaited<ReturnType<typeof cutSegments>>; method: string } | { error: string }> => {
    const prefix = path.join(mediaDir, `src-${vid}`);
    const yt = isYoutube(v.url);
    stages.downloadAttempted++;
    if (yt) stages.ytDownloadAttempted++;
    if (!v.directUrl && durationSec && durationSec >= 4) {
      const { windows } = planWindows(durationSec, wanted);
      const got = await fetchVideoSections(
        v.url,
        windows.map((w) => ({ index: w.index, start: w.at, end: Math.min(durationSec, w.at + SEGMENT_WINDOW + 0.3) })),
        prefix,
      );
      if (got.ok) {
        stages.downloadOk++;
        if (yt) stages.ytDownloadOk++;
        try {
          const cut = await cutSegments(
            { duration: durationSec, sections: got.files.map((f) => ({ index: f.index, start: f.start, file: f.file })) },
            mediaDir,
            vid,
            wanted,
            needs,
            staged,
          );
          return { cut, method: got.method };
        } finally {
          for (const f of got.files) {
            try {
              fs.rmSync(f.file, { force: true });
            } catch {}
          }
        }
      }
      console.log(`  окна не скачались (${got.reason}) — качаю целиком`);
    }
    const raw = `${prefix}.mp4`;
    const got = await fetchVideo(v.directUrl, v.url, raw);
    if (!got.ok) return { error: got.reason ?? "не скачалось" };
    stages.downloadOk++;
    if (yt) stages.ytDownloadOk++;
    try {
      const cut = await cutSegments(raw, mediaDir, vid, wanted, needs, staged);
      return { cut, method: got.method ?? "extractor" };
    } finally {
      try {
        fs.rmSync(raw, { force: true });
      } catch {}
    }
  };

  let coreSegments = 0;
  const coreOne = async (vid: string, v: VideoCand, score: number) => {
    seenVideo.add(vid);
    let durationSec: number | undefined;

    // разведка: доступен ли поток и какой длины ролик — до скачивания
    if (!v.directUrl) {
      stages.probeAttempted++;
      const pr = await probeVideo(v.url);
      if (pr.ok) stages.probeOk++;
      console.log(
        `  [${score}] probe ${pr.platform} ${pr.ok ? `OK ${pr.durationSec ?? "?"}с (${pr.extractor})` : `— ${pr.reason}`}`,
      );
      if (!pr.ok) return null;
      // многочасовые трансляции и полные матчи для перебивок бесполезны
      if (pr.durationSec && pr.durationSec > MAX_SOURCE_SEC) {
        console.log(`  пропуск: длительность ${Math.round(pr.durationSec / 60)} мин — слишком длинно для перебивок`);
        return null;
      }
      durationSec = pr.durationSec;
    }
    const r = await acquire(vid, v, durationSec, T0.segments_per_source_video);
    if ("error" in r) {
      console.log(`  скачивание ${v.url.slice(0, 55)} → ${r.error}`);
      return null;
    }
    return { vid, v, cut: r.cut, method: r.method };
  };
  // Партиями по PARALLEL, в порядке шорт-листа; результаты применяются по порядку,
  // чтобы состав медиатеки не зависел от того, чья загрузка закончилась раньше.
  const shortlistEntries = [...shortlist];
  for (let b = 0; b < shortlistEntries.length && coreSegments < 12; b += PARALLEL) {
    const batch = shortlistEntries.slice(b, b + PARALLEL);
    const results = await Promise.all(
      batch.map(([vid, { v, score }]) =>
        coreOne(vid, v, score).catch((e) => {
          console.log(`  ${domainOf(v.url)}: ${String(e?.message ?? e).slice(0, 100)}`);
          return null;
        }),
      ),
    );
    for (const r of results) {
      if (!r || !r.cut.assets.length || coreSegments >= 12) continue;
      const { vid, v, cut, method } = r;
      const yt = isYoutube(v.url);
      stages.sourceVideosAccepted++;
      if (yt) {
        stages.ytSourceVideosAccepted++;
        stages.ytSegments += cut.assets.length;
      }
      sourceVideos.push({ id: vid, url: v.url, durationSec: cut.duration, segments: cut.assets.length, method });
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
  }

  // ---------- BEAT: добор под блоки. VIDEO-FIRST: видео ищется раньше картинок ----------
  const T = taste();
  const ordered = [...needs].sort((a, b) => rank(a.importance) - rank(b.importance));
  const seenImage = new Set<string>();

  const processNeed = async (need: MediaResearchNeed): Promise<void> => {
    if (assets.length >= T.max_total_assets) return;
    const covered = () => assets.some((a) => a.compatibleBeatIds.includes(need.beatId));
    const queries = beatQueries(research, need);

    // Порядок поиска задаёт сам блок сценария. Для человека, портрета или
    // статичного факта хорошее проверенное фото лучше, чем целый видеосюжет:
    // качать ролик ради неподвижного кадра незачем. Для реального действия
    // наоборот — нужна съёмка.
    const imageFirst = need.preferredMedia === "IMAGE";
    // Совместимость с блоками проставляется позже, поэтому «закрыт ли блок»
    // здесь определяется тем, что нашли под него прямо сейчас.
    let gotVideo = false;
    let gotImage = false;

    const searchVideo = async (): Promise<void> => {
      const videoBudget = need.importance === "HIGH" ? T.beat_video_queries : Math.max(1, T.beat_video_queries - 1);
      for (const q of queries.slice(0, videoBudget)) {
        if (gotVideo || assets.length >= T.max_total_assets) break;
        for (const v of (await braveVideos(q)).slice(0, 6)) {
          if (gotVideo || assets.length >= T.max_total_assets) break;
          stages.videoResults++;
          if (isYoutube(v.url)) stages.ytUrlsDiscovered++;
          const vid = sid(v.url);
          if (seenVideo.has(vid)) continue;
          const src = verifySource({ title: v.title, description: v.description, sourceUrl: v.url, publisher: v.publisher }, research);
          if (!src.ok) {
            if (src.reasons.some((r) => /соревновании|год не совпадает/.test(r))) stages.wrongEventRejected++;
            continue;
          }
          seenVideo.add(vid);

          stages.sourceVerifyPass++;
          let durationSec: number | undefined;
          if (!v.directUrl) {
            stages.probeAttempted++;
            const pr = await probeVideo(v.url);
            if (pr.ok) stages.probeOk++;
            if (!pr.ok) continue;
            if (pr.durationSec && pr.durationSec > MAX_SOURCE_SEC) continue;
            durationSec = pr.durationSec;
          }
          const ytB = isYoutube(v.url);
          const r = await acquire(vid, v, durationSec, 4);
          if ("error" in r) continue;
          const { cut, method } = r;
          if (!cut.assets.length) continue;
          stages.sourceVideosAccepted++;
          if (ytB) {
            stages.ytSourceVideosAccepted++;
            stages.ytSegments += cut.assets.length;
          }
          console.log(`  ПРИНЯТО ${domainOf(v.url)} ${cut.duration.toFixed(0)}с → ${cut.assets.length} сегментов`);
          sourceVideos.push({ id: vid, url: v.url, durationSec: cut.duration, segments: cut.assets.length, method });
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

    };

    const searchImages = async (): Promise<void> => {
      // Если блок уже закрыт видео и фото ему не предпочтительнее — картинки не ищем.
      if (gotVideo && !imageFirst) return;
      for (const q of queries.slice(0, T.beat_image_queries)) {
        for (const im of (await braveImages(q)).slice(0, 6)) {
          if (assets.length >= T.max_total_assets) break;
          stages.imageResults++;
          const key = im.imageUrl.split("?")[0];
          if (seenImage.has(key)) continue;
          const src = verifySource({ title: im.title, description: im.description, sourceUrl: im.url }, research);
          if (!src.ok) {
            if (src.reasons.some((r) => /соревновании|год не совпадает/.test(r))) stages.wrongEventRejected++;
            continue;
          }
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
            if (!an) continue;
            // блок излагает факт — постановке и объяснялке здесь не место
            const bad = qcReject(an, { factualBeat: need.intent === "EXACT_EVENT" || need.intent === "ENTITY", staged });
            if (bad) {
              countQcReason(bad);
              continue;
            }
            // Реальный размер файла проверяется ПОСЛЕ скачивания: миниатюра
            // выглядит картинкой, но на карточке 900×506 превращается в мыло.
            const rawFile = file.replace(/\.jpg$/, ".src.jpg");
            fs.writeFileSync(rawFile, buf);
            let dims = { width: 0, height: 0 };
            try {
              dims = await probe(rawFile);
            } catch {}
            if (!sourceBigEnough(dims.width, dims.height)) {
              countQcReason(`изображение ${dims.width}×${dims.height} меньше карточки`);
              fs.rmSync(rawFile, { force: true });
              continue;
            }
            // единая геометрия карточки — та же, что у стоп-кадров и у рендера
            await runFfmpeg(["-i", rawFile, "-frames:v", "1", "-vf", CARD_FILTER, "-q:v", "2", file]);
            fs.rmSync(rawFile, { force: true });
            if (await hasBlackBars(file, mediaDir)) {
              countQcReason("чёрные полосы внутри кадра");
              fs.rmSync(file, { force: true });
              continue;
            }
            stages.imagesAccepted++;
            gotImage = true;
            assets.push({
              id,
              kind: "IMAGE",
              file: path.basename(file),
              sourceUrl: im.url,
              sourceDomain: domainOf(im.url),
              sourceResolution: `${dims.width}×${dims.height}`,
              description: an.description,
              role: "CONTEXT",
              compatibleBeatIds: [],
              relatedFactIds: [],
              verification: { sourceVerified: true, visualVerified: true, version: PACK_VERSION },
            });
          } catch {}
        }
      }
    };

    // Порядок определяется блоком сценария, а не общей квотой на видео.
    if (imageFirst) {
      await searchImages();
      if (!gotImage) await searchVideo();
    } else {
      await searchVideo();
      await searchImages();
    }
  };
  // Блоки — партиями по PARALLEL в порядке важности. Одно и то же видео два блока
  // не скачают: пометка в seenVideo ставится синхронно до первого await.
  for (let b = 0; b < ordered.length; b += PARALLEL) {
    if (assets.length >= T.max_total_assets) break;
    await Promise.all(
      ordered.slice(b, b + PARALLEL).map((need) =>
        processNeed(need).catch((e) => console.log(`  блок ${need.beatId}: ${String(e?.message ?? e).slice(0, 100)}`)),
      ),
    );
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

  const { coverage, coverageRatio, hardCoverageRatio, uniqueScenes } = computeCoverage(usable, beats);

  const pack: StoryAssetPackV2 = {
    storyId: research.storyId,
    version: PACK_VERSION,
    fingerprint,
    assets: usable,
    coverage,
    coverageRatio,
    hardCoverageRatio,
    uniqueScenes,
    sourceVideos,
    stages: { ...stages },
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(dir, "story-asset-pack.json"), JSON.stringify(pack, null, 2), "utf8");
  } catch {}
  return pack;
}
