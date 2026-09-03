import { Word } from "./transcribe";
import { SilenceEvent } from "./ffmpeg";

/**
 * Speech Cleanup — чистка речи как у живого монтажёра:
 * удаление запинок/повторов/фальстартов и умное ужатие пауз.
 * LLM только ПЛАНИРУЕТ (индексы слов/пауз), код валидирует и режет детерминированно.
 */

export type SpeechCleanupAction =
  | {
      type: "REMOVE_FRAGMENT";
      start: number;
      end: number;
      reason: "REPEATED_WORDS" | "FALSE_START" | "FILLER" | "SELF_CORRECTION" | "RETAKE";
      confidence: number;
    }
  | {
      type: "SHORTEN_PAUSE";
      start: number;
      end: number;
      keepDuration: number;
      reason: "UNNECESSARY_PAUSE";
      confidence: number;
    };

export type SpeechCleanupPlan = {
  version: 1;
  actions: SpeechCleanupAction[];
};

/** «Сырой» ответ LLM: границы в индексах слов и индексах пауз. */
export type RawCleanupAction = {
  type?: string;
  fromWord?: number;
  toWord?: number;
  silenceIndex?: number;
  verdict?: string; // INTENTIONAL | UNNECESSARY
  reason?: string;
  confidence?: number;
};

export type CutRegion = { start: number; end: number };

const MIN_CONFIDENCE = 0.7;
const MAX_FRAGMENT_SEC = 4.0;
const MAX_FRAGMENT_WORDS = 12;
// неудачный дубль — это целая попытка произнести фразу, она длиннее обычной запинки
const MAX_RETAKE_SEC = 9.0;
const MAX_RETAKE_WORDS = 30;
const MIN_RETAKE_CONFIDENCE = 0.8;
const HOOK_GUARD_SEC = 2.0; // начало ролика не трогаем вслепую
/** Сколько оставить от лишней паузы: естественный зазор между фразами. */
const PAUSE_KEEP_DEFAULT = 0.35;
/**
 * Паузы короче — обычный ритм речи. Раньше порог был 0.8 с, и вдох на 0.77 с
 * между «футболист.» и «Весь» оставался в ролике как провал.
 */
const PAUSE_MIN_LEN = 0.5;
/** Неклассифицированная пауза длиннее — «мёртвая дыра», ужимается без спроса. */
const AUTO_SHORTEN_UNCLASSIFIED = 1.2;
/** Вырезка фрагмента забирает и зазоры вокруг него, оставляя максимум столько с каждой стороны. */
const FRAGMENT_EDGE_KEEP = 0.12;

const FRAGMENT_REASONS = new Set(["REPEATED_WORDS", "FALSE_START", "FILLER", "SELF_CORRECTION", "RETAKE"]);

/**
 * Валидация плана чистки: только уверенные и безопасные действия.
 * Принцип: лучше вырезать меньше, чем сломать речь.
 */
export type ValidateOptions = {
  /** предел суммарной вырезки фрагментов; для дублей, найденных по сценарию, — без предела */
  removedCap?: number;
  maxRetakeSec?: number;
  maxRetakeWords?: number;
};

