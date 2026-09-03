import { test } from "node:test";
import assert from "node:assert/strict";
import { refineMontage, beatStarts } from "../lib/montageRefine";
import { taste } from "../lib/montageTaste";
import type { MontagePlan } from "../lib/creativeDirector";
import type { Word } from "../lib/transcribe";

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

test("Refine: 16-секундное зависание и портреты подряд превращаются в трек из коротких карточек", () => {
  const T = taste();
  const { plan, notes } = refineMontage({ montage: director, pack, beats, needs, words, duration, personNames: ["Jordan Henderson"] });
  const ev = [...plan.events].sort((a, b) => a.start - b.start);
  assert.ok(ev.length > director.events.length, `карточек стало больше: ${notes.join("; ")}`);
  assert.ok(Math.abs(ev[0].start - T.first_visual_by) < 0.01, "первая карточка ровно к концу наезда");
  for (const e of ev) {
    assert.ok(e.end - e.start <= T.max_visual_duration + 0.6, `карточка ${e.assetId} длиной ${(e.end - e.start).toFixed(1)}с`);
    assert.ok(e.end - e.start >= T.min_visual_duration - 0.01, `карточка ${e.assetId} короче минимума`);
    assert.ok(e.quote.trim().split(/\s+/).length >= 2, "цитата речи есть");
  }
  const ids = ev.map((e) => e.assetId);
  assert.equal(new Set(ids).size, ids.length, "материал не повторяется");
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].start - ev[i - 1].end <= 0.05, "трек непрерывный");
  assert.ok(Math.abs(ev[ev.length - 1].end - duration) < 0.05, "трек до конца ролика");
});

test("Refine: выбор режиссёра закрепляется за блоком с лучшей оценкой, гипс попадает на «в гипсе»", () => {
  const { plan } = refineMontage({ montage: director, pack, beats, needs, words, duration, personNames: ["Jordan Henderson"] });
  const cast = plan.events.find((e) => e.assetId === "cast")!;
  const medics = plan.events.find((e) => e.assetId === "medics")!;
  assert.equal(cast.beatId, "b5", "гипс — на блоке про гипс, хотя режиссёр писал b4");
  assert.equal(medics.beatId, "b3", "медики — на носилках");
  const spoken = words.filter((w) => w.end > cast.start && w.start < cast.end).map((w) => w.word.toLowerCase());
  assert.ok(spoken.some((w) => /гипсе/.test(w)), `под гипсом говорят: ${spoken.join(" ")}`);
});
