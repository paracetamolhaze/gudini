import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { beatsFromRaw, phrasesFromWords, normalizeBible } from "../lib/aiFilm/story";
import { buildFilmPlan, compilerFingerprint } from "../lib/aiFilm/plan";
import { planKey, runAiFilmStage } from "../lib/aiFilm/run";
import { betterPlan, blockingWeight, gateIssues, missingRequired, planRank, preserveRequired, requiredEvents, retryIssues } from "../lib/aiFilm/criteria";
import { loadCharacterProfile } from "../lib/aiFilm/character";
import { loadUniverseProfile } from "../lib/aiFilm/universe";
import { resetLedger } from "../lib/costLedger";
import type { AiFilmPlan, StoryEvent } from "../lib/aiFilm/types";
import type { Word } from "../lib/transcribe";

/**
 * Приёмка ворот и выбора плана: проверяется КОНЕЧНОЕ поведение — доходит ли путь генерации
 * до провайдера, а не только наличие записи в issues. Именно это отличие и пропускало
 * известное нарушение к запуску Veo.
 */

const character = loadCharacterProfile();
const universe = loadUniverseProfile();

function speech(): Word[] {
  const say = (text: string, from: number, per = 0.45): Word[] =>
    text.split(" ").map((w, i) => ({ word: w, start: from + i * per, end: from + i * per + per * 0.9 }));
  return [
    ...say("Он заказал парашют за пять долларов.", 0),
    ...say("Через неделю коробка приехала прямо к двери.", 3.2),
  ];
}

const EVENTS: StoryEvent[] = [
  { id: "order", observable: "he taps buy on the phone", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "phone", before: "listing on screen", after: "order placed" }] },
  { id: "delivery", observable: "he opens the delivered parcel", required: true, fromPhrase: 2, toPhrase: 2, objects: [{ id: "parcel", before: "sealed", after: "open and empty" }] },
];

const raw = (withCut: boolean) => [
  { fromPhrase: 1, toPhrase: 1, displayMode: "full_ai", visualAction: "Gudini taps buy on his phone", keyMoment: "the order goes through", eventIds: ["order"], objects: [{ id: "phone", before: "listing on screen", after: "order placed" }], location: "a kitchen table", cameraAngle: "eye_level", camera: "Camera is at eye level in front of him", motion: "he taps the screen" },
  { fromPhrase: 2, toPhrase: 2, displayMode: "full_ai", visualAction: withCut ? "Gudini opens the parcel, then cuts to a different parcel on the floor" : "Gudini tears open the delivered parcel", keyMoment: "the parcel opens", eventIds: ["delivery"], objects: [{ id: "parcel", before: "sealed", after: "open and empty" }], location: "a doorstep", cameraAngle: "high_angle", camera: "Camera is above the parcel looking down", motion: "he pulls the tape" },
];

function planFor(withCut: boolean): { plan: AiFilmPlan; words: Word[]; duration: number } {
  const words = speech();
  const duration = words[words.length - 1].end;
  const beats = beatsFromRaw(raw(withCut) as any, phrasesFromWords(words), duration, words);
  const bible = normalizeBible({ bible: { storyType: "explainer", events: EVENTS } } as any, character, universe);
  const key = planKey(words, "", character, universe, duration, compilerFingerprint(character, universe));
  const plan = buildFilmPlan({
    character, bible, beats, duration,
    cfg: { key, universe, budgetUsd: 12, maxCoverage: 1, concurrency: 1, callMinutes: 2 },
  });
  return { plan, words, duration };
}

/** Запускает фазу генерации с подменённым провайдером и говорит, дошёл ли до него путь. */
async function generateWith(plan: AiFilmPlan, words: Word[], duration: number, t: any): Promise<{ error: Error; called: boolean }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-gate-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); resetLedger(); });
  resetLedger();
  let called = false;
  t.mock.method(GoogleAuth.prototype, "getClient", async () => ({ getAccessToken: async () => ({ token: "test-token" }) }) as any);
  t.mock.method(globalThis, "fetch", async () => {
    called = true;
    return Response.json({ error: { message: "провайдер вызван" } }, { status: 400 });
  });
  const had = process.env.GCE_METADATA_HOST;
  process.env.GCE_METADATA_HOST = "test-metadata";
  t.after(() => { if (had == null) delete process.env.GCE_METADATA_HOST; else process.env.GCE_METADATA_HOST = had; });
  let error: Error = new Error("генерация не остановилась");
  try {
    await runAiFilmStage({
      id: "gate", dir,
      project: { script: "", aiFilm: { request: "generate", plan } } as any,
      words, duration, research: Promise.resolve(null), setStep: () => {},
    });
  } catch (e: any) {
    error = e;
  }
  return { error, called };
}

