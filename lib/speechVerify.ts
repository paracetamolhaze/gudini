import type { Word } from "./transcribe";
import { pauseCut } from "./speechCleanupPlan";

/**
 * Проверка и починка плана чистки речи — бесплатно и детерминированно, до склейки.
 *
 * Модель чистки и выбор дублей иногда оставляют то, что зритель слышит сразу: слово,
 * разрезанное границей вырезки; паузу в две секунды, которую никто не укоротил;
 * фразу, произнесённую дважды. Здесь такие места находятся по расшифровке и чинятся:
 * границы сдвигаются к краям слов, длинные паузы укорачиваются, из повтора остаётся
 * последнее произнесение. После склейки остаток проверяется ещё раз (verifyCleanSpeech),
 * и если что-то осталось — это ошибка стадии, а не «готово».
 */

export type Cut = { start: number; end: number };

export const VERIFY_MAX_GAP_SEC = 1.5;
export const VERIFY_KEEP_GAP_SEC = 0.6;
export const VERIFY_HARD_GAP_SEC = 2.2;
export const REPEAT_NGRAM = 4;
export const REPEAT_WINDOW_SEC = 20;

const inCut = (t: number, cuts: Cut[]) => cuts.some((c) => t > c.start && t < c.end);

/** Слова, которые останутся после вырезок (середина слова вне любой вырезки). */
export function keptWords(words: Word[], cuts: Cut[]): { word: Word; index: number }[] {
  return words.map((word, index) => ({ word, index })).filter(({ word }) => !inCut((word.start + word.end) / 2, cuts));
}

/** Нормальная форма слова для поиска повторов: строчные, без знаков, первые 6 букв. */
export function stem(word: string): string {
  return word.toLowerCase().replace(/[^a-zа-яё0-9]/gi, "").slice(0, 6);
}

/**
 * Граница вырезки внутри слова режет его пополам. Сдвигаем к краю так, чтобы слово
 * осталось целым: начало вырезки внутри слова — к его концу, конец — к его началу.
 * Схлопнувшиеся вырезки выбрасываются.
 */
export function snapCutsToWords(cuts: Cut[], words: Word[], tol = 0.06): { cuts: Cut[]; snapped: number } {
  let snapped = 0;
  const out: Cut[] = [];
  for (const c of cuts) {
    let { start, end } = c;
    const atStart = words.find((w) => start > w.start + tol && start < w.end - tol);
    if (atStart) {
      start = atStart.end;
      snapped++;
    }
    const atEnd = words.find((w) => end > w.start + tol && end < w.end - tol);
    if (atEnd) {
      end = atEnd.start;
      snapped++;
    }
    if (end - start >= 0.1) out.push({ start, end });
  }
  return { cuts: out, snapped };
}

/** Паузы между оставшимися словами длиннее maxGap, которые план не тронул: укоротить до keep. */
export function leftoverLongGaps(words: Word[], cuts: Cut[], maxGap = VERIFY_MAX_GAP_SEC, keep = VERIFY_KEEP_GAP_SEC): Cut[] {
  const kept = keptWords(words, cuts);
  const extra: Cut[] = [];
  for (let i = 1; i < kept.length; i++) {
    const prev = kept[i - 1].word;
    const next = kept[i].word;
    // часть зазора уже могла быть вырезана: считаем только то, что реально останется
    const removed = cuts
      .map((c) => Math.max(0, Math.min(c.end, next.start) - Math.max(c.start, prev.end)))
      .reduce((a, b) => a + b, 0);
    const remaining = next.start - prev.end - removed;
    if (remaining <= maxGap) continue;
    if (cuts.some((c) => c.start < next.start && c.end > prev.end)) continue; // зазор уже частично резали — не наслаиваем
    extra.push(pauseCut(prev.end, next.start, keep));
  }
  return extra;
}

/**
 * Одна и та же фраза (n слов подряд) дважды в пределах окна среди оставшихся слов —
 * незамеченный дубль. Остаётся последнее произнесение, первое вырезается вместе с тем,
 * что между ними (обычно обрыв и вдох).
 */
export function leftoverRepeats(words: Word[], cuts: Cut[], n = REPEAT_NGRAM, windowSec = REPEAT_WINDOW_SEC): Cut[] {
  const kept = keptWords(words, cuts);
  const sk = kept.map((k) => stem(k.word.word));
  const extra: Cut[] = [];
  let i = 0;
  while (i + n <= kept.length) {
    let found = -1;
    for (let j = i + n; j + n <= kept.length; j++) {
      if (kept[j].word.start - kept[i].word.start > windowSec) break;
      let same = true;
      for (let k = 0; k < n; k++) if (sk[i + k].length < 2 || sk[i + k] !== sk[j + k]) { same = false; break; }
      if (same) { found = j; break; }
    }
    if (found < 0) { i++; continue; }
    const from = kept[i].word;
    const before = kept[found - 1].word;
    const next = kept[found].word;
    const start = Math.max(0, from.start - 0.05);
    const end = Math.min(next.start - 0.02, before.end + Math.min(0.15, Math.max(0.02, (next.start - before.end) / 2)));
    if (end - start >= 0.3) extra.push({ start, end });
    i = found;
  }
  return extra;
}

/** Что осталось после склейки: длинные провалы и повторы — это ошибка стадии. */
export function verifyCleanSpeech(cleanWords: Word[], opts: { maxGap?: number } = {}): string[] {
  const maxGap = opts.maxGap ?? VERIFY_HARD_GAP_SEC;
  const problems: string[] = [];
  for (let i = 1; i < cleanWords.length; i++) {
    const gap = cleanWords[i].start - cleanWords[i - 1].end;
    if (gap > maxGap) problems.push(`пауза ${gap.toFixed(1)} с на ${cleanWords[i - 1].end.toFixed(1)} с`);
  }
  const reps = leftoverRepeats(cleanWords, []);
  for (const r of reps) problems.push(`повтор фразы на ${r.start.toFixed(1)}–${r.end.toFixed(1)} с`);
  return problems;
}
