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
const PAUSE_KEEP_DEFAULT = 0.45;
const PAUSE_MIN_LEN = 0.8; // паузы короче — естественное дыхание, не трогаем
const AUTO_SHORTEN_UNCLASSIFIED = 2.5; // так долго «драматично» не молчат

const FRAGMENT_REASONS = new Set(["REPEATED_WORDS", "FALSE_START", "FILLER", "SELF_CORRECTION", "RETAKE"]);

/**
 * Валидация плана чистки: только уверенные и безопасные действия.
 * Принцип: лучше вырезать меньше, чем сломать речь.
 */
export function validateCleanupActions(
  raw: RawCleanupAction[],
  words: Word[],
  silences: SilenceEvent[],
  duration: number,
): { plan: SpeechCleanupPlan; cuts: CutRegion[] } {
  const actions: SpeechCleanupAction[] = [];
  const cuts: CutRegion[] = [];
  let removedTotal = 0;
  // запас чуть шире прежнего: неудачный дубль сам по себе занимает несколько секунд
  const removedCap = Math.min(duration * 0.2, 15);
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
      if (to >= words.length || to - from + 1 > (retake ? MAX_RETAKE_WORDS : MAX_FRAGMENT_WORDS)) continue;

      // границы — по стыкам с соседними словами, с запасом (не съедать согласные)
      const prevEnd = from > 0 ? words[from - 1].end : 0;
      const nextStart = to < words.length - 1 ? words[to + 1].start : duration;
      const start = Math.max(prevEnd + 0.02, words[from].start - 0.05);
      const end = Math.min(nextStart - 0.02, words[to].end + 0.05);
      if (end - start < 0.12) continue;
      if (end - start > (retake ? MAX_RETAKE_SEC : MAX_FRAGMENT_SEC)) continue;
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
