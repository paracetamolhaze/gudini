import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCleanupActions,
  edgesFromSilences,
  mechanicalCuts,
  segmentsFromCuts,
  remapWords,
} from "../lib/speechCleanupPlan";
import { Word } from "../lib/transcribe";

function makeWords(n: number, wordDur = 0.4): Word[] {
  return Array.from({ length: n }, (_, i) => ({
    word: `слово${i}`,
    start: i * wordDur,
    end: i * wordDur + wordDur * 0.85,
  }));
}

const words = makeWords(150);
const duration = 60;

test("Cleanup: уверенный REMOVE_FRAGMENT принимается с margins по соседним словам", () => {
  const { plan, cuts } = validateCleanupActions(
    [{ type: "REMOVE_FRAGMENT", fromWord: 20, toWord: 21, reason: "REPEATED_WORDS", confidence: 0.9 }],
    words,
    [],
    duration,
  );
  assert.equal(plan.actions.length, 1);
  assert.equal(cuts.length, 1);
  // границы не залезают на соседние слова
  assert.ok(cuts[0].start >= words[19].end);
  assert.ok(cuts[0].end <= words[22].start);
});

test("Cleanup: низкая уверенность (<0.7) отбрасывается", () => {
  const { plan } = validateCleanupActions(
    [{ type: "REMOVE_FRAGMENT", fromWord: 20, toWord: 21, reason: "FILLER", confidence: 0.5 }],
    words,
    [],
    duration,
  );
  assert.equal(plan.actions.length, 0);
});

test("Cleanup: явный короткий FILLER в хуке (conf>=0.92) — вырезается", () => {
  const { plan } = validateCleanupActions(
    [{ type: "REMOVE_FRAGMENT", fromWord: 0, toWord: 1, reason: "FILLER", confidence: 0.95 }],
    words,
    [],
    duration,
  );
  assert.equal(plan.actions.length, 1);
});

test("Cleanup: НЕ-филлер в хуке НИКОГДА не режется (false start/self-correction/обычная речь)", () => {
  const { plan } = validateCleanupActions(
    [
      { type: "REMOVE_FRAGMENT", fromWord: 0, toWord: 1, reason: "FALSE_START", confidence: 0.99 },
      { type: "REMOVE_FRAGMENT", fromWord: 0, toWord: 1, reason: "SELF_CORRECTION", confidence: 0.99 },
      { type: "REMOVE_FRAGMENT", fromWord: 0, toWord: 1, reason: "REPEATED_WORDS", confidence: 0.99 },
    ],
    words,
    [],
    duration,
  );
  assert.equal(plan.actions.length, 0);
});

test("Cleanup: FILLER в хуке с conf<0.92 — не режется", () => {
  const { plan } = validateCleanupActions(
    [{ type: "REMOVE_FRAGMENT", fromWord: 0, toWord: 1, reason: "FILLER", confidence: 0.85 }],
    words,
    [],
    duration,
  );
  assert.equal(plan.actions.length, 0);
});

test("Cleanup: длинный «филлер» (>1.2с) в хуке — не режется", () => {
  const { plan } = validateCleanupActions(
    [{ type: "REMOVE_FRAGMENT", fromWord: 0, toWord: 4, reason: "FILLER", confidence: 0.95 }],
    words,
    [],
    duration,
  );
  assert.equal(plan.actions.length, 0);
});

test("Cleanup: длинный «полноценный» кусок (>12 слов) не вырезается", () => {
  const { plan } = validateCleanupActions(
    [{ type: "REMOVE_FRAGMENT", fromWord: 20, toWord: 40, reason: "FALSE_START", confidence: 0.9 }],
    words,
    [],
    duration,
  );
  assert.equal(plan.actions.length, 0);
});

test("Cleanup: суммарная вырезка ограничена (15% / 12с)", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    type: "REMOVE_FRAGMENT",
    fromWord: 10 + i * 12,
    toWord: 10 + i * 12 + 8, // ~3.5с каждый
    reason: "FALSE_START",
    confidence: 0.95,
  }));
  const { plan } = validateCleanupActions(many as any, words, [], duration);
  const total = plan.actions.reduce((s, a) => s + (a.end - a.start), 0);
  assert.ok(total <= Math.min(duration * 0.15, 12) + 0.01, `вырезано слишком много: ${total}`);
});

