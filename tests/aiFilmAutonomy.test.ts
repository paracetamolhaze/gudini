import test from "node:test";
import assert from "node:assert/strict";
import { planStory, planPatch, storyFromRaw, phrasesFromWords, scopeFromIssues, applyPatch } from "../lib/aiFilm/story";
import { planFilm } from "../lib/aiFilm/run";
import { loadCharacterProfile } from "../lib/aiFilm/character";
import { loadUniverseProfile } from "../lib/aiFilm/universe";
import { auditPlan } from "../lib/aiFilm/audit";
import { retryIssues } from "../lib/aiFilm/criteria";

const words = [
  { word: "Сначала.", start: 0, end: 5 },
  { word: "Потом.", start: 5, end: 10 },
];
const character = loadCharacterProfile();
const universe = loadUniverseProfile();
const args = { words, script: "Сначала. Потом.", character, universe, duration: 10,
  coverage: { target: 0.5, max: 0.7 }, researchFacts: ["Сотрудник остановил автомобиль; алгоритм не принимал это решение."],
};
const raw = { bible: { storyType: "explainer", events: [], visualTasks: [] }, beats: [
  { fromPhrase: 1, toPhrase: 1, displayMode: "full_ai", visualAction: "a ball rolls across a table", keyMoment: "the ball reaches the edge", location: "a room", gudiniVisible: false },
  { fromPhrase: 2, toPhrase: 2, displayMode: "author" },
] };

test("both model calls receive the exact evidence used by the validator", async () => {
  let first = "", retry = "";
  await planStory({ ...args, complete: async ({ user }) => { first = user; return JSON.stringify(raw); } });
  await planPatch({ ...args, first: raw, remarks: ["fix scene"], complete: async ({ user }) => { retry = user; return "{}"; } });
  for (const prompt of [first, retry]) assert.ok(prompt.includes(args.researchFacts[0]), "evidence missing from model input");
});

test("correction system requests patches rather than a competing complete-plan response", async () => {
  let system = "";
  await planPatch({ ...args, first: raw, remarks: ["fix scene"], complete: async (a) => { system = a.system; return "{}"; } });
  assert.ok(!system.includes('"beats": [{"fromPhrase"'), "system still requires full-plan JSON");
  assert.match(system, /ИЗМЕНЕНИЯ/);
});

test("a valid JSON fragment without beats cannot become a successful author-only plan", () => {
  assert.throws(() => storyFromRaw({ bible: {} }, { ...args, phrases: phrasesFromWords(words) }), /бит|beat|структур/i);
});

test("a failed optional correction preserves the first candidate and never adds a third call", async () => {
  let calls = 0;
  const result = await planFilm({ ...args,
    cfg: { key: "autonomy", universe, budgetUsd: 12, maxCoverage: 0.7, concurrency: 1, callMinutes: 2 },
    complete: async ({ retry }) => { calls++; if (retry) throw new Error("provider unavailable"); return JSON.stringify(raw); },
  });
  assert.equal(calls, 2);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.plan.shots, result.candidates.first.shots);
  assert.ok(result.plan.issues?.some((i) => i.code === "correction-failed"));
});

test("malformed first output is repaired once within the same two-call budget", async () => {
  let calls = 0;
  const result = await planFilm({ ...args,
    cfg: { key: "repair", universe, budgetUsd: 12, maxCoverage: 0.7, concurrency: 1, callMinutes: 2 },
    complete: async ({ retry }) => { calls++; if (calls === 1) return '{"bible":{}}'; assert.equal(retry, true); return JSON.stringify(raw); },
  });
  assert.equal(calls, 2);
  assert.ok(result.plan.beats.length);
});

test("an object-addressed issue opens its containing scene for correction", () => {
  const parsed = storyFromRaw(raw, { ...args, phrases: phrasesFromWords(words) });
  const scope = scopeFromIssues([{ code: "phase-conflict", beatIds: ["B1/ball"] }], parsed.beats, parsed.bible, raw, 2);
  assert.ok(scope.beats.has("1-1"));
});

test("presence checks use the cast as well as the action and send ambiguity to correction", () => {
  const parsed = storyFromRaw(raw, { ...args, phrases: phrasesFromWords(words) });
  const beat = { ...parsed.beats[0], gudiniVisible: true, scene: { who: character.name, props: [], worn: [], mechanics: "" } };
  assert.ok(!auditPlan([beat], parsed.bible, character).some(i => i.code === "hero-flag-mismatch"));
  const issues = auditPlan([{ ...beat, scene: { ...beat.scene, who: "a man" } }], parsed.bible, character);
  assert.ok(retryIssues({ issues }).some(i => i.code === "hero-flag-mismatch"));
});

test("separate starting clauses do not combine into an invented completed handover", () => {
  const parsed = storyFromRaw(raw, { ...args, phrases: phrasesFromWords(words) });
  const beat = { ...parsed.beats[0], stateBefore: "envelope held only by the woman, courier's hand empty and approaching", camera: "static medium shot", objects: [{ id: "envelope", before: "sealed envelope resting in the woman's hand", after: "sealed envelope held in the courier's hand", role: "change" as const }], scene: { who: "the woman and courier", props: ["sealed envelope"], worn: [], mechanics: "" } };
  assert.ok(!auditPlan([beat], parsed.bible, character).some(i => i.code === "phase-conflict"));
});

test("recasting a repeated role opens every appearance and cannot change only half the story", () => {
  const source = { bible: { ...raw.bible, playedByGudini: "courier" }, beats: [1, 2].map(n => ({ ...raw.beats[0], fromPhrase: n, toPhrase: n, gudiniVisible: true, visualAction: `${character.name} carries a parcel` })) };
  const parsed = storyFromRaw(source, { ...args, phrases: phrasesFromWords(words) });
  const scope = scopeFromIssues([{ code: "costume-conflict", beatIds: ["B1"] }], parsed.beats, parsed.bible, source, 2, character.name);
  assert.ok(scope.beats.has("2-2"), "the later appearance also needs role correction");
  const patched = applyPatch(source, { bible: { playedByGudini: "" }, beats: { replace: [{ ...source.beats[0], gudiniVisible: false, visualAction: "Courier carries a parcel" }] } }, scope);
  assert.equal(patched.raw.bible?.playedByGudini, "courier", "partial recasting must not change the cast");
  assert.ok(patched.rejected.length);
});

test("an empty bench is not a damaged briefcase", () => {
  const parsed = storyFromRaw(raw, { ...args, phrases: phrasesFromWords(words) });
  const object = { id: "briefcase", before: "closed briefcase beside the man", after: "closed briefcase alone on the empty bench", role: "change" as const };
  const beats = [{ ...parsed.beats[0], objects: [object] }, { ...parsed.beats[0], id: "B2", objects: [{ ...object, before: "closed briefcase on the bench", after: "briefcase in the worker's hands" }] }];
  assert.ok(!auditPlan(beats, parsed.bible, character).some(i => i.code === "state-regression"));
});

test("an addressed optional event can be removed using an id object", () => {
  const source = { ...raw, bible: { ...raw.bible, events: [{ id: "unused", observable: "unknown method", required: false, objects: [] }] } };
  const patched = applyPatch(source, { events: { remove: [{ id: "unused" }] } }, { beats: new Set(), tasks: new Set(), events: new Set(["unused"]), roles: false, phraseCount: 2 });
  assert.equal(patched.raw.bible?.events?.length, 0);
});
