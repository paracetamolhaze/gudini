import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { applyPatch, canonicalRaw, rawBeatRanges, scopeFromIssues, storyFromRaw, phrasesFromWords, type RawStory, type RawPatch } from "../lib/aiFilm/story";
import { auditPlan } from "../lib/aiFilm/audit";
import { buildFilmPlan, coverageConfig, veoCallMinutes, veoConcurrency } from "../lib/aiFilm/plan";
import { gateIssues } from "../lib/aiFilm/criteria";
import { loadCharacterProfile } from "../lib/aiFilm/character";
import { loadUniverseProfile } from "../lib/aiFilm/universe";
import type { Word } from "../lib/transcribe";

/**
 * Ограниченная корректировка второго захода. Контрпример — робот-такси: первый план был верен
 * в ролях, статусах и отсутствии механизма, но потерял развязку и обещал событие без перехода.
 * Второй заход обязан исправить только это, а не переписать подростков в персонажа и вернуть
 * поворот камеры к пистолету.
 */

const universe = loadUniverseProfile("gudini-photoreal", path.join(process.cwd(), "assets", "ai-film", "universes"));
const character = { ...loadCharacterProfile("gudini-real", path.join(process.cwd(), "assets", "ai-film", "characters")), referenceFiles: ["/tmp/ref.png"] };
// без потолка покрытия: здесь проверяется корректировка, а не редьюсер бюджета
const cfg = { key: "patch", universe, budgetUsd: 12, maxCoverage: 1, concurrency: veoConcurrency(), callMinutes: veoCallMinutes() };

const FACTS = [
  "Подростки во время бесцельной автопрогулки распивали алкоголь и стреляли из окон салона.",
  "Сотрудники Waymo дистанционно заглушили машину и сообщили пассажирам о технической неисправности, чтобы удержать их до приезда полиции.",
  "Инцидент со стрельбой и распитием алкоголя внутри робота-такси был зафиксирован камерами автомобиля.",
];

// шесть фраз по три секунды
const SPEECH = [
  "Двое подростков сели в беспилотное такси с игрушечным пистолетом.",
  "По дороге они открыли окно и начали палить на улицу.",
  "За салоном через камеры следил искусственный интеллект.",
  "Голосовой помощник сообщил, что машина неисправна.",
  "Подростки спокойно сидели внутри и ждали.",
  "Только после задержания выяснилось, что пистолет был игрушечным.",
];
function words(): Word[] {
  const out: Word[] = [];
  let at = 0;
  for (const s of SPEECH) {
    const parts = s.split(" ");
    const step = 3 / parts.length;
    parts.forEach((w, i) => out.push({ word: w, start: at + i * step, end: at + (i + 1) * step - 0.02 }));
    at += 3;
  }
  return out;
}
const W = words();
const phrases = phrasesFromWords(W);
const duration = W[W.length - 1].end;

const scene = (from: number, to: number, over: Record<string, unknown>) => ({
  fromPhrase: from, toPhrase: to, displayMode: "full_ai", purpose: "explain", priority: "high", gudiniVisible: false,
  hold: "settle", motion: "the action unfolds", location: "a street", stateBefore: "", stateAfter: "", continuityGroup: null, continuityRequired: false,
  transition: "cut", shotType: "medium", camera: "Camera is at eye level beside the car", cameraAngle: "eye_level", composition: "center",
  ...over,
});