test("невыполнимое указание останавливает генерацию до провайдера", async (t) => {
  const { plan, words, duration } = planFor(true);
  assert.ok(gateIssues(plan).some((i) => i.code === "cut-inside-shot"), JSON.stringify(plan.issues));
  const { error, called } = await generateWith(plan, words, duration, t);
  assert.match(error.message, /не готов к генерации/);
  assert.match(error.message, /Veo не вызывался/);
  assert.equal(called, false, "ни одного обращения к провайдеру быть не должно");
});

test("исправный план ворота проходит и доходит до провайдера", async (t) => {
  const { plan, words, duration } = planFor(false);
  assert.deepEqual(gateIssues(plan), [], JSON.stringify(plan.issues));
  const { error, called } = await generateWith(plan, words, duration, t);
  assert.equal(called, true, `путь генерации не дошёл до провайдера: ${error.message}`);
  assert.doesNotMatch(error.message, /не готов к генерации/);
});

test("исправление и ворота смотрят на один набор нарушений", () => {
  const { plan } = planFor(true);
  const retry = retryIssues(plan).map((i) => i.code);
  const gate = gateIssues(plan).map((i) => i.code);
  for (const code of gate) assert.ok(retry.includes(code), `${code} видно воротам, но не исправлению`);
  assert.ok(gate.includes("cut-inside-shot"));
});

test("кандидат выбирается по тяжести, а не по числу строк", () => {
  const required = requiredEvents(EVENTS);
  const base = planFor(false).plan;
  const oneBlock: AiFilmPlan = {
    ...base,
    issues: [{ code: "cut-inside-shot", severity: "block", beatIds: ["B1"], message: "склейка" }],
  };
  const twoWarnings: AiFilmPlan = {
    ...base,
    issues: [
      { code: "first-scene-late", severity: "warn", beatIds: [], message: "позднее начало" },
      { code: "author-stretch-long", severity: "warn", beatIds: [], message: "длинный автор" },
    ],
  };
  assert.ok(betterPlan(twoWarnings, oneBlock, required), "план без запретов обязан выигрывать у плана с запретом");
  assert.ok(!betterPlan(oneBlock, twoWarnings, required));
  // при равенстве остаётся текущий план
  assert.ok(!betterPlan(twoWarnings, { ...twoWarnings }, required));
  // потерянное обязательное событие тяжелее любого числа предупреждений
  const lost: AiFilmPlan = { ...base, issues: [], shots: [], beats: base.beats.map((b) => ({ ...b, eventIds: [] })) };
  // потерянные обязательства идут первыми, запреты считаются по событиям, а не по строкам
  assert.deepEqual(planRank(lost, required).slice(0, 2), [2, 0]);
  assert.ok(betterPlan(twoWarnings, lost, required));
  assert.equal(missingRequired(base, required).length, 0);

  // один запрет о пяти непоказанных событиях тяжелее запрета об одном
  const five: AiFilmPlan = {
    ...base,
    issues: [{ code: "event-not-covered", severity: "block", beatIds: [], eventIds: ["a", "b", "c", "d", "e"], message: "не показаны" }],
  };
  assert.ok(blockingWeight(five) > blockingWeight(oneBlock), "вес запрета считается по событиям");
  assert.ok(betterPlan(oneBlock, five, required), "план, потерявший меньше событий, обязан выигрывать");
});

test("второй заход не может снять обязательность события", () => {
  const weakened: StoryEvent[] = EVENTS.map((e) => ({ ...e, required: false })).filter((e) => e.id !== "delivery");
  const kept = preserveRequired(EVENTS, weakened);
  assert.equal(kept.length, 2);
  for (const id of ["order", "delivery"]) {
    const e = kept.find((x) => x.id === id);
    assert.ok(e, `событие ${id} пропало при исправлении`);
    assert.equal(e!.required, true, `обязательность ${id} снята`);
  }
});

test("отпечаток реагирует на настоящие настройки покрытия", () => {
  const wide = compilerFingerprint(character, universe, { target: 0.5, max: 0.65 });
  const narrow = compilerFingerprint(character, universe, { target: 0.3, max: 0.4 });
  assert.notEqual(wide, narrow, "смена ограничения покрытия обязана менять отпечаток");
  const had = process.env.AI_FILM_TARGET_COVERAGE;
  try {
    process.env.AI_FILM_TARGET_COVERAGE = "0.3";
    assert.notEqual(compilerFingerprint(character, universe), wide, "настройки из окружения обязаны попадать в отпечаток");
  } finally {
    if (had == null) delete process.env.AI_FILM_TARGET_COVERAGE;
    else process.env.AI_FILM_TARGET_COVERAGE = had;
  }
});
