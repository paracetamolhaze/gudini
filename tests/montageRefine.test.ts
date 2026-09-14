import { test } from "node:test";
import assert from "node:assert/strict";
import { refineMontage, beatStarts } from "../lib/montageRefine";
import { taste } from "../lib/montageTaste";
import type { MontagePlan } from "../lib/creativeDirector";
import type { Word } from "../lib/transcribe";
// Keep the semantic montage regressions in the existing npm test entry point.
import "./montageEditorial.test";

/**
 * Регрессия на план режиссёра с проекта Хендерсона: 10 карточек, две по 6.3 с подряд
 * и одна на 16.6 с. Уплотнение обязано выдать трек без длинных зависаний, без
 * повторов материала, с цитатами и с картинкой к концу вступительного наезда.
 */
const script = [
  "Это первый футболист в мире, который сломал руку.",
  "Чемпионат мира, Англия играет с Мексикой.",
  "В запасе сидит Джордан Хендерсон.",
  "В итоге его уносят с поля на носилках.",
  "Тренер подтвердил, что всё серьёзно.",
  "Человек уезжает домой с рукой в гипсе.",
  "Это уже называют самой нелепой травмой.",
];
const beats = [
  { id: "b0", text: script[0], visualNeed: "ENTITY" },
  { id: "b1", text: script[1], visualNeed: "CONTEXT" },
  { id: "b2", text: script[2], visualNeed: "ENTITY" },
  { id: "b3", text: script[3], visualNeed: "EXACT_EVENT" },
  { id: "b4", text: script[4], visualNeed: "CONTEXT" },
  { id: "b5", text: script[5], visualNeed: "ENTITY" },
  { id: "b6", text: script[6], visualNeed: "NONE" },
];
const needs = [
  { beatId: "b0", intent: "ENTITY", entities: ["Jordan Henderson"], visualDescription: "Portrait of Jordan Henderson" },
  { beatId: "b1", intent: "CONTEXT", entities: ["England"], visualDescription: "Packed stadium crowd" },
  { beatId: "b2", intent: "ENTITY", entities: ["Jordan Henderson"], visualDescription: "Henderson on the bench" },
  { beatId: "b3", intent: "EXACT_EVENT", entities: ["Jordan Henderson"], visualDescription: "Medical staff carrying player on stretcher" },
  { beatId: "b4", intent: "CONTEXT", entities: ["Jordan Henderson"], visualDescription: "Coach at press conference" },
  { beatId: "b5", intent: "ENTITY", entities: ["Jordan Henderson"], visualDescription: "Footballer with arm in a cast" },
];
// речь: 7 предложений по ~8 секунд, слова через 0.45 с
const words: Word[] = [];
let t = 0.5;
for (const sentence of script) {
  for (const w of sentence.split(/\s+/)) {
    words.push({ word: w, start: t, end: t + 0.35 });
    t += 0.45;
  }
  t += 3.5; // пауза между предложениями, чтобы каждый блок длился ~8 с
}
const duration = t + 1;

const asset = (id: string, description: string, beatScores: Record<string, number>) => ({
  id,
  kind: "IMAGE" as const,
  file: `img-${id}.jpg`,
  sourceUrl: "https://example.com/" + id,
  sourceDomain: "example.com",
  description,
  role: "CONTEXT" as const,
  compatibleBeatIds: Object.keys(beatScores),
  beatScores,
  relatedFactIds: [],
  verification: { sourceVerified: true, visualVerified: true, version: 3 },
});
const pack: any = {
  version: 3,
  assets: [
    asset("portrait1", "Portrait of Henderson in England jacket", { b0: 2, b2: 2, b5: 2 }),
    asset("portrait2", "Henderson smiling at stadium", { b0: 2, b2: 2 }),
    asset("crowd", "Packed stadium stands with fans", { b1: 2 }),
    asset("warmup", "England footballer jogging on pitch", { b1: 2 }),
    asset("bench", "Substitutes sitting on the bench", { b2: 2 }),
    asset("medics", "Medical staff treating injured player on stretcher", { b3: 3, b4: 2 }),
    asset("cast", "Athlete's arm wrapped in white cast", { b3: 2, b4: 2, b5: 3 }),
    asset("coach", "Coach speaking to player on sideline", { b4: 1 }),
    asset("celebration", "England players celebrating", { b1: 1 }),
  ],
  sourceVideos: [],
  coverage: [],
  coverageRatio: 1,
  hardCoverageRatio: 1,
};
// режиссёр: долгие зависания и портреты подряд, гипс тянется через два блока до конца
const director: MontagePlan = {
  version: 3,
  duration,
  events: [
    { type: "EXTERNAL_IMAGE", assetId: "portrait1", beatId: "b2", quote: "в запасе сидит", start: 3, end: 9.3, layout: "smart_crop", motion: "static", role: "CONTEXT" },
    { type: "EXTERNAL_IMAGE", assetId: "portrait2", beatId: "b2", quote: "джордан хендерсон", start: 9.3, end: 15.6, layout: "smart_crop", motion: "static", role: "CONTEXT" },
    { type: "EXTERNAL_IMAGE", assetId: "medics", beatId: "b3", quote: "уносят с поля", start: 15.6, end: 26, layout: "smart_crop", motion: "static", role: "CONTEXT" },
    { type: "EXTERNAL_IMAGE", assetId: "cast", beatId: "b4", quote: "тренер подтвердил", start: 26, end: duration, layout: "smart_crop", motion: "static", role: "CONTEXT" },
  ],
  stats: { externalCoverage: 1, videoShare: 0, maxARollGap: 0, speechCutsCovered: 0, speechCutsTotal: 0 },
};

test("Refine: начало блоков находится по речи; короткие «его», «так» не сдвигают границы", () => {
  const starts = beatStarts(beats, words);
  assert.equal(starts.filter((s) => s != null).length, beats.length, "все блоки найдены");
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! > starts[i - 1]!, "начала возрастают");
});

test("Refine: long placements are trimmed without manufacturing extra cards", () => {
  const starts = beatStarts(beats, words);
  const selected: MontagePlan = { ...director, events: [
    { ...director.events[2], start: starts[3]!, end: starts[3]! + 16 },
    { ...director.events[3], beatId: "b5", start: starts[5]!, end: duration },
  ] };
  const { plan, slots } = refineMontage({ montage: selected, pack, beats, needs, words, duration });
  assert.equal(slots.length, 7, "author-only beat supplies a real boundary too");
  assert.equal(plan.events.length, 2);
  for (const e of plan.events) {
    assert.ok(e.end - e.start <= taste().max_visual_duration + 0.01);
    assert.ok(e.quote.split(/\s+/).length >= 2);
  }
  assert.equal(plan.events[1].beatId, "b5");
  assert.ok(plan.events[0].end < plan.events[1].start, "intentional gap remains");
  assert.ok(plan.events.at(-1)!.end <= starts[6]!, "no picture over the author-only ending");
});

test("Refine: a misplaced choice is not moved into a different story beat", () => {
  const starts = beatStarts(beats, words);
  const selected = { ...director, events: [{ ...director.events[2], start: starts[5]!, end: duration }] };
  const { plan } = refineMontage({ montage: selected, pack, beats, needs, words, duration });
  assert.equal(plan.events.length, 0, "medics selected after their spoken beat are dropped");
});
