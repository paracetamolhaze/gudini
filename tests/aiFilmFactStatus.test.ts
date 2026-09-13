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

test("обстановка сцены не считается уже достигнутым результатом", async () => {
  const { eventCovered } = await import("../lib/aiFilm/audit");
  // настоящий случай: «standing outside the car» → «seated inside the car»; «car» есть в обоих
  // состояниях сцены, а в исходном состоянии контракта его нет — посадка не засчитывалась
  const board = ev("board", "two teenagers get into the car", [{ id: "teens-location", before: "standing outside on the street", after: "seated inside the car", role: "change" }]);
  const shown = beat("B1", 0, 8, {
    eventIds: ["board"],
    objects: [{ id: "teens-location", before: "standing on the sidewalk outside the car", after: "seated inside the back seat of the car", role: "change" }],
  });
  assert.equal(eventCovered(board, [shown]), true);
  // а уже достигнутый результат по-прежнему не засчитывается
  const already = beat("B1", 0, 8, {
    eventIds: ["board"],
    objects: [{ id: "teens-location", before: "already seated inside the car", after: "seated inside the car, doors closing", role: "change" }],
  });
  assert.equal(eventCovered(board, [already]), false);
  // и обстановка сама по себе результатом не становится: рядом с машиной остались
  const leaning = beat("B1", 0, 8, {
    eventIds: ["board"],
    objects: [{ id: "teens-location", before: "standing by the car", after: "leaning on the car", role: "change" }],
  });
  assert.equal(eventCovered(board, [leaning]), false);
});

test("обязательное событие без перехода — порча контракта, а не «не показано»", () => {
  const waiting = ev("waiting", "the teens remain seated calmly inside the stopped car", [{ id: "car-doors", before: "unlocked", after: "held closed with teens inside", role: "keep" }]);
  const bible = { ...normalizeBible({ bible: { storyType: "news" } } as any, character, universe, FACTS), events: [waiting, surrounded] };
  const issues = auditPlan(
    [beat("B1", 0, 8, { eventIds: ["surrounded-stop"], objects: surrounded.objects })],
    bible,
    character,
  );
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes("event-without-change"), codes.join(","));
  assert.ok(!issues.some((i) => i.code === "event-not-covered" && (i.eventIds ?? []).includes("waiting")), codes.join(","));
  assert.deepEqual(showableEvents(bible).map((e) => e.id), ["surrounded-stop"]);
});

test("второму заходу не возвращают силой событие без перехода", async () => {
  const { preserveRequired } = await import("../lib/aiFilm/criteria");
  const waiting = ev("waiting", "the teens remain seated calmly inside the stopped car", [{ id: "car-doors", before: "unlocked", after: "held closed", role: "keep" }]);
  const fixed = [{ ...surrounded }];
  // первый заход обещал «ожидание» без изменения; второй его убрал — и оно не возвращается
  assert.deepEqual(preserveRequired([waiting, surrounded], fixed).map((e) => e.id), ["surrounded-stop"]);
  // настоящее обязательство, снятое вторым заходом, возвращается по-прежнему
  assert.deepEqual(preserveRequired([fire, surrounded], fixed).map((e) => e.id).sort(), ["fire-out-window", "surrounded-stop"]);
});

test("границы правила: документальная новость, вымышленная история, условный пример", () => {
  const fable = ev("guard-decides", "the tower guard system decides to lock the gate and sound the alarm", [
    { id: "gate", before: "open", after: "locked with the alarm sounding", role: "change" },
  ]);
  // документальная новость: механизм без подтверждения к показу не обязателен и не изображается
  const news = { ...normalizeBible({ bible: { storyType: "news" } } as any, character, universe, FACTS), events: [detect, fire] };
  assert.deepEqual(showableEvents(news).map((e) => e.id), ["fire-out-window"]);
  const newsCodes = auditPlan(
    [beat("B1", 0, 8, { eventIds: ["detect-weapon"], visualAction: "the cabin camera swivels toward the pistol and the indicator blinks red", keyMoment: "the indicator blinks red" })],
    news,
    character,
  ).map((i) => i.code);
  assert.ok(newsCodes.includes("invented-mechanism"), newsCodes.join(","));
  // явно вымышленная история: тот же по форме механизм — часть постановки
  const fiction = { ...normalizeBible({ bible: { storyType: "philosophy" } } as any, character, universe), events: [fable] };
  assert.deepEqual(showableEvents(fiction).map((e) => e.id), ["guard-decides"]);
  const fictionCodes = auditPlan(
    [beat("B1", 0, 8, { eventIds: ["guard-decides"], objects: fable.objects, visualAction: "the gate mechanism locks by itself and the alarm light starts blinking", keyMoment: "the gate locks and the alarm blinks" })],
    fiction,
    character,
  ).map((i) => i.code);
  assert.ok(!fictionCodes.some((c) => /mechanism|contradict/.test(c)), fictionCodes.join(","));
  // условный пример разбора темы: система на экране подтверждает подпись — обычное наблюдаемое действие
  const sign = ev("sign", "the wallet device screen shows a signed confirmation after the button press", [
    { id: "hardware-wallet", before: "screen showing an unsigned prompt", after: "screen showing a signed confirmation", role: "change" },
  ]);
  const example = { ...normalizeBible({ bible: { storyType: "explainer" } } as any, character, universe), events: [sign] };
  assert.deepEqual(showableEvents(example).map((e) => e.id), ["sign"]);
  const exampleCodes = auditPlan(
    [beat("B1", 0, 8, { eventIds: ["sign"], objects: sign.objects, visualAction: "his thumb presses the button and the device screen switches to a signed confirmation", keyMoment: "the screen shows the confirmation" })],
    example,
    character,
  ).map((i) => i.code);
  assert.ok(!exampleCodes.some((c) => /mechanism|contradict/.test(c)), exampleCodes.join(","));
});

