import test from "node:test";
import assert from "node:assert/strict";
import { planStory, planPatch, storyFromRaw, phrasesFromWords, scopeFromIssues, applyPatch, reviewEvidence } from "../lib/aiFilm/story";
import { planFilm } from "../lib/aiFilm/run";
import { loadCharacterProfile } from "../lib/aiFilm/character";
import { loadUniverseProfile } from "../lib/aiFilm/universe";
import { auditPlan } from "../lib/aiFilm/audit";
import { retryIssues, planCompletion } from "../lib/aiFilm/criteria";
import { reviewCompiledPlan } from "../lib/aiFilm/editorialReview";

const words = [
  { word: "Сначала.", start: 0, end: 5 },
  { word: "Потом.", start: 5, end: 10 },
];
const character = loadCharacterProfile();
const universe = loadUniverseProfile();
const args = { words, script: "Сначала. Потом.", character, universe, duration: 10, skipEditorialReview: true,
  coverage: { target: 0.5, max: 0.7 }, researchFacts: ["Сотрудник остановил автомобиль; алгоритм не принимал это решение."],
};
const raw = { bible: { storyType: "explainer", events: [], visualTasks: [] }, beats: [
  { fromPhrase: 1, toPhrase: 1, displayMode: "full_ai", visualAction: "a ball rolls across a table", keyMoment: "the ball reaches the edge", location: "a room", gudiniVisible: false },
  { fromPhrase: 2, toPhrase: 2, displayMode: "author" },
] };

test("a saved blocked plan remains reviewable but is never announced as ready", () => {
  const issue = { code: "editorial-quality", beatIds: ["B1"], message: "Unworkable action" };
  assert.equal(planCompletion({ issues: [{ ...issue, severity: "block" }] }).status, "failed");
  assert.equal(planCompletion({ issues: [{ ...issue, severity: "block" }] }).step, "План требует доработки");
  assert.equal(planCompletion({ issues: [{ ...issue, severity: "warn" }] }).status, "planned");
});

test("an unavailable editor stops before creative repair; casting feedback opens the role scope", async () => {
  let calls = 0;
  const result = await planFilm({ ...args, skipEditorialReview: false,
    cfg: { key: "editor-unavailable", universe, budgetUsd: 12, maxCoverage: 0.7, concurrency: 1, callMinutes: 2 },
    complete: async () => { calls++; return JSON.stringify(raw); },
    reviewComplete: async () => { throw new Error("usage limit reached"); },
  });
  assert.equal(calls, 1);
  assert.ok(result.plan.issues.some(i => i.code === "editorial-review-failed"));
  const parsed = storyFromRaw(raw, { ...args, phrases: phrasesFromWords(words) });
  const scope = scopeFromIssues([{ code: "editorial-roles", beatIds: ["B1"] }], parsed.beats, parsed.bible, raw, 2);
  assert.equal(scope.roles, true);
});

test("independent editor sees compiled shots, sends actionable notes into repair, and checks the result", async () => {
  let reviews = 0;
  let repairPrompt = "";
  const result = await planFilm({ ...args, skipEditorialReview: false,
    cfg: { key: "editorial", universe, budgetUsd: 12, maxCoverage: 0.7, concurrency: 1, callMinutes: 2 },
    complete: async ({ retry, user }) => {
      if (!retry) return JSON.stringify(raw);
      repairPrompt = user;
      return "{}";
    },
    reviewComplete: async ({ user }) => {
      reviews++;
      assert.ok(user.includes('"shots"'));
      assert.ok(user.includes('"deadlines"'));
      return JSON.stringify({ issues: [{ severity: "block", beatIds: ["B1"], message: "The action deadline is too short; start the movement earlier." }] });
    },
  });
  assert.equal(reviews, 2);
  assert.match(repairPrompt, /ПОСЛЕ СБОРКИ/);
  assert.match(repairPrompt, /action deadline is too short/);
  assert.ok(result.plan.issues.some(i => i.code === "editorial-quality" && i.severity === "block"));
  const invalid = await reviewCompiledPlan({ plan: result.plan, script: args.script, facts: [], complete: async () => '{"issues":[{"severity":"warn","beatIds":["NOT-A-BEAT"],"message":"change it"}]}' });
  assert.ok(invalid.issues.some(i => i.code === "editorial-review-failed" && i.severity === "block"));
});

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