test("Cleanup: INTENTIONAL-пауза не трогается, UNNECESSARY ужимается", () => {
  const silences = [
    { start: 10, end: 12 },
    { start: 20, end: 22 },
  ];
  const { plan, cuts } = validateCleanupActions(
    [
      { type: "SHORTEN_PAUSE", silenceIndex: 0, verdict: "INTENTIONAL", confidence: 0.9 },
      { type: "SHORTEN_PAUSE", silenceIndex: 1, verdict: "UNNECESSARY", confidence: 0.9 },
    ],
    words,
    silences,
    duration,
  );
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, "SHORTEN_PAUSE");
  assert.ok(cuts[0].start > 20 && cuts[0].end < 22);
});

test("Cleanup: неклассифицированная пауза > 2.5с ужимается автоматически (страховка)", () => {
  const silences = [{ start: 30, end: 34 }];
  const { plan } = validateCleanupActions([], words, silences, duration);
  assert.equal(plan.actions.length, 1);
});

test("Cleanup: битые действия (NaN, несуществующая пауза, кривой тип) не роняют валидацию", () => {
  const { plan } = validateCleanupActions(
    [
      { type: "REMOVE_FRAGMENT", fromWord: NaN as any, toWord: 5, reason: "FILLER", confidence: 0.9 },
      { type: "SHORTEN_PAUSE", silenceIndex: 99, verdict: "UNNECESSARY", confidence: 0.9 },
      { type: "EXPLODE" } as any,
    ],
    words,
    [],
    duration,
  );
  assert.equal(plan.actions.length, 0);
});

test("Silence: края обрезаются, защита от чрезмерной обрезки", () => {
  const edges = edgesFromSilences(
    [
      { start: 0, end: 2 },
      { start: 55, end: 60 },
    ],
    60,
  );
  assert.ok(edges.start > 1.5 && edges.start <= 2);
  assert.ok(edges.end >= 55 && edges.end < 56);
  // всё видео — тишина → возвращаем как есть
  const whole = edgesFromSilences([{ start: 0, end: 60 }], 60);
  assert.deepEqual(whole, { start: 0, end: 60 });
});

test("Silence (механика): внутренние паузы > 1.2с режутся, короткие — нет", () => {
  const cuts = mechanicalCuts(
    [
      { start: 10, end: 12 }, // 2с → режем
      { start: 20, end: 20.8 }, // 0.8с → нет
    ],
    { start: 0, end: 60 },
  );
  assert.equal(cuts.length, 1);
  assert.ok(cuts[0].start > 10 && cuts[0].end < 12);
});

test("segmentsFromCuts: комплемент, merge пересечений, микро-сегменты вливаются", () => {
  const segments = segmentsFromCuts({ start: 0, end: 30 }, [
    { start: 5, end: 7 },
    { start: 6.5, end: 9 }, // пересекается — merge
    { start: 9.1, end: 12 }, // сегмент 9..9.1 — микро, вливается
  ]);
  assert.deepEqual(
    segments.map((s) => [Math.round(s.start), Math.round(s.end)]),
    [
      [0, 5],
      [12, 30],
    ],
  );
});

test("remapWords: таймкоды пересчитаны, вырезанные слова выпали", () => {
  const w: Word[] = [
    { word: "а", start: 1, end: 1.5 },
    { word: "эээ", start: 5.5, end: 6.5 }, // будет вырезано
    { word: "б", start: 10, end: 10.5 },
  ];
  const segments = [
    { start: 0, end: 5 },
    { start: 8, end: 15 },
  ];
  const out = remapWords(w, segments);
  assert.equal(out.length, 2);
  assert.equal(out[0].word, "а");
  assert.ok(Math.abs(out[0].start - 1) < 0.01);
  assert.equal(out[1].word, "б");
  assert.ok(Math.abs(out[1].start - (5 + 2)) < 0.01); // 5 (первый сегмент) + (10-8)
});