function firstAnswer(): RawStory {
  return {
    bible: {
      storyType: "news", playedByGudini: "",
      supportingCharacters: [{ name: "Teen Passenger 1", function: "witness", appearance: "a fifteen-year-old boy in a hoodie" }, { name: "Teen Passenger 2", function: "witness", appearance: "a fifteen-year-old boy in a cap" }],
      visualTasks: [
        { id: "board", learns: "садятся в такси", role: "event", fromPhrase: 1, toPhrase: 1, action: "two teens climb into the car" },
        { id: "fire", learns: "стреляют из окна", role: "event", fromPhrase: 2, toPhrase: 2, action: "a teen fires the toy pistol out of the window" },
        { id: "camera", learns: "камера фиксирует происходящее", role: "event", fromPhrase: 3, toPhrase: 3, action: "the cabin camera lens is pointed at the teens" },
        { id: "fault", learns: "объявление о неисправности объясняет голос", role: "explanation", fromPhrase: 4, toPhrase: 4, action: "" },
        { id: "waiting", learns: "подростки ждут", role: "event", fromPhrase: 5, toPhrase: 5, action: "the teens sit and wait" },
        { id: "toy", learns: "пистолет оказался игрушкой", role: "explanation", fromPhrase: 6, toPhrase: 6, action: "" },
      ],
      events: [
        { id: "board", observable: "two teenagers get into the car with a toy pistol", required: true, basis: "confirmed", basisFact: "Подростки распивали алкоголь и стреляли из окон салона", fromPhrase: 1, toPhrase: 1, objects: [{ id: "teens-location", before: "standing outside", after: "seated inside the car", role: "change" }] },
        { id: "fire-out-window", observable: "a teen fires the toy pistol out of the open window", required: true, basis: "confirmed", basisFact: "Подростки распивали алкоголь и стреляли из окон салона", fromPhrase: 2, toPhrase: 2, objects: [{ id: "toy-pistol", before: "held inside", after: "fired out of the window", role: "change" }] },
        { id: "camera-record", observable: "the cabin camera is pointed at the teens and the pistol", required: true, basis: "confirmed", basisFact: "Инцидент был зафиксирован камерами автомобиля", fromPhrase: 3, toPhrase: 3, objects: [{ id: "camera-lens", before: "idle fixture", after: "pointed at the teens and the pistol", role: "change" }] },
        { id: "fake-fault", observable: "the voice assistant announces a fabricated malfunction", required: true, basis: "told", basisFact: "", fromPhrase: 4, toPhrase: 4, objects: [] },
        { id: "waiting", observable: "the teens remain seated calmly inside the stopped car", required: true, basis: "told", basisFact: "", fromPhrase: 5, toPhrase: 5, objects: [{ id: "car-doors", before: "unlocked", after: "held closed", role: "keep" }] },
        { id: "reveal-toy", observable: "after the arrest the pistol turns out to be a toy", required: true, basis: "told", basisFact: "", fromPhrase: 6, toPhrase: 6, objects: [{ id: "toy-pistol", before: "believed real", after: "identified as a toy gel blaster", role: "change" }] },
      ],
    },
    beats: [
      scene(1, 1, { visualTask: "board", eventIds: ["board"], visualAction: "Teen Passenger 1 and Teen Passenger 2 climb into the back seat of the white car", keyMoment: "both teens are seated inside the car", scene: { who: "Teen Passenger 1 and Teen Passenger 2 at the car door" }, objects: [{ id: "teens-location", before: "standing on the sidewalk outside the car", after: "seated inside the back seat of the car", role: "change" }] }),
      scene(2, 2, { visualTask: "fire", eventIds: ["fire-out-window"], visualAction: "Teen Passenger 1 leans out of the open window and fires the toy pistol", keyMoment: "the toy pistol fires out of the window", scene: { who: "Teen Passenger 1 at the open window" }, objects: [{ id: "toy-pistol", before: "held inside the car", after: "fired out of the open window", role: "change" }] }),
      scene(3, 3, { visualTask: "camera", eventIds: ["camera-record"], visualAction: "the small cabin camera lens near the mirror is pointed at the two teens holding the toy pistol", keyMoment: "the lens is aimed at the pistol", scene: { who: "Teen Passenger 1 and Teen Passenger 2 in the back seat" }, objects: [{ id: "camera-lens", before: "an idle fixture near the mirror", after: "pointed at the teens and the pistol", role: "change" }] }),
      { fromPhrase: 4, toPhrase: 4, displayMode: "author" },
      scene(5, 5, { visualTask: "waiting", eventIds: ["waiting"], visualAction: "Teen Passenger 1 and Teen Passenger 2 sit calmly inside the stopped car", keyMoment: "both teens sit relaxed", scene: { who: "the two teens in the back seat" }, objects: [{ id: "car-doors", before: "unlocked", after: "held closed", role: "keep" }] }),
      { fromPhrase: 6, toPhrase: 6, displayMode: "author" },
    ],
  };
}

function build(raw: RawStory) {
  const story = storyFromRaw(raw, { words: W, phrases, duration, character, universe, researchFacts: FACTS });
  const plan = buildFilmPlan({ character, bible: story.bible, beats: story.beats, duration, cfg });
  return { story, plan };
}