export function validateCleanupActions(
  raw: RawCleanupAction[],
  words: Word[],
  silences: SilenceEvent[],
  duration: number,
  opts: ValidateOptions = {},
): { plan: SpeechCleanupPlan; cuts: CutRegion[] } {
  const actions: SpeechCleanupAction[] = [];
  const cuts: CutRegion[] = [];
  let removedTotal = 0;
  // запас чуть шире прежнего: неудачный дубль сам по себе занимает несколько секунд
  const removedCap = opts.removedCap ?? Math.min(duration * 0.2, 15);
  const maxRetakeSec = opts.maxRetakeSec ?? MAX_RETAKE_SEC;
  const maxRetakeWords = opts.maxRetakeWords ?? MAX_RETAKE_WORDS;
  const classified = new Set<number>();

  for (const a of raw ?? []) {
    const confidence = Number(a.confidence);
    if (!Number.isFinite(confidence)) continue;

    if (String(a.type) === "REMOVE_FRAGMENT") {
      const reason = FRAGMENT_REASONS.has(String(a.reason)) ? (a.reason as any) : null;
      if (!reason) continue;
      const retake = reason === "RETAKE";
      if (confidence < (retake ? MIN_RETAKE_CONFIDENCE : MIN_CONFIDENCE)) continue;
      const from = Math.trunc(Number(a.fromWord));
      const to = Math.trunc(Number(a.toWord));
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) continue;
      if (to >= words.length || to - from + 1 > (retake ? maxRetakeWords : MAX_FRAGMENT_WORDS)) continue;

      // Границы — по стыкам с соседними словами. Вырезка забирает и зазоры вокруг
      // фрагмента: после вырезанного фальстарта «…через эк-- э-э-э,» оставалась
      // пауза 0.56 с перед перезапуском фразы — провал на ровном месте. Теперь от
      // зазора с каждой стороны остаётся не больше FRAGMENT_EDGE_KEEP, но не меньше
      // 0.02 с, чтобы не съесть согласные соседних слов.
      const prevEnd = from > 0 ? words[from - 1].end : 0;
      const nextStart = to < words.length - 1 ? words[to + 1].start : duration;
      const leadGap = Math.max(0, words[from].start - prevEnd);
      const trailGap = Math.max(0, nextStart - words[to].end);
      const start = from > 0 ? prevEnd + Math.min(FRAGMENT_EDGE_KEEP, Math.max(0.02, leadGap / 2)) : Math.max(0, words[from].start - 0.05);
      const end = to < words.length - 1 ? nextStart - Math.min(FRAGMENT_EDGE_KEEP, Math.max(0.02, trailGap / 2)) : Math.min(duration, words[to].end + 0.05);
      if (end - start < 0.12) continue;
      if (end - start > (retake ? maxRetakeSec : MAX_FRAGMENT_SEC)) continue;
      // хук защищён от вырезки — кроме СТОПРОЦЕНТНЫХ коротких филлеров («эээ», «ну эээ»)
      if (start < HOOK_GUARD_SEC) {
        const shortObviousFiller = reason === "FILLER" && confidence >= 0.92 && end - start <= 1.2;
        if (!shortObviousFiller) continue;
      }
      if (removedTotal + (end - start) > removedCap) continue;

      removedTotal += end - start;
      actions.push({ type: "REMOVE_FRAGMENT", start: r3(start), end: r3(end), reason, confidence });
      cuts.push({ start, end });
    } else if (String(a.type) === "SHORTEN_PAUSE") {
      const idx = Math.trunc(Number(a.silenceIndex));
      const sil = silences[idx];
      if (!sil) continue;
      classified.add(idx);
      const verdict = String(a.verdict ?? "").toUpperCase();
      if (verdict !== "UNNECESSARY" || confidence < MIN_CONFIDENCE) continue; // INTENTIONAL/сомнительное — оставляем
      const len = sil.end - sil.start;
      if (len < PAUSE_MIN_LEN) continue;
      const keep = PAUSE_KEEP_DEFAULT;
      if (len <= keep + 0.15) continue;
      actions.push({
        type: "SHORTEN_PAUSE",
        start: r3(sil.start),
        end: r3(sil.end),
        keepDuration: keep,
        reason: "UNNECESSARY_PAUSE",
        confidence,
      });
      cuts.push({ start: sil.start + keep * 0.55, end: sil.end - keep * 0.45 });
    }
  }

  // неклассифицированные слишком длинные паузы — ужимаем (страховка от «мертвых» дыр)
  silences.forEach((sil, idx) => {
    if (classified.has(idx)) return;
    const len = sil.end - sil.start;
    if (len > AUTO_SHORTEN_UNCLASSIFIED && sil.start > HOOK_GUARD_SEC) {
      actions.push({
        type: "SHORTEN_PAUSE",
        start: r3(sil.start),
        end: r3(sil.end),
        keepDuration: PAUSE_KEEP_DEFAULT,
        reason: "UNNECESSARY_PAUSE",
        confidence: 1,
      });
      cuts.push({ start: sil.start + 0.25, end: sil.end - 0.2 });
    }
  });

  return { plan: { version: 1, actions }, cuts };
}

