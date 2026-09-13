import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { auditPlan, effectiveBasis, mechanismEvent, mustShowEvent } from "../lib/aiFilm/audit";
import { RETRY_WARN_CODES, missingRequired, showableEvents } from "../lib/aiFilm/criteria";
import { normalizeBible } from "../lib/aiFilm/story";
import { loadCharacterProfile } from "../lib/aiFilm/character";
import { loadUniverseProfile } from "../lib/aiFilm/universe";
import type { StoryBeat, StoryEvent } from "../lib/aiFilm/types";

/**
 * Статус факта от справки до контракта и запроса. Контрпример — ролик про робот-такси:
 * речь приписывает решения ИИ, справка говорит о сотрудниках компании, а план ставил поворот
 * камеры с красной тревогой и панель, сама играющую объявление.
 */

const universe = loadUniverseProfile("gudini-photoreal", path.join(process.cwd(), "assets", "ai-film", "universes"));
const character = { ...loadCharacterProfile("gudini-real", path.join(process.cwd(), "assets", "ai-film", "characters")), referenceFiles: ["/tmp/ref.png"] };

const FACTS = [
  "Беспилотное такси Waymo сдало полиции двух пьяных несовершеннолетних пассажиров.",
  "Подростки во время бесцельной автопрогулки распивали алкоголь и стреляли из окон салона.",
  "Автомобиль удерживал пассажиров внутри до прибытия вооружённой группы захвата полиции.",
  "Сотрудники Waymo дистанционно заглушили машину и сообщили пассажирам о технической неисправности, чтобы удержать их до приезда полиции.",
  "Инцидент со стрельбой и распитием алкоголя внутри робота-такси был зафиксирован камерами автомобиля.",
];

const beat = (id: string, start: number, end: number, over: Partial<StoryBeat> = {}): StoryBeat => ({
  id, start, end, meaning: "", storyBeat: "", displayMode: "full_ai", purpose: "explain", priority: "high",
  requiresGeneration: true, gudiniVisible: false, universeAdaptation: "", visualAction: "the white car rolls to a stop in a parking lot",
  keyMoment: "the car stops", anchorPhrase: "", hold: "settle", anchorAtSec: null, anchorAbsSec: null,
  eventIds: [], objects: [], location: "a parking lot", motion: "the car slows and stops", stateBefore: "", stateAfter: "",
  continuityGroup: null, continuityRequired: false, transition: "cut", shotType: "medium", frameSubject: "",
  camera: "Camera is at ground level near the lot edge", cameraAngle: "eye_level", composition: "center", suggestedDuration: end - start,
  ...over,
});

const ev = (id: string, observable: string, objects: StoryEvent["objects"], over: Partial<StoryEvent> = {}): StoryEvent => ({
  id, observable, required: true, fromPhrase: 1, toPhrase: 2, objects, basis: "told", basisFact: "", ...over,
});

const detect = ev("detect-weapon", "the car system visually registers the black pistol in the passenger hand and triggers an emergency protocol", [
  { id: "car-alert", before: "monitoring quietly", after: "emergency protocol triggered", role: "change" },
]);
const fakeFault = ev("fake-fault-message", "the voice assistant announces a fabricated malfunction to the passengers", [
  { id: "cabin-announcement", before: "silent", after: "fault announcement played", role: "change" },
]);
const fire = ev("fire-out-window", "a teenager fires the toy pistol out of the open car window while driving", [
  { id: "toy-pistol", before: "held inside the car", after: "fired out of the open window", role: "change" },
]);
const surrounded = ev("surrounded-stop", "the car stops in a lot already surrounded by armed police and a dog", [
  { id: "car-position", before: "moving along the street", after: "stopped in the lot inside a ring of officers", role: "change" },
]);

test("неподтверждённый механизм не обязателен к показу, событие с предметом остаётся обязательным", () => {
  assert.equal(mechanismEvent(detect), true);
  assert.equal(mechanismEvent(fakeFault), true);
  assert.equal(mechanismEvent(fire), false);
  assert.equal(mechanismEvent(surrounded), false);
  assert.equal(mustShowEvent(detect, FACTS), false);
  assert.equal(mustShowEvent(fakeFault, FACTS), false);
  assert.equal(mustShowEvent(fire, FACTS), true);
  assert.equal(mustShowEvent(surrounded, FACTS), true);
  // без справки статус тот же: механизм по-прежнему только рассказ
  assert.equal(mustShowEvent(detect, []), false);
  assert.equal(mustShowEvent(fire, []), true);
});

test("«подтверждено» требует цитаты из справки, иначе событие остаётся рассказом", () => {
  const claimed = { ...detect, basis: "confirmed" as const, basisFact: "" };
  assert.equal(effectiveBasis(claimed, FACTS), "told");
  const quoted = { ...detect, basis: "confirmed" as const, basisFact: "Инцидент со стрельбой внутри робота-такси был зафиксирован камерами автомобиля" };
  assert.equal(effectiveBasis(quoted, FACTS), "confirmed");
  assert.equal(mustShowEvent(quoted, FACTS), true);
  const bible = { ...normalizeBible({ bible: { storyType: "news" } } as any, character, universe, FACTS), events: [claimed, fire] };
  const codes = auditPlan([beat("B1", 0, 6, { eventIds: ["fire-out-window"], objects: fire.objects, visualAction: "a teenager leans out of the window and fires the toy pistol", keyMoment: "the pistol fires out of the window" })], bible, character).map((i) => i.code);
  assert.ok(codes.includes("basis-unverified"), codes.join(","));
  assert.ok(codes.includes("unconfirmed-mechanism"), codes.join(","));
  assert.ok(!codes.includes("event-not-covered"), codes.join(","));
});

