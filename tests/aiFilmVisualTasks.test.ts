import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { compositeFilter, overlaysFor, placeWindow } from "../lib/aiFilm/composite";
import { authorStretchIssues } from "../lib/aiFilm/plan";
import { auditPlan } from "../lib/aiFilm/audit";
import { normalizeBible } from "../lib/aiFilm/story";
import { loadCharacterProfile } from "../lib/aiFilm/character";
import { loadUniverseProfile } from "../lib/aiFilm/universe";
import type { AiFilmPlan, StoryBeat, TimelineSegment, VisualTask } from "../lib/aiFilm/types";

/**
 * Постановка всей истории, а не предмет под каждую реплику: визуальные задачи, повторы понимания,
 * ритм с авторскими кусками. И точка входа в клип, независимая от места вставки на таймлайне.
 */

const universe = loadUniverseProfile("gudini-photoreal", path.join(process.cwd(), "assets", "ai-film", "universes"));
const character = { ...loadCharacterProfile("gudini-real", path.join(process.cwd(), "assets", "ai-film", "characters")), referenceFiles: ["/tmp/ref.png"] };

const beat = (id: string, start: number, end: number, over: Partial<StoryBeat> = {}): StoryBeat => ({
  id, start, end, meaning: "", storyBeat: "", displayMode: "full_ai", purpose: "explain", priority: "high",
  requiresGeneration: true, gudiniVisible: false, universeAdaptation: "", visualAction: "a man walks along a fence",
  keyMoment: "the fence line is visible", anchorPhrase: "", hold: "settle", anchorAtSec: null, anchorAbsSec: null,
  eventIds: [], objects: [], location: "a field", motion: "he walks", stateBefore: "", stateAfter: "",
  continuityGroup: null, continuityRequired: false, transition: "cut", shotType: "medium", frameSubject: "",
  camera: "Camera is at eye level beside the fence", cameraAngle: "eye_level", composition: "center", suggestedDuration: end - start,
  ...over,
});

test("точка входа в клип не зависит от места вставки на таймлайне", () => {
  const groups = [{ id: "G4", start: 41.16, end: 49.16 }];
  const clip = { groupId: "G4", file: "g4.mp4", seconds: 8 };
  const seg: TimelineSegment = { start: 43.56, end: 46.8, mode: "full_ai", groupId: "G4", beatIds: ["B6"], clipIn: 0 };
  const planWith = (s: TimelineSegment) => ({ groups, timeline: [s] }) as unknown as AiFilmPlan;
  const filter = compositeFilter("scale=1080:1920", overlaysFor(planWith(seg), [clip]), planWith(seg), 1);
  // материал берётся с нулевой секунды клипа, хотя группа начиналась на 41.16 с
  assert.match(filter, /trim=start=0\.000:duration=3\.240/);
  assert.match(filter, /setpts=PTS-STARTPTS\+43\.560\/TB/);
  // без точки входа поведение прежнее: смещение от начала группы
  const legacy = { ...seg, clipIn: undefined };
  assert.match(compositeFilter("scale=1080:1920", overlaysFor(planWith(legacy), [clip]), planWith(legacy), 1), /trim=start=2\.400:duration=3\.240/);
  // окну не хватает материала клипа — ошибка до рендера
  assert.throws(() => overlaysFor(planWith({ ...seg, clipIn: 6 }), [clip]), /берёт клип/);
});

test("окно ставится на таймлайн, промежутки уходят автору", () => {
  const timeline: TimelineSegment[] = [
    { start: 0, end: 8, mode: "full_ai", groupId: "G1", beatIds: ["B1"] },
    { start: 8, end: 41.16, mode: "author", beatIds: [] },
    { start: 41.16, end: 49.16, mode: "full_ai", groupId: "G4", beatIds: ["B6"] },
    { start: 49.16, end: 66.87, mode: "author", beatIds: [] },
  ];
  const out = placeWindow(timeline, 66.87, { start: 43.56, end: 46.8, mode: "full_ai", groupId: "G4", beatIds: ["B6"], clipIn: 0 });
  assert.deepEqual(out.map((s) => [s.start, s.end, s.mode, s.clipIn ?? null]), [
    [0, 8, "full_ai", null],
    [8, 43.56, "author", null],
    [43.56, 46.8, "full_ai", 0],
    [46.8, 66.87, "author", null],
  ]);
  assert.throws(() => placeWindow(timeline, 66.87, { start: 6, end: 9, mode: "full_ai", groupId: "G4", beatIds: [], clipIn: 0 }), /пересекается/);
});