/**
 * Паузы для планировщика: тишина по детектору ПЛЮС зазоры между словами расшифровки.
 * Scribe даёт точные границы слов, а детектор тишины на пороге громкости не видит
 * вдох (он громче «тишины», но это всё равно пауза). Пересекающиеся участки
 * сливаются; список отсортирован.
 */
export function pausesFromWords(words: Word[], silences: SilenceEvent[], minGap = 0.5): SilenceEvent[] {
  const all: SilenceEvent[] = [...silences.map((s) => ({ start: s.start, end: s.end }))];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= minGap) all.push({ start: words[i - 1].end, end: words[i].start });
  }
  all.sort((a, b) => a.start - b.start);
  const merged: SilenceEvent[] = [];
  for (const p of all) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end + 0.05) last.end = Math.max(last.end, p.end);
    else merged.push({ ...p });
  }
  return merged;
}

/**
 * Мусор, который виден в самой расшифровке без модели: оборванное слово («эк--»,
 * «под--» — так Scribe помечает обрыв) и протянутое «э-э-э», «ээ», «м-м». Соседние
 * такие слова сливаются в один фрагмент. Уверенность 0.95: это стопроцентный мусор,
 * и в хуке он тоже режется (короткий явный филлер).
 */
export function deterministicFillers(words: Word[]): RawCleanupAction[] {
  const junk = (w: string) => {
    const t = w.trim().replace(/[,.!?…]+$/, "");
    return /--$/.test(t) || /^[эа](-?[эа])+$/i.test(t) || /^(э+|эм+|м+|ммм+)$/i.test(t);
  };
  const out: RawCleanupAction[] = [];
  let i = 0;
  while (i < words.length) {
    if (!junk(words[i].word)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < words.length && junk(words[j + 1].word)) j++;
    out.push({ type: "REMOVE_FRAGMENT", fromWord: i, toWord: j, reason: "FILLER", confidence: 0.95 });
    i = j + 1;
  }
  return out;
}

/** Время чистого таймлайна → время исходника по сегментам. */
export function cleanToRaw(t: number, segments: { start: number; end: number }[]): number {
  let cum = 0;
  for (const s of segments) {
    const len = s.end - s.start;
    if (t < cum + len) return s.start + Math.max(0, t - cum);
    cum += len;
  }
  return segments.length ? segments[segments.length - 1].end : t;
}

/** Время исходника → время чистого таймлайна; точка внутри вырезки схлопывается в место склейки. */
export function rawToClean(t: number, segments: { start: number; end: number }[]): number {
  let cum = 0;
  for (const s of segments) {
    if (t < s.start) return cum;
    if (t < s.end) return cum + (t - s.start);
    cum += s.end - s.start;
  }
  return cum;
}

/** Механическая логика пауз (фолбэк без LLM): внутренние >1.2с ужимаются до ~0.45с. */
export function mechanicalCuts(silences: SilenceEvent[], edges: CutRegionEdges): CutRegion[] {
  const cuts: CutRegion[] = [];
  for (const sil of silences) {
    const s = Math.max(sil.start, edges.start);
    const e = Math.min(sil.end, edges.end);
    if (e - s > 1.2 && s > edges.start + 0.5 && e < edges.end - 0.5) {
      cuts.push({ start: s + 0.25, end: e - 0.2 });
    }
  }
  return cuts;
}