test("отсутствие сведений — не опровержение", () => {
  // told: справка молчит — замечание о неподтверждённом механизме, конфликта нет
  const news = { ...normalizeBible({ bible: { storyType: "news" } } as any, character, universe, FACTS), events: [detect] };
  const told = auditPlan([beat("B1", 0, 8)], news, character).map((i) => i.code);
  assert.ok(told.includes("unconfirmed-mechanism"), told.join(","));
  assert.ok(!told.includes("voice-contradicts-facts"), told.join(","));
  // contradicted без цитаты из справки не признаётся: это тоже «сведений нет»
  const claimed = { ...detect, basis: "contradicted" as const, basisFact: "в справке такого нет" };
  const unproven = auditPlan([beat("B1", 0, 8)], { ...news, events: [claimed] }, character).map((i) => i.code);
  assert.ok(unproven.includes("basis-unverified"), unproven.join(","));
  assert.ok(!unproven.includes("voice-contradicts-facts"), unproven.join(","));
});

test("роль другого возраста: запрет в документальной истории, замечание в вымышленной", () => {
  const cast = (storyType: string) =>
    auditPlan(
      [beat("B1", 0, 8, { gudiniVisible: true, visualAction: "Gudini climbs into the back seat", scene: { who: "Gudini in the back seat" } })],
      normalizeBible({ bible: { storyType, playedByGudini: "пятнадцатилетний подросток" } } as any, character, universe),
      character,
    ).find((i) => i.code === "role-miscast");
  assert.equal(cast("news")?.severity, "block");
  assert.equal(cast("philosophy")?.severity, "warn");
});

test("цитата с человеком-исполнителем опровергает механизм системы, а не подтверждает его", () => {
  const voiced = { ...fakeFault, basis: "confirmed" as const, basisFact: "Сотрудники Waymo дистанционно заглушили машину и сообщили пассажирам о технической неисправности" };
  assert.equal(effectiveBasis(voiced, FACTS), "contradicted");
  // цитата без человека-исполнителя подтверждает по-прежнему
  const recorded = ev("camera-record", "the cabin camera records the passengers and the pistol", [{ id: "recording", before: "not recorded", after: "recorded", role: "change" }],
    { basis: "confirmed", basisFact: "Инцидент со стрельбой внутри робота-такси был зафиксирован камерами автомобиля" });
  assert.equal(effectiveBasis(recorded, FACTS), "confirmed");
  const bible = { ...normalizeBible({ bible: { storyType: "news" } } as any, character, universe, FACTS), events: [voiced, surrounded] };
  const codes = auditPlan([beat("B1", 0, 8, { eventIds: ["surrounded-stop"], objects: surrounded.objects })], bible, character).map((i) => i.code);
  assert.ok(codes.includes("voice-contradicts-facts"), codes.join(","));
});

test("механизм без предметов — не порча контракта, а честный отказ выдумывать доказательство", () => {
  const bare = { ...detect, objects: [] };
  const bible = { ...normalizeBible({ bible: { storyType: "news" } } as any, character, universe, FACTS), events: [bare, surrounded] };
  const codes = auditPlan([beat("B1", 0, 8, { eventIds: ["surrounded-stop"], objects: surrounded.objects })], bible, character).map((i) => i.code);
  assert.ok(!codes.includes("event-contract-broken"), codes.join(","));
  assert.ok(codes.includes("unconfirmed-mechanism"), codes.join(","));
  // событие с предметом и без механизма без предметов по-прежнему ломает контракт
  const bareFire = { ...fire, objects: [] };
  const broken = auditPlan([beat("B1", 0, 8, { eventIds: ["surrounded-stop"], objects: surrounded.objects })], { ...bible, events: [bareFire, surrounded] }, character).map((i) => i.code);
  assert.ok(broken.includes("event-contract-broken"), broken.join(","));
});

test("время суток не прыгает между соседними сценами без названного разрыва во времени", () => {
  const bible = normalizeBible({ bible: { storyType: "news" } } as any, character, universe, FACTS);
  const stop = beat("B1", 0, 5, { location: "a daytime parking lot, car pulling in and stopping", visualAction: "the white car drives into an empty parking lot and stops" });
  const police = beat("B2", 5, 12, { location: "a dim night parking lot with police light bars flashing", visualAction: "armed officers approach the stationary car" });
  const codes = auditPlan([stop, police], bible, character).map((i) => i.code);
  assert.ok(codes.includes("time-of-day-jump"), codes.join(","));
  // тот же свет — замечания нет
  const dayPolice = beat("B2", 5, 12, { location: "the same daytime parking lot", visualAction: "armed officers approach the stationary car" });
  assert.ok(!auditPlan([stop, dayPolice], bible, character).map((i) => i.code).includes("time-of-day-jump"));
  // названный разрыв во времени — допустимо
  const later = beat("B2", 5, 12, { location: "a dim night parking lot", visualAction: "hours later, armed officers approach the stationary car" });
  assert.ok(!auditPlan([stop, later], bible, character).map((i) => i.code).includes("time-of-day-jump"));
  // без примет времени суток — нечего сравнивать
  const plain = beat("B2", 5, 12, { location: "a parking lot", visualAction: "armed officers approach the stationary car" });
  assert.ok(!auditPlan([stop, plain], bible, character).map((i) => i.code).includes("time-of-day-jump"));
});