test("ритм: мелькающий автор замечается, длинное объяснение не гонит в заполнитель", () => {
  const tl: TimelineSegment[] = [
    { start: 0, end: 8, mode: "full_ai", groupId: "G1", beatIds: [] },
    { start: 8, end: 9.5, mode: "author", beatIds: [] },
    { start: 9.5, end: 16, mode: "full_ai", groupId: "G2", beatIds: [] },
    { start: 16, end: 40, mode: "author", beatIds: [] },
    { start: 40, end: 46, mode: "full_ai", groupId: "G3", beatIds: [] },
  ];
  const plain = authorStretchIssues(tl, 46).map((i) => i.code);
  assert.ok(plain.includes("author-flicker"), plain.join(","));
  assert.ok(plain.includes("author-stretch-long"), plain.join(","));
  const explained = authorStretchIssues(tl, 46, [{ start: 17, end: 39 }]).map((i) => i.code);
  assert.ok(explained.includes("author-stretch-explained"), explained.join(","));
  assert.ok(!explained.includes("author-stretch-long"), explained.join(","));
});

test("визуальные задачи: заполнитель, повтор понимания и сцена поверх объяснения", () => {
  const bible = normalizeBible({ bible: { storyType: "explainer" } } as any, character, universe);
  const tasks: VisualTask[] = [
    { id: "place", learns: "где стоит мастерская и насколько она большая", role: "illustration", fromPhrase: 1, toPhrase: 1, action: "a man walks into the workshop" },
    { id: "repair", learns: "старую цепь снимают и ставят новую", role: "event", fromPhrase: 2, toPhrase: 2, action: "hands swap the chain" },
    { id: "price", learns: "сколько стоил ремонт", role: "explanation", fromPhrase: 3, toPhrase: 3, action: "" },
    { id: "place-again", learns: "насколько большая мастерская и где она стоит", role: "illustration", fromPhrase: 4, toPhrase: 4, action: "a wide view of the workshop" },
  ];
  const got = auditPlan(
    [
      beat("B1", 0, 6, { visualTask: "place" }),
      beat("B2", 6, 12, { visualTask: "place" }),
      beat("B3", 12, 18, { visualTask: "price", visualAction: "a clerk stamps the invoice on the counter", keyMoment: "the stamp lands on the invoice" }),
      beat("B4", 18, 24),
    ],
    { ...bible, visualTasks: tasks },
    character,
  ).map((i) => i.code);
  for (const code of ["repeated-visual-task", "explanation-faked-proof", "scene-without-visual-task", "duplicate-visual-tasks"]) {
    assert.ok(got.includes(code), `${code}: ${got.join(",")}`);
  }
  // одна непрерывная сцена в цепочке клипов повтором не считается
  const chain = auditPlan(
    [beat("B1", 0, 8, { visualTask: "repair", continuityGroup: "c1" }), beat("B2", 8, 14, { visualTask: "repair", continuityGroup: "c1" })],
    { ...bible, visualTasks: tasks },
    character,
  ).map((i) => i.code);
  assert.ok(!chain.includes("repeated-visual-task"), chain.join(","));
  // план без визуальных задач этими проверками не судится: у него своё замечание во втором заходе
  const legacy = auditPlan([beat("B1", 0, 6)], bible, character).map((i) => i.code);
  assert.ok(!legacy.some((c) => /visual-task|explanation-staged/.test(c)), legacy.join(","));
});

test("обязательное для понимания не обязательно к показу: объяснение несёт автор", async () => {
  const { authorCarriedEvents, missingRequired } = await import("../lib/aiFilm/criteria");
  const bible = normalizeBible({ bible: { storyType: "explainer" } } as any, character, universe);
  const denied = {
    id: "exemption-denied", observable: "the exemption is denied", required: true, fromPhrase: 3, toPhrase: 4,
    objects: [{ id: "exemption", before: "requested", after: "denied", role: "change" as const }],
  };
  const tasks: VisualTask[] = [
    { id: "place", learns: "где всё происходит", role: "illustration", fromPhrase: 1, toPhrase: 2, action: "a wide view of the place" },
    { id: "why-denied", learns: "почему льготу не дали", role: "explanation", fromPhrase: 3, toPhrase: 4, action: "" },
  ];
  const withTasks = { ...bible, events: [denied], visualTasks: tasks };
  assert.deepEqual(authorCarriedEvents(withTasks), ["exemption-denied"]);
  const beats = [beat("B1", 0, 6, { visualTask: "place" })];
  const carried = auditPlan(beats, { ...withTasks, authorCarried: ["exemption-denied"] }, character).map((i) => i.code);
  assert.ok(carried.includes("event-carried-by-author"), carried.join(","));
  assert.ok(!carried.includes("event-not-covered"), carried.join(","));
  assert.deepEqual(missingRequired({ beats, shots: [], bible: { authorCarried: ["exemption-denied"] } } as any, [denied]), []);
  // без объяснения то же событие по-прежнему обязано быть показано
  const plain = { ...bible, events: [denied], visualTasks: [tasks[0]] };
  assert.deepEqual(authorCarriedEvents(plain), []);
  assert.ok(auditPlan(beats, plain, character).map((i) => i.code).includes("event-not-covered"));
});