test("первый план: верные роли и статусы, но потерянная развязка и событие без перехода", () => {
  const { plan } = build(firstAnswer());
  const codes = plan.issues.map((i) => i.code);
  assert.ok(codes.includes("event-not-covered"), codes.join(","));
  assert.ok(codes.includes("event-without-change"), codes.join(","));
  assert.ok(!codes.includes("role-miscast") && !codes.includes("invented-mechanism"), codes.join(","));
});

test("корректировка чинит только замечания: развязка восстановлена, роли и механизм не тронуты", () => {
  const first = firstAnswer();
  const { story, plan } = build(first);
  const scope = scopeFromIssues(plan.issues, story.beats, story.bible, first, phrases.length, character.name);
  // то, что сделал бы переписывающий второй заход: вместе с исправлениями — подмена ролей и механизм
  const patch: RawPatch = {
    bible: { playedByGudini: "один из двух 15-летних подростков", supportingCharacters: [{ name: "второй подросток", function: "witness", appearance: "a boy" }] },
    beats: {
      replace: [
        scene(1, 1, { visualTask: "board", eventIds: ["board"], visualAction: "Gudini and a second teenager climb into the back seat", keyMoment: "both are seated", scene: { who: "Gudini at the car door" }, objects: [{ id: "teens-location", before: "standing outside the car", after: "seated inside the car", role: "change" }] }),
        scene(3, 3, { visualTask: "camera", eventIds: ["camera-record"], visualAction: "the cabin camera lens swivels toward the pistol and its indicator blinks red", keyMoment: "the indicator blinks red", scene: { who: "the two teens" }, objects: [{ id: "camera-lens", before: "idle", after: "pointed at the pistol", role: "change" }] }),
        scene(5, 5, { displayMode: "hybrid", visualTask: "waiting", eventIds: [], visualAction: "Teen Passenger 1 and Teen Passenger 2 sit relaxed inside the stopped car, glancing at each other", keyMoment: "both teens sit relaxed, unaware", scene: { who: "the two teens in the back seat" }, objects: [] }),
      ],
      add: [
        scene(6, 6, { visualTask: "toy", eventIds: ["reveal-toy"], visualAction: "a police officer holds the black toy pistol up beside the open car door and turns it over, orange gel beads visible in its clear magazine", keyMoment: "the toy pistol with its gel beads is shown in the officer hands", scene: { who: "a police officer at the open car door" }, objects: [{ id: "toy-pistol", before: "believed to be a real firearm", after: "identified as a toy gel blaster with beads visible", role: "change" }] }),
      ],
    },
    events: {
      update: [
        { id: "waiting", observable: "the teens remain seated calmly inside the stopped car", required: false, basis: "told", basisFact: "", fromPhrase: 5, toPhrase: 5, objects: [{ id: "car-doors", before: "unlocked", after: "held closed", role: "keep" }] },
        { id: "fake-fault", observable: "the voice assistant announces a fabricated malfunction", required: true, basis: "confirmed", basisFact: "", fromPhrase: 4, toPhrase: 4, objects: [] },
      ],
    },
    visualTasks: {
      update: [
        { id: "waiting", learns: "подростки спокойно ждут", role: "illustration", fromPhrase: 5, toPhrase: 5, action: "the teens sit and wait" },
        { id: "toy", learns: "пистолет оказался игрушкой", role: "event", fromPhrase: 6, toPhrase: 6, action: "an officer shows the toy pistol and its gel beads" },
      ],
    },
    note: "restored the reveal and reworked the waiting",
  };
  const { raw, applied, rejected } = applyPatch(first, patch, scope);
  // отклонено: роли без замечания, посадка и камера без замечания, статус «подтверждено» без цитаты
  assert.ok(rejected.some((l) => l.startsWith("роль и участники")), rejected.join(" | "));
  assert.ok(rejected.some((l) => l.startsWith("сцена 1-1")), rejected.join(" | "));
  assert.ok(rejected.some((l) => l.startsWith("сцена 3-3")), rejected.join(" | "));
  assert.ok(rejected.some((l) => /fake-fault/.test(l)), rejected.join(" | "));
  // применено: ожидание переоформлено, развязка добавлена
  assert.ok(applied.some((l) => l.startsWith("сцена 5-5")), applied.join(" | "));
  assert.ok(applied.some((l) => l.startsWith("сцена 6-6 добавлена")), applied.join(" | "));
  assert.ok(applied.some((l) => /задача toy/.test(l)) && applied.some((l) => /задача waiting/.test(l)), applied.join(" | "));
  // незатронутое сохранено буквально
  const c = canonicalRaw(first);
  assert.deepEqual(raw.bible.supportingCharacters, c.bible.supportingCharacters);
  assert.equal(raw.bible.playedByGudini, "");
  assert.deepEqual(raw.beats![0], c.beats![0]);
  assert.deepEqual(raw.beats![2], c.beats![2]);
  assert.equal(raw.bible.events.find((e: any) => e.id === "fake-fault").basis, "told");
  // после применения весь план проходит проверки заново: ролей и механизма нет, развязка показана
  const { plan: after } = build(raw);
  const codes = after.issues.map((i) => i.code);
  assert.ok(!codes.includes("role-miscast"), codes.join(","));
  assert.ok(!codes.includes("invented-mechanism"), codes.join(","));
  assert.ok(!codes.includes("event-without-change"), codes.join(","));
  assert.ok(!after.issues.some((i) => i.code === "event-not-covered" && (i.eventIds ?? []).includes("reveal-toy")), codes.join(","));
  assert.equal(gateIssues(after).length, 0, JSON.stringify(gateIssues(after).map((i) => i.code)));
});

