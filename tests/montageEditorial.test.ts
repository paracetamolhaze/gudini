import { test } from "node:test";
import assert from "node:assert/strict";
import { refineMontage } from "../lib/montageRefine";
import { computeStats, type MontageEvent, type MontagePlan } from "../lib/creativeDirector";
import { validateMontage } from "../lib/montageValidator";
import { beatQueries, verifyNeedImageSource } from "../lib/storyAssetPack";

const words = [
  { word: "Сначала", start: 3, end: 4 }, { word: "показываем", start: 4, end: 5 }, { word: "машину", start: 5, end: 6 },
  { word: "Потом", start: 10, end: 11 }, { word: "распознали", start: 11, end: 12 }, { word: "оружие", start: 12, end: 13 },
  { word: "Теперь", start: 18, end: 19 }, { word: "объяснение", start: 19, end: 20 }, { word: "автора", start: 20, end: 21 },
];
const beats = [
  { id: "car", text: "Сначала показываем машину", visualNeed: "ENTITY" },
  { id: "weapon", text: "Потом распознали оружие", visualNeed: "EXACT_EVENT" },
  { id: "author", text: "Теперь объяснение автора", visualNeed: "NONE" },
];
const asset = (id: string, scores: Record<string, number>, visualFamily = id): any => ({ id, kind: "IMAGE", file: id + ".jpg", description: id, role: "CONTEXT", beatScores: scores, compatibleBeatIds: Object.keys(scores), visualFamily, verification: { sourceVerified: true, visualVerified: true } });
const event = (id: string, beatId: string, start: number, end: number): MontageEvent => ({ type: "EXTERNAL_IMAGE", assetId: id, beatId, start, end, quote: "Сначала показываем машину", role: "CONTEXT", layout: "smart_crop" });
function run(events: MontageEvent[], assets: any[]) {
  const montage: MontagePlan = { version: 3, duration: 25, events, stats: computeStats(events, 25, []) };
  return refineMontage({ montage, pack: { assets } as any, beats, needs: [], words, duration: 25 }).plan;
}
test("no unrelated fallback under a concrete action, even when a car is excellent for another beat", () => {
  const p = run([event("car", "car", 3, 7), event("spare-car", "weapon", 10, 14)], [asset("car", { car: 3 }), asset("spare-car", { car: 3, weapon: 1 })]);
  assert.deepEqual(p.events.map(e => e.assetId), ["car"]);
  assert.equal(p.events[0].end, 7, "do not extend to the next image or end of video");
  assert.equal(p.stats.externalCoverage, 4 / 25);
});
test("an empty editorial plan stays empty instead of filling every sentence from the library", () => {
  assert.equal(run([], [asset("car", { car: 3 }), asset("gun", { weapon: 3 })]).events.length, 0);
});
test("different files showing the same information are not extra visual beats", () => {
  const p = run([event("front", "car", 3, 7), event("rear", "weapon", 10, 14)], [asset("front", { car: 3 }, "robotaxi-exterior"), asset("rear", { weapon: 3 }, "robotaxi-exterior")]);
  assert.equal(p.events.length, 1);
});
test("a card cannot continue across an explicitly unillustrated author beat", () => {
  const p = run([event("gun", "weapon", 15, 24)], [asset("gun", { weapon: 3 })]);
  assert.ok(p.events.every(e => e.end <= 18));
});

test("production validation accepts intentional gaps and rejects topical filler", () => {
  const assets = [asset("car", { car: 3, weapon: 1 })];
  const sparse = run([event("car", "car", 3, 7)], assets);
  assert.equal(validateMontage(sparse, { assets } as any).ok, true);
  assert.equal(validateMontage(run([], assets), { assets } as any).ok, true);
  const filler = { ...sparse, events: [event("car", "weapon", 10, 14)] };
  assert.equal(validateMontage(filler, { assets } as any).ok, false);
  const invalid = { ...sparse, events: [event("car", "car", 3, 30)] };
  assert.equal(validateMontage(invalid, { assets } as any).ok, false);
});

test("one explanatory card can span adjacent relevant clauses, stopping before the author", () => {
  const p = run([event("diagram", "car", 8, 13)], [asset("diagram", { car: 3, weapon: 3 })]);
  assert.equal(p.events.length, 1);
  assert.equal(p.events[0].end, 13);
});

test("an exact minimum-length placement survives decimal timestamp rounding", () => {
  const events = [event("gun", "weapon", 17.5, 19.9)];
  const p = refineMontage({
    montage: { version: 3, duration: 25, events, stats: computeStats(events, 25, []) },
    pack: { assets: [asset("gun", { weapon: 3 })] } as any,
    beats: [{ id: "weapon", text: "Показываем игрушечный пистолет", visualNeed: "GENERAL" }],
    needs: [], duration: 25,
    words: [{ word: "Показываем", start: 17.5, end: 18 }, { word: "игрушечный", start: 18, end: 18.5 }, { word: "пистолет", start: 18.5, end: 19 }],
  }).plan;
  assert.equal(p.events.length, 1);
});

test("general object research does not require the story brand or incident year", () => {
  const research: any = { kind: "NEWS_EVENT", topic: "robotaxi", eventYear: 2026, entities: [{ id: "w", name: "Waymo", aliases: [] }] };
  const need: any = { intent: "GENERAL", entities: [], visualDescription: "A close-up product photograph of a toy gel blaster with gel beads." };
  assert.ok(beatQueries(research, need).every(q => !/Waymo|2026/.test(q)));
  const subject = { title: "Toy gel blaster product", sourceUrl: "https://example.com/toy" };
  assert.equal(verifyNeedImageSource(subject, research, need).ok, true);
  assert.equal(verifyNeedImageSource({ title: "Waymo car on a street", sourceUrl: "https://example.com/car" }, research, need).ok, false);
  assert.equal(verifyNeedImageSource(subject, research, { ...need, intent: "EXACT_EVENT" }).ok, false);
});