test("a useful three-second illustration survives compilation without inventing an event", () => {
  const shortWords = [{ word: "Начало.", start: 0, end: 5 }, { word: "Камера.", start: 5, end: 8 }, { word: "Конец.", start: 8, end: 13 }];
  const source = { bible: { storyType: "explainer", events: [], visualTasks: [{ id: "camera", role: "illustration", learns: "Камера фиксирует салон", fromPhrase: 2, toPhrase: 2, action: "Hold on a cabin camera lens" }] }, beats: [
    { fromPhrase: 1, toPhrase: 1, displayMode: "author" },
    { fromPhrase: 2, toPhrase: 2, displayMode: "full_ai", visualTask: "camera", visualAction: "Hold on a cabin camera lens", keyMoment: "The lens and mount are distinguishable", hold: "read", gudiniVisible: false },
    { fromPhrase: 3, toPhrase: 3, displayMode: "author" },
  ] };
  const parsed = storyFromRaw(source, { words: shortWords, phrases: phrasesFromWords(shortWords), duration: 13, character, universe });
  assert.ok(parsed.beats.some(b => b.displayMode === "full_ai" && b.visualTask === "camera"));
  assert.equal(parsed.bible.events.length, 0);
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

test("a review of a merged author window can repair the original insert lost inside it", () => {
  const source = { bible: {}, beats: [
    { fromPhrase: 1, toPhrase: 1, displayMode: "author" },
    { fromPhrase: 2, toPhrase: 2, displayMode: "full_ai", visualTask: "detail" },
    { fromPhrase: 3, toPhrase: 4, displayMode: "author" },
  ] };
  const bible: any = { events: [], visualTasks: [{ id: "detail", fromPhrase: 2, toPhrase: 2, start: 5, end: 8, role: "illustration" }] };
  const beats: any = [{ id: "B3", sourceIndex: 2, start: 5, end: 20, displayMode: "author", eventIds: [] }];
  const scope = scopeFromIssues([{ code: "editorial-quality", beatIds: ["B3"] }], beats, bible, source, 4);
  assert.ok(scope.beats.has("2-2"));
  assert.ok(scope.tasks.has("detail"));
  assert.ok(!scope.beats.has("1-1"));
});

test("format repair cannot silently bypass documentary evidence review or make a third call", async () => {
  let calls = 0;
  const result = await planFilm({ ...args,
    cfg: { key: "repair-documentary", universe, budgetUsd: 12, maxCoverage: 0.7, concurrency: 1, callMinutes: 2 },
    complete: async () => ++calls === 1 ? '{"bible":{}}' : JSON.stringify({ ...raw, bible: { ...raw.bible, storyType: "news" } }),
  });
  assert.equal(calls, 2);
  assert.ok(result.plan.issues.some(i => i.code === "correction-failed" && i.severity === "block"));
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

test("an incompatible role requires separate casting, not switching to another role", () => {
  for (const role of ["child", "elderly woman", "teenage passenger"]) {
    const source = { bible: { ...raw.bible, playedByGudini: role }, beats: [{ ...raw.beats[0], gudiniVisible: true }] };
    const parsed = storyFromRaw(source, { ...args, phrases: phrasesFromWords(words) });
    const scope = scopeFromIssues([{ code: "role-miscast", beatIds: ["B1"] }], parsed.beats, parsed.bible, source, 2, character.name);
    assert.equal(scope.recastCharacter, true);
    const result = applyPatch(source, { bible: { playedByGudini: "another incompatible role" }, beats: { replace: source.beats } }, scope);
    assert.ok(result.rejected.length);
    assert.equal(result.raw.bible?.playedByGudini, role);
  }
});

test("evidence review is mandatory for documentary genres and does not block fiction or explainers", async () => {
  const fact = "Мяч перекатился с середины стола на край.";
  const event = { id: "ball", observable: "a ball rolls to the table edge", required: true, fromPhrase: 1, toPhrase: 1, basis: "confirmed", basisFact: fact, objects: [{ id: "ball", before: "ball at centre", after: "ball at edge", role: "change" }] };
  for (const storyType of ["news", "history", "fiction", "explainer"]) {
    const source = { ...raw, bible: { ...raw.bible, storyType, events: [event] } };
    const result = await planFilm({ ...args, researchFacts: [fact],
      cfg: { key: `genres-${storyType}`, universe, budgetUsd: 12, maxCoverage: 0.7, concurrency: 1, callMinutes: 2 },
      complete: async ({ retry }) => !retry ? JSON.stringify(source) : JSON.stringify({ evidenceReview:
        ["news", "history"].includes(storyType) ? [{ eventId: "ball", verdict: "supported", quote: fact, reason: "Same physical outcome" }] : [],
      }),
    });
    assert.notEqual(result.correction.kind, "failed", storyType);
  }
});

test("source-grounded review revises both candidates, not just the corrected one", async () => {
  const fact = "Камера записала происшествие внутри автомобиля.";
  const event = { id: "camera", observable: "camera reorients toward the object", required: true, fromPhrase: 1, toPhrase: 1, basis: "confirmed", basisFact: fact, objects: [{ id: "camera", before: "lens forward", after: "lens toward the object", role: "change" }] };
  const source = { bible: { ...raw.bible, storyType: "news", events: [event] }, beats: [{ ...raw.beats[0], eventIds: ["camera"], objects: event.objects, visualAction: "the camera swivels toward the object", keyMoment: "lens oriented toward the object" }, raw.beats[1]] };
  const findings = [{ eventId: "camera", quote: fact, reason: "Recording does not establish that the lens moved or recognized anything" }];
  let calls = 0;
  const result = await planFilm({ ...args, researchFacts: [fact],
    cfg: { key: "review", universe, budgetUsd: 12, maxCoverage: 0.7, concurrency: 1, callMinutes: 2 },
    complete: async () => ++calls === 1 ? JSON.stringify(source) : JSON.stringify({ evidenceReview: findings.map(f => ({ ...f, verdict: "unsupported-mechanism" })), beats: { replace: [{ fromPhrase: 1, toPhrase: 1, displayMode: "author", gudiniVisible: false, eventIds: [], objects: [], visualAction: "", keyMoment: "" }] } }),
  });
  assert.equal(calls, 2);
  assert.ok(result.candidates.first.issues.some(i => i.code === "invented-mechanism"));
  assert.ok(!result.plan.issues.some(i => i.severity === "block"));
  assert.equal(result.accepted, true);
  assert.throws(() => reviewEvidence(source, { unsupportedMechanisms: [{ ...findings[0], quote: "not an input fact" }] }, [fact]), /exact input fact/);
  assert.throws(() => reviewEvidence(source, { evidenceReview: [] }, [fact]), /omitted events/);
  assert.throws(() => reviewEvidence(source, { evidenceReview: [1, 2].map(() => ({ ...findings[0], verdict: "supported" as const })) }, [fact]), /exactly once/);
  assert.equal(source.bible.events[0].basis, "confirmed", "source evidence must stay unchanged");
});

test("a documentary plan is not marked ready when its evidence review fails", async () => {
  let calls = 0;
  const result = await planFilm({ ...args,
    cfg: { key: "review-failure", universe, budgetUsd: 12, maxCoverage: 0.7, concurrency: 1, callMinutes: 2 },
    complete: async () => { if (++calls === 1) return JSON.stringify({ ...raw, bible: { ...raw.bible, storyType: "news" } }); throw new Error("unavailable"); },
  });
  assert.equal(calls, 2);
  assert.ok(result.plan.issues.some(i => i.code === "correction-failed" && i.severity === "block"));
});

test("an unresolved reviewed mechanism falls back to the recording without hiding a physical obligation", async () => {
  const fact = "Камера записала происшествие внутри автомобиля.";
  const event = { id: "camera", observable: "camera reorients toward the object", required: true, fromPhrase: 1, toPhrase: 1, basis: "confirmed", basisFact: fact, objects: [{ id: "camera", before: "lens forward", after: "lens toward the object", role: "change" }] };
  const physical = { id: "parcel", observable: "a courier hands a parcel to a woman", required: true, fromPhrase: 1, toPhrase: 1, basis: "told", objects: [{ id: "parcel", before: "parcel in the courier's hands", after: "parcel in the woman's hands", role: "change" }] };
  for (const mixed of [false, true]) {
    const source = { bible: { ...raw.bible, storyType: "news", events: [event, ...(mixed ? [physical] : [])] }, beats: [{ ...raw.beats[0], eventIds: mixed ? ["camera", "parcel"] : ["camera"], objects: event.objects, visualAction: "the camera swivels toward the object", keyMoment: "lens oriented toward the object" }, raw.beats[1]] };
    const result = await planFilm({ ...args, researchFacts: [fact],
      cfg: { key: "evidence-fallback", universe, budgetUsd: 12, maxCoverage: 0.7, concurrency: 1, callMinutes: 2 },
      complete: async ({ retry }) => !retry ? JSON.stringify(source) : JSON.stringify({ evidenceReview: [
        { eventId: "camera", verdict: "unsupported-mechanism", quote: fact, reason: "Recording does not establish recognition" },
        ...(mixed ? [{ eventId: "parcel", verdict: "illustration", quote: "", reason: "Physical handover remains required" }] : []),
      ] }),
    });
    if (mixed) {
      assert.ok(result.plan.beats.some(b => b.displayMode !== "author" && b.eventIds?.includes("parcel")));
      assert.ok(result.plan.issues.some(i => i.severity === "block"));
    } else {
      assert.equal(result.plan.beats[0].displayMode, "author");
      assert.ok(!result.plan.issues.some(i => i.severity === "block"));
      assert.ok(result.correction.applied.some(line => line.includes("автор")));
      assert.equal(result.candidates.first.beats[0].displayMode, "full_ai");
    }
  }
});