test("сцена с поворотом камеры и красной тревогой — выдуманное доказательство механизма", () => {
  const bible = { ...normalizeBible({ bible: { storyType: "news" } } as any, character, universe, FACTS), events: [detect, fire, surrounded] };
  const staged = auditPlan(
    [
      beat("B1", 0, 8, { eventIds: ["detect-weapon"], visualAction: "a small camera lens near the ceiling swivels toward the pistol and its indicator light blinks red", keyMoment: "the indicator switches to blinking red" }),
      beat("B2", 8, 14, { eventIds: ["fire-out-window"], objects: fire.objects, visualAction: "a teenager leans out of the window and fires the toy pistol", keyMoment: "the pistol fires out of the window" }),
      beat("B3", 14, 20, { eventIds: ["surrounded-stop"], objects: surrounded.objects }),
    ],
    bible,
    character,
  );
  const codes = staged.map((i) => i.code);
  assert.ok(codes.includes("invented-mechanism"), codes.join(","));
  assert.deepEqual(staged.find((i) => i.code === "invented-mechanism")!.beatIds, ["B1"]);
  assert.equal(staged.find((i) => i.code === "invented-mechanism")!.severity, "block");
  // внешний исход того же события без реакции устройства не запрещён
  const outward = auditPlan(
    [beat("B1", 0, 8, { eventIds: ["detect-weapon"], visualAction: "the white car pulls over to the curb and stops", keyMoment: "the car comes to a stop" })],
    bible,
    character,
  ).map((i) => i.code);
  assert.ok(!outward.includes("invented-mechanism"), outward.join(","));
});

test("речь против справки: конфликт отмечается отдельно, сцена под него не ставится, оператора никто не добавляет", () => {
  const contradicted = { ...fakeFault, basis: "contradicted" as const, basisFact: "Сотрудники Waymo дистанционно заглушили машину и сообщили пассажирам о технической неисправности" };
  const bible = { ...normalizeBible({ bible: { storyType: "news" } } as any, character, universe, FACTS), events: [contradicted, surrounded] };
  assert.equal(effectiveBasis(contradicted, FACTS), "contradicted");
  const issues = auditPlan(
    [
      beat("B1", 0, 8, { eventIds: ["fake-fault-message"], visualAction: "the dashboard speaker panel glows and plays the fault announcement", keyMoment: "the panel lights up as the announcement plays" }),
      beat("B2", 8, 14, { eventIds: ["surrounded-stop"], objects: surrounded.objects }),
    ],
    bible,
    character,
  );
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes("voice-contradicts-facts"), codes.join(","));
  assert.ok(codes.includes("staged-contradicted-claim"), codes.join(","));
  assert.ok(codes.includes("invented-mechanism"), codes.join(","));
  assert.ok(!codes.includes("event-not-covered"), codes.join(","));
  // в списке участников оператор не появился: разбор ничего не дописывает в контракт
  assert.deepEqual(bible.supportingCharacters, []);
  // обязательные к показу — только внешний исход
  assert.deepEqual(showableEvents(bible).map((e) => e.id), ["surrounded-stop"]);
  assert.deepEqual(missingRequired({ beats: [], shots: [], bible } as any, [contradicted, surrounded]), ["surrounded-stop"]);
});

test("роль другого возраста не для персонажа, а костюм чинится переназначением", () => {
  const bible = normalizeBible({ bible: { storyType: "news", playedByGudini: "один из двух 15-летних подростков-пассажиров" } } as any, character, universe, FACTS);
  const issues = auditPlan(
    [
      beat("B1", 0, 8, { gudiniVisible: true, visualAction: "Gudini and a second teenager climb into the back seat", scene: { who: "Gudini and a second teenager", worn: ["casual hoodies and jeans"] } }),
      beat("B2", 8, 16, { gudiniVisible: true, visualAction: "Gudini leans out of the window and fires the toy pistol", scene: { who: "Gudini at the open window", worn: ["orange and black zip jacket"] } }),
    ],
    bible,
    character,
  );
  const miscast = issues.find((i) => i.code === "role-miscast");
  assert.ok(miscast, issues.map((i) => i.code).join(","));
  assert.equal(miscast!.severity, "block");
  assert.deepEqual(miscast!.beatIds, ["B1", "B2"], "переодетый в свою куртку подросток тоже неверно назначен");
  const costume = issues.find((i) => i.code === "costume-conflict");
  assert.ok(costume && /отдельный персонаж/.test(costume.message), costume?.message ?? "нет costume-conflict");
  // взрослая роль без возрастных примет остаётся за персонажем
  const adult = normalizeBible({ bible: { storyType: "explainer", playedByGudini: "курьер" } } as any, character, universe);
  assert.ok(!auditPlan([beat("B1", 0, 8, { gudiniVisible: true, visualAction: "Gudini hands over the parcel", scene: { who: "Gudini at the door" } })], adult, character).some((i) => i.code === "role-miscast"));
});

test("позднее начало не гонит во второй заход само по себе", () => {
  assert.ok(!RETRY_WARN_CODES.has("first-scene-late"));
  assert.ok(RETRY_WARN_CODES.has("unconfirmed-mechanism"));
  assert.ok(RETRY_WARN_CODES.has("voice-contradicts-facts"));
});