export type CutRegionEdges = { start: number; end: number };

/** Края полезной части: тишина в начале/конце (как раньше). */
export function edgesFromSilences(silences: SilenceEvent[], duration: number): CutRegionEdges {
  let start = 0;
  let end = duration;
  const first = silences[0];
  if (first && first.start <= 0.3 && first.end < duration) start = Math.max(0, first.end - 0.25);
  const last = silences[silences.length - 1];
  if (last && last.end >= duration - 0.5 && last.start > start) end = Math.min(duration, last.start + 0.5);
  if (end - start < 3) return { start: 0, end: duration };
  return { start, end };
}

/** Сегменты, которые остаются: [edges] минус cuts (склейка пересечений, микро-сегменты вливаются в вырезку). */
export function segmentsFromCuts(
  edges: CutRegionEdges,
  cuts: CutRegion[],
  minSegment = 0.25,
): { start: number; end: number }[] {
  const clamped = cuts
    .map((c) => ({ start: Math.max(c.start, edges.start), end: Math.min(c.end, edges.end) }))
    .filter((c) => c.end - c.start > 0.02)
    .sort((a, b) => a.start - b.start);

  // merge пересекающихся вырезок
  const merged: CutRegion[] = [];
  for (const c of clamped) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + 0.02) last.end = Math.max(last.end, c.end);
    else merged.push({ ...c });
  }

  const segments: { start: number; end: number }[] = [];
  let cursor = edges.start;
  for (const cut of merged) {
    if (cut.start - cursor >= minSegment) segments.push({ start: cursor, end: cut.start });
    else if (segments.length) segments[segments.length - 1].end = Math.min(segments[segments.length - 1].end, cut.start);
    cursor = Math.max(cursor, cut.end);
  }
  if (edges.end - cursor >= minSegment) segments.push({ start: cursor, end: edges.end });
  return segments.length ? segments : [{ start: edges.start, end: edges.end }];
}

/**
 * Пересчёт словных таймкодов на чистый таймлайн после вырезки.
 * Слова, попавшие в вырезанные куски, выпадают (и из субтитров тоже).
 */
/**
 * Как remapWords, но сохраняет для каждого слова его индекс в исходном списке.
 * Нужно второму проходу чистки: он планирует по «чистой» транскрипции, а резать
 * надо по исходному таймлайну.
 */
export function remapWordsWithIndex(
  words: Word[],
  segments: { start: number; end: number }[],
): { words: Word[]; srcIndex: number[] } {
  const out: Word[] = [];
  const srcIndex: number[] = [];
  let cum = 0;
  for (const seg of segments) {
    const segLen = seg.end - seg.start;
    words.forEach((w, i) => {
      const mid = (w.start + w.end) / 2;
      if (mid >= seg.start && mid < seg.end) {
        out.push({
          word: w.word,
          start: cum + Math.max(0, w.start - seg.start),
          end: cum + Math.min(segLen, Math.max(0.05, w.end - seg.start)),
        });
        srcIndex.push(i);
      }
    });
    cum += segLen;
  }
  const order = out.map((_, i) => i).sort((a, b) => out[a].start - out[b].start);
  return { words: order.map((i) => out[i]), srcIndex: order.map((i) => srcIndex[i]) };
}

export function remapWords(words: Word[], segments: { start: number; end: number }[]): Word[] {
  const out: Word[] = [];
  let cum = 0;
  for (const seg of segments) {
    const segLen = seg.end - seg.start;
    for (const w of words) {
      const mid = (w.start + w.end) / 2;
      if (mid >= seg.start && mid < seg.end) {
        out.push({
          word: w.word,
          start: cum + Math.max(0, w.start - seg.start),
          end: cum + Math.min(segLen, Math.max(0.05, w.end - seg.start)),
        });
      }
    }
    cum += segLen;
  }
  return out.sort((a, b) => a.start - b.start);
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