test("объяснение без learns не выбрасывается: его роль решает ритм", () => {
  const bible = normalizeBible(
    { bible: { storyType: "explainer", visualTasks: [
      { id: "place", learns: "где всё происходит", role: "illustration", fromPhrase: 1, toPhrase: 1, action: "a wide view" },
      { id: "law", role: "explanation", fromPhrase: 2, toPhrase: 3 },
      { id: "junk", role: "illustration", fromPhrase: 4, toPhrase: 4, action: "something" },
    ] } } as any,
    character,
    universe,
  );
  assert.deepEqual((bible.visualTasks ?? []).map((t) => t.id), ["place", "law"]);
  assert.equal(bible.visualTasks![1].role, "explanation");
});

test("метка «объяснение» не снимает показ события с предметом", async () => {
  const { authorCarriedEvents } = await import("../lib/aiFilm/criteria");
  const { voiceOnlyEvent } = await import("../lib/aiFilm/audit");
  const bible = normalizeBible({ bible: { storyType: "explainer" } } as any, character, universe);
  const physical = [
    { id: "tear", observable: "the main canopy tears open above him", required: true, fromPhrase: 2, toPhrase: 3, objects: [{ id: "main-canopy", before: "intact and inflated", after: "torn along a seam", role: "change" as const }] },
    { id: "delivery", observable: "the courier hands over the parcel", required: true, fromPhrase: 2, toPhrase: 3, objects: [{ id: "parcel", before: "in the courier hands", after: "in his hands", role: "change" as const }] },
    { id: "sign", observable: "the device screen shows a signed confirmation", required: true, fromPhrase: 2, toPhrase: 3, objects: [{ id: "hardware-wallet", before: "screen showing an unsigned prompt", after: "screen showing a signed confirmation", role: "change" as const }] },
    { id: "keys", observable: "the keys pass to the buyer", required: true, fromPhrase: 2, toPhrase: 3, objects: [{ id: "keys-owner", before: "the seller", after: "the buyer", role: "change" as const }] },
  ];
  const voiced = [
    { id: "denied", observable: "the cemetery tax exemption is denied because the club is registered as an ordinary LLC", required: true, fromPhrase: 2, toPhrase: 3, objects: [{ id: "exemption", before: "requested", after: "denied", role: "change" as const }] },
    { id: "farm-status", observable: "the parcel is classified as farmland for tax purposes", required: true, fromPhrase: 2, toPhrase: 3, objects: [{ id: "land-status", before: "taxed as golf course", after: "taxed as farmland", role: "change" as const }] },
  ];
  for (const e of physical) assert.equal(voiceOnlyEvent(e), false, e.id);
  for (const e of voiced) assert.equal(voiceOnlyEvent(e), true, e.id);
  const tasks: VisualTask[] = [{ id: "why", learns: "почему так вышло", role: "explanation", fromPhrase: 2, toPhrase: 3, action: "" }];
  // разрыв купола, объявленный объяснением, остаётся обязательным к показу и получает своё замечание
  const hidden = { ...bible, events: [physical[0]], visualTasks: tasks };
  assert.deepEqual(authorCarriedEvents(hidden), []);
  const codes = auditPlan([beat("B1", 0, 6, { visualTask: "why", visualAction: "a wide view of the airfield" })], hidden, character).map((i) => i.code);
  assert.ok(codes.includes("explanation-hides-event"), codes.join(","));
  assert.ok(codes.includes("event-not-covered"), codes.join(","));
  // отказ в льготе под объяснением честно уходит голосу
  assert.deepEqual(authorCarriedEvents({ ...bible, events: [voiced[0]], visualTasks: tasks }), ["denied"]);
});

