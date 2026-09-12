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
    [beat("B1", 0, 6, { visualTask: "place" }), beat("B2", 6, 12, { visualTask: "place" }), beat("B3", 12, 18, { visualTask: "price" }), beat("B4", 18, 24)],
    { ...bible, visualTasks: tasks },
    character,
  ).map((i) => i.code);
  for (const code of ["repeated-visual-task", "explanation-staged", "scene-without-visual-task", "duplicate-visual-tasks"]) {
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