test("связанное изменение применяется только с объявленной причиной, новая сцена не ложится поверх сцены", () => {
  const first = firstAnswer();
  const { story, plan } = build(first);
  const scope = scopeFromIssues(plan.issues, story.beats, story.bible, first, phrases.length, character.name);
  const replaced = scene(2, 2, { visualTask: "fire", eventIds: ["fire-out-window"], visualAction: "Teen Passenger 2 fires the toy pistol out of the window", keyMoment: "the pistol fires", scene: { who: "Teen Passenger 2" }, objects: [{ id: "toy-pistol", before: "held inside the car", after: "fired out of the open window", role: "change" }] });
  const silent = applyPatch(first, { beats: { replace: [replaced] } }, scope);
  assert.ok(
    silent.rejected.some((l) => l.startsWith("сцена 2-2")),
    `${silent.rejected.join(" | ")} || область: ${[...scope.beats].join(",")} || замечания: ${JSON.stringify(plan.issues.map((i) => [i.code, i.beatIds, i.eventIds ?? []]))}`,
  );
  const declared = applyPatch(first, { beats: { replace: [replaced] }, related: [{ target: "2-2", why: "стреляет тот же подросток, что держал пистолет в развязке" }] }, scope);
  assert.ok(declared.applied.some((l) => l.startsWith("сцена 2-2")), declared.applied.join(" | "));
  // новая сцена поверх существующей AI-сцены отклоняется, поверх авторского бита — режет его
  const onTop = applyPatch(first, { beats: { add: [scene(3, 3, { visualTask: "camera", eventIds: [], visualAction: "x", keyMoment: "y" })] }, related: [{ target: "3-3", why: "проверка наложения" }] }, scope);
  assert.ok(onTop.rejected.some((l) => /пересекает сцену 3-3/.test(l)), onTop.rejected.join(" | "));
  assert.deepEqual(rawBeatRanges(canonicalRaw(first).beats!, phrases.length).map((r) => r && `${r.from}-${r.to}`), ["1-1", "2-2", "3-3", "4-4", "5-5", "6-6"]);
});

test("списки контракта на верхнем уровне ответа собираются под bible, адреса сцен не плывут", () => {
  const first = firstAnswer();
  const moved: RawStory = { bible: { ...first.bible, events: undefined, visualTasks: undefined }, events: first.bible.events, visualTasks: first.bible.visualTasks, beats: first.beats };
  const c = canonicalRaw(moved);
  assert.equal(c.bible.events.length, 6);
  assert.equal(c.bible.visualTasks.length, 6);
  assert.equal((c as any).events, undefined);
  const { story } = build(first);
  assert.deepEqual(story.beats.map((b) => b.sourceIndex), [0, 1, 2, 3, 4, 5]);
});