test("две сцены одной задачи допустимы, когда вторая добавляет новое", () => {
  const bible = normalizeBible({ bible: { storyType: "explainer" } } as any, character, universe);
  const tasks: VisualTask[] = [{ id: "grave", learns: "могила стоит прямо у лунки на поле", role: "event", fromPhrase: 1, toPhrase: 2, action: "a grave marker stands beside the flagged hole" }];
  const withTasks = { ...bible, visualTasks: tasks };
  // общий план и деталь: разные решающие моменты, не повтор
  const develops = auditPlan(
    [
      beat("B1", 0, 6, { visualTask: "grave", shotType: "wide", keyMoment: "the grave marker stands on the fairway a few meters from the flagged hole", frameSubject: "the marker and the hole together" }),
      beat("B2", 6, 12, { visualTask: "grave", shotType: "close", keyMoment: "the engraved name on the marker with the golf flag blurred behind it", frameSubject: "the engraved face of the marker" }),
    ],
    withTasks,
    character,
  ).map((i) => i.code);
  assert.ok(!develops.includes("repeated-visual-task"), develops.join(","));
  // тот же момент с другого ракурса: повтор
  const repeats = auditPlan(
    [
      beat("B1", 0, 6, { visualTask: "grave", cameraAngle: "eye_level", keyMoment: "the grave marker stands on the fairway beside the flagged hole", frameSubject: "the grave marker beside the flagged hole" }),
      beat("B2", 6, 12, { visualTask: "grave", cameraAngle: "high_angle", keyMoment: "the grave marker standing on the fairway beside the flagged hole", frameSubject: "the grave marker beside the flagged hole" }),
    ],
    withTasks,
    character,
  ).map((i) => i.code);
  assert.ok(repeats.includes("repeated-visual-task"), repeats.join(","));
});

test("под объяснение допустима помогающая иллюстрация, но не выдуманное доказательство", () => {
  const bible = normalizeBible({ bible: { storyType: "explainer" } } as any, character, universe);
  const tasks: VisualTask[] = [{ id: "tax-sum", learns: "сколько вышло налога", role: "explanation", fromPhrase: 1, toPhrase: 2, action: "" }];
  const withTasks = { ...bible, visualTasks: tasks };
  const helps = auditPlan(
    [beat("B1", 0, 6, { visualTask: "tax-sum", visualAction: "a wide view of the fairways stretching to the horizon under flat daylight", keyMoment: "the sheer size of the grounds is visible in one frame" })],
    withTasks,
    character,
  ).map((i) => i.code);
  assert.ok(!helps.some((c) => c.startsWith("explanation-")), helps.join(","));
  const fakes = auditPlan(
    [beat("B1", 0, 6, { visualTask: "tax-sum", visualAction: "a clerk lays a tax bill on the desk and points at the printed amount", keyMoment: "the printed amount on the tax bill" })],
    withTasks,
    character,
  ).map((i) => i.code);
  assert.ok(fakes.includes("explanation-faked-proof"), fakes.join(","));
});

test("присутствие персонажа следует из того, кто назван в кадре", async () => {
  const { reconcileParticipants } = await import("../lib/aiFilm/story");
  const bible = { supportingCharacters: [{ name: "Estate clerk", function: "witness" as const, appearance: "a man in a grey suit" }] };
  const beats = [
    beat("B1", 0, 6, { gudiniVisible: true, visualAction: "Donald Trump walks slowly along the driveway toward the clubhouse entrance, seen from behind", scene: { who: "Donald Trump on the driveway", worn: ["a dark suit"] } }),
    beat("B2", 6, 12, { gudiniVisible: true, visualAction: "Gudini as Donald Trump stands on the green beside the marker", scene: { who: "Gudini beside the marker" } }),
    beat("B3", 12, 18, { gudiniVisible: true, visualAction: "he sits at the desk and opens the folder", scene: { who: "him at the desk" } }),
    beat("B4", 18, 24, { gudiniVisible: false, visualAction: "Gudini opens the box on the table", scene: { who: "Gudini at the table" } }),
    beat("B5", 24, 30, { gudiniVisible: true, visualAction: "the Estate clerk stamps the folder", scene: { who: "the Estate clerk at the desk" } }),
    beat("B6", 30, 36, { gudiniVisible: true, visualAction: "a granite marker with Ivana Trump" + String.fromCharCode(39) + "s name sits in the grass, no one in frame", scene: { who: "" } }),
  ];
  const changed = reconcileParticipants(beats, bible as any, "Gudini");
  assert.deepEqual(beats.map((b) => b.gudiniVisible), [false, true, true, true, false, true], JSON.stringify(beats.map((b) => [b.id, b.gudiniVisible])));
  assert.equal(changed, 3);
  // костюм публичного лица больше не читается как переодевание персонажа
  const full = normalizeBible({ bible: { storyType: "news" } } as any, character, universe);
  const codes = auditPlan([beats[0]], full, character).map((i) => i.code);
  assert.ok(!codes.includes("costume-conflict"), codes.join(","));
});
