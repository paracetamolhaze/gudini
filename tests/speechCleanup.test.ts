import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCleanupActions,
  edgesFromSilences,
  mechanicalCuts,
  segmentsFromCuts,
  remapWords,
  pausesFromWords,
  deterministicFillers,
  cleanToRaw,
} from "../lib/speechCleanupPlan";
import { Word } from "../lib/transcribe";
import { parseCleanupResponse } from "../lib/speechCleanupPlanner";

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

test("Cleanup: суммарная вырезка ограничена (20% / 15с)", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    type: "REMOVE_FRAGMENT",
    fromWord: 10 + i * 12,
    toWord: 10 + i * 12 + 8, // ~3.5с каждый
    reason: "FALSE_START",
    confidence: 0.95,
  }));
  const { plan } = validateCleanupActions(many as any, words, [], duration);
  const total = plan.actions.reduce((s, a) => s + (a.end - a.start), 0);
  assert.ok(total <= Math.min(duration * 0.2, 15) + 0.01, `вырезано слишком много: ${total}`);
});

test("Test 4: неудачный дубль (RETAKE) вырезается целиком, чистая версия остаётся", () => {
  // два соседних фрагмента читают одно предложение сценария: первый оборван, второй чистый
  const retake = [
    { type: "REMOVE_FRAGMENT", fromWord: 30, toWord: 45, reason: "RETAKE", confidence: 0.9 },
  ];
  const { plan, cuts } = validateCleanupActions(retake as any, words, [], duration);
  assert.equal(plan.actions.length, 1, "RETAKE должен приниматься как причина вырезки");
  assert.equal(plan.actions[0].reason, "RETAKE");
  const removed = plan.actions[0].end - plan.actions[0].start;
  assert.ok(removed > 4, `дубль длиннее обычной запинки, вырезано ${removed.toFixed(2)}с`);
  assert.equal(cuts.length, 1);

  // но неуверенный RETAKE отклоняется: удалить целую мысль по ошибке — дорого
  const shaky = [{ type: "REMOVE_FRAGMENT", fromWord: 30, toWord: 45, reason: "RETAKE", confidence: 0.75 }];
  assert.equal(validateCleanupActions(shaky as any, words, [], duration).plan.actions.length, 0);
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

test("Cleanup: неклассифицированная пауза > 1.2с ужимается автоматически (страховка)", () => {
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

test("Cleanup: вдох 0.77с — это пауза, а не ритм (случай «футболист. … Весь»)", () => {
  const w: Word[] = [
    { word: "опытный", start: 16.74, end: 17.1 },
    { word: "футболист.", start: 17.22, end: 17.84 },
    { word: "Весь", start: 18.52, end: 18.7 },
    { word: "матч", start: 18.78, end: 19.0 },
  ];
  // детектор на старом пороге эту паузу не видел; зазор между словами — видит
  const pauses = pausesFromWords(w, []);
  assert.equal(pauses.length, 1);
  assert.ok(Math.abs(pauses[0].start - 17.84) < 1e-6 && Math.abs(pauses[0].end - 18.52) < 1e-6);
  const { plan, cuts } = validateCleanupActions(
    [{ type: "SHORTEN_PAUSE", silenceIndex: 0, verdict: "UNNECESSARY", confidence: 0.9 }],
    w,
    pauses,
    30,
  );
  assert.equal(plan.actions.length, 1, "пауза 0.68с ужимается (раньше порог 0.8с её пропускал)");
  const left = pauses[0].end - pauses[0].start - (cuts[0].end - cuts[0].start);
  assert.ok(left > 0.3 && left < 0.4, `оставлено ${left.toFixed(2)}с — должно быть ~0.35`);
  // тишина по детектору и зазор слов сливаются в одну паузу
  assert.equal(pausesFromWords(w, [{ start: 17.9, end: 18.6 }]).length, 1);
});

test("Cleanup: вырезка фальстарта забирает паузу после него (случай «эк-- э-э-э, … Хендерсон»)", () => {
  const w: Word[] = [
    { word: "через", start: 37.16, end: 37.32 },
    { word: "эк--", start: 37.46, end: 37.6 },
    { word: "э-э-э,", start: 37.64, end: 37.68 },
    { word: "Хендерсон", start: 38.24, end: 38.7 },
  ];
  const fillers = deterministicFillers(w);
  assert.equal(fillers.length, 1, "обрыв и протянутое э-э-э найдены без модели");
  assert.equal(fillers[0].fromWord, 1);
  assert.equal(fillers[0].toWord, 2);
  const { cuts } = validateCleanupActions(fillers, w, [], 60);
  assert.equal(cuts.length, 1);
  const gapLeft = w[3].start - cuts[0].end;
  assert.ok(gapLeft <= 0.12 + 1e-6, `после вырезки остался зазор ${gapLeft.toFixed(2)}с — пауза 0.56с должна уйти`);
  assert.ok(cuts[0].start >= w[0].end + 0.02, "согласные предыдущего слова не задеты");
});

test("Cleanup: союз перед фальстартом уходит вместе с ним, повторов «и … и» не остаётся", () => {
  const w: Word[] = [
    { word: "щит", start: 41.32, end: 42.16 },
    { word: "и", start: 42.28, end: 42.38 },
    { word: "неудачно", start: 42.98, end: 43.52 },
    { word: "с", start: 44.12, end: 44.14 },
    { word: "под--", start: 44.2, end: 45.2 },
    { word: "и", start: 45.28, end: 45.32 },
    { word: "спотыкается,", start: 45.36, end: 45.98 },
  ];
  // модель отметила фальстарт вместе с союзом (слова 1..4), как велит промпт
  const { cuts } = validateCleanupActions(
    [{ type: "REMOVE_FRAGMENT", fromWord: 1, toWord: 4, reason: "FALSE_START", confidence: 0.9 }],
    w,
    [],
    60,
  );
  assert.equal(cuts.length, 1);
  const kept = remapWords(w, segmentsFromCuts({ start: 0, end: 60 }, cuts)).map((x) => x.word);
  assert.deepEqual(kept, ["щит", "и", "спотыкается,"]);
  // и зазор 0.6с между «и» и «неудачно» тоже ушёл: до следующего слова остаётся ≤0.12с
  assert.ok(w[5].start - cuts[0].end <= 0.12 + 1e-6);
});

test("Cleanup: карта чистого времени в сырое по сегментам", () => {
  const segs = [
    { start: 2, end: 10 },
    { start: 15, end: 20 },
  ];
  assert.equal(cleanToRaw(0, segs), 2);
  assert.ok(Math.abs(cleanToRaw(7.999, segs) - 9.999) < 1e-6);
  assert.equal(cleanToRaw(8, segs), 15, "граница сегмента — это начало следующего");
  assert.equal(cleanToRaw(9, segs), 16);
  assert.equal(cleanToRaw(99, segs), 20);
});

test("Cleanup: обрезанный или обёрнутый в текст ответ модели не теряет действия", () => {
  const full = '{"actions":[{"type":"REMOVE_FRAGMENT","fromWord":1,"toWord":2,"reason":"FILLER","confidence":0.9}]}';
  assert.equal(parseCleanupResponse(full)!.length, 1);
  const truncated =
    'Вот план:\n{"actions":[{"type":"REMOVE_FRAGMENT","fromWord":1,"toWord":2,"reason":"FALSE_START","confidence":0.9},' +
    '{"type":"SHORTEN_PAUSE","silenceIndex":3,"verdict":"UNNECESSARY","confidence":0.85},{"type":"REMOVE_FRAG';
  const got = parseCleanupResponse(truncated)!;
  assert.equal(got.length, 2, "два целых действия спасены, обрезанное отброшено");
  assert.equal(got[1].silenceIndex, 3);
  assert.equal(parseCleanupResponse("ничего похожего на план"), null);
});
