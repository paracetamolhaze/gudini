import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { beatsFromRaw, phrasesFromWords, anchorOffset, reconcileFraming, normalizeBible, MIN_SHOWN_AI_SEC } from "../lib/aiFilm/story";
import { buildFilmPlan, compatiblePrefix, compatibleInOneShot, changeDeadline, compilerFingerprint, applicableContinuity } from "../lib/aiFilm/plan";
import { auditPlan, eventCovered } from "../lib/aiFilm/audit";
import { planKey, planKeyDiff } from "../lib/aiFilm/run";
import { loadUniverseProfile } from "../lib/aiFilm/universe";
import { loadCharacterProfile } from "../lib/aiFilm/character";
import type { CharacterProfile, StoryBeat, StoryBible, StoryEvent } from "../lib/aiFilm/types";
import type { PlanConfig } from "../lib/aiFilm/plan";
import type { Word } from "../lib/transcribe";

/**
 * Приёмка контракта событий: то, что зритель обязан увидеть, должно пережить нормализацию,
 * группировку и сокращение по бюджету. Проверяется конечное поведение — биты, собранные
 * запросы и готовность плана, — а не наличие фразы в системном промпте.
 */

const universe = loadUniverseProfile("gudini-photoreal", path.join(process.cwd(), "assets", "ai-film", "universes"));
const loaded = loadCharacterProfile("gudini-real", path.join(process.cwd(), "assets", "ai-film", "characters"));
const character: CharacterProfile = { ...loaded, referenceFiles: ["/tmp/ref.png"] };

const cfg = (over: Partial<PlanConfig> = {}): PlanConfig => ({
  key: "k", universe, budgetUsd: 12, maxCoverage: 1, concurrency: 3, callMinutes: 2, ...over,
});

/** Контрольная речь: заказал, пришло, порвался, запасной, отзыв. */
function controlSpeech(): Word[] {
  const say = (text: string, from: number, per = 0.45): Word[] =>
    text.split(" ").map((w, i) => ({ word: w, start: from + i * per, end: from + i * per + per * 0.9 }));
  return [
    ...say("Он заказал парашют за пять долларов.", 0),
    ...say("Через неделю коробка приехала прямо к двери.", 3.2),
    ...say("Он прыгнул и купол просто порвался в воздухе.", 6.0),
    ...say("Запасной раскрылся почти у самой земли.", 11.0),
    ...say("После всего он написал отзыв на пять звёзд.", 15.0),
  ];
}

const EVENTS: StoryEvent[] = [
  { id: "order", observable: "he taps buy on the phone", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "phone", before: "listing on screen", after: "order placed" }] },
  { id: "delivery", observable: "he opens the delivered parcel", required: true, fromPhrase: 2, toPhrase: 2, objects: [{ id: "parcel", before: "sealed", after: "open and empty" }] },
  { id: "tear", observable: "the main canopy tears apart", required: true, fromPhrase: 3, toPhrase: 3, objects: [{ id: "main-canopy", before: "open and whole", after: "torn into strips" }] },
  { id: "reserve", observable: "the reserve canopy opens", required: true, fromPhrase: 4, toPhrase: 4, objects: [{ id: "reserve-canopy", before: "packed", after: "fully open" }] },
  { id: "review", observable: "he types a review on the phone", required: true, fromPhrase: 5, toPhrase: 5, objects: [{ id: "phone", before: "in his pocket", after: "review typed" }] },
];

const bibleWith = (events: StoryEvent[], extra: Record<string, unknown> = {}): StoryBible =>
  normalizeBible({ bible: { storyType: "explainer", events, ...extra } } as any, character, universe);

/** Сырые биты контрольной истории: каждый показывает своё событие. */
const controlRaw = () => [
  { fromPhrase: 1, toPhrase: 1, displayMode: "full_ai", visualAction: "Gudini taps buy on his phone", keyMoment: "the order goes through", eventIds: ["order"], objects: [{ id: "phone", before: "listing on screen", after: "order placed" }], location: "a kitchen table", cameraAngle: "eye_level", camera: "Camera is at eye level in front of him", motion: "he taps the screen" },
  { fromPhrase: 2, toPhrase: 2, displayMode: "full_ai", visualAction: "Gudini tears open the delivered parcel", keyMoment: "the parcel opens", eventIds: ["delivery"], objects: [{ id: "parcel", before: "sealed", after: "open and empty" }], location: "a doorstep", cameraAngle: "high_angle", camera: "Camera is above the parcel looking down", motion: "he pulls the tape" },
  { fromPhrase: 3, toPhrase: 3, displayMode: "full_ai", visualAction: "The main canopy tears apart above Gudini", keyMoment: "the canopy tears", anchorPhrase: "порвался", eventIds: ["tear"], objects: [{ id: "main-canopy", before: "open and whole", after: "torn into strips" }], location: "open sky", cameraAngle: "low_angle", camera: "Camera is below him looking up", motion: "the seam splits" },
  { fromPhrase: 4, toPhrase: 4, displayMode: "full_ai", visualAction: "Gudini pulls the reserve handle and the reserve canopy opens", keyMoment: "the reserve opens", eventIds: ["reserve"], objects: [{ id: "reserve-canopy", before: "packed", after: "fully open" }], location: "open sky", cameraAngle: "profile", camera: "Camera is beside him", motion: "he yanks the handle" },
  { fromPhrase: 5, toPhrase: 5, displayMode: "full_ai", visualAction: "Gudini types a review on his phone", keyMoment: "he sends the review", eventIds: ["review"], objects: [{ id: "phone", before: "in his pocket", after: "review typed" }], location: "a grassy field", cameraAngle: "eye_level", camera: "Camera is at eye level in front of him", motion: "his thumbs move" },
];

function controlPlan(raw = controlRaw(), over: Partial<PlanConfig> = {}) {
  const words = controlSpeech();
  const duration = words[words.length - 1].end;
  const beats = beatsFromRaw(raw as any, phrasesFromWords(words), duration, words);
  const bible = bibleWith(EVENTS);
  return { beats, bible, plan: buildFilmPlan({ character, bible, beats, duration, cfg: cfg(over) }) };
}

// ─────────────────────────────── 1. события переживают преобразования

test("контрольные события остаются покрытыми после всех преобразований", () => {
  const { plan } = controlPlan();
  const uncovered = plan.issues.filter((i) => i.code === "event-not-covered");
  assert.deepEqual(uncovered, [], `непокрытые события: ${JSON.stringify(uncovered)}`);
  for (const id of ["order", "delivery", "tear", "reserve", "review"]) {
    assert.ok(plan.beats.some((b) => b.displayMode !== "author" && b.eventIds.includes(id)), `событие ${id} потерялось`);
  }
});

test("приземление вместо отзыва не засчитывается", () => {
  // сцена ссылается на отзыв, но меняет другой предмет: телефон не трогается вовсе
  const landingInsteadOfReview: StoryEvent[] = EVENTS;
  const beat: StoryBeat = {
    id: "B1", start: 15, end: 21, meaning: "", storyBeat: "", displayMode: "full_ai", purpose: "resolution",
    priority: "high", requiresGeneration: true, gudiniVisible: true, universeAdaptation: "",
    visualAction: "Gudini lands on the grass and comes to a stop", keyMoment: "his feet touch the ground",
    anchorPhrase: "", anchorAtSec: null, anchorAbsSec: null, eventIds: ["review"],
    objects: [{ id: "reserve-canopy", before: "open", after: "collapsed on the grass" }],
    location: "a field", motion: "", stateBefore: "", stateAfter: "", continuityGroup: null, continuityRequired: false,
    transition: "cut", shotType: "medium", camera: "Camera is at eye level", cameraAngle: "eye_level",
    composition: "center", suggestedDuration: 6,
  };
  const review = landingInsteadOfReview.find((e) => e.id === "review")!;
  assert.equal(eventCovered(review, [beat]), false, "приземление не показывает отзыв");
  const issues = auditPlan([beat], bibleWith([review]), character);
  assert.ok(issues.some((i) => i.code === "event-not-covered" && i.severity === "block"));
});

// ─────────────────────────────── 2. короткие события выживают

test("трёхсекундные распаковка и отзыв остаются сценами при живом бюджете", () => {
  const words = controlSpeech();
  const duration = words[words.length - 1].end;
  const beats = beatsFromRaw(controlRaw() as any, phrasesFromWords(words), duration, words);
  for (const id of ["delivery", "review"]) {
    const b = beats.find((x) => x.eventIds.includes(id));
    assert.ok(b, `бит события ${id} исчез`);
    assert.notEqual(b!.displayMode, "author", `${id} превратился в автора: ${b!.reduced ?? ""}`);
    assert.ok(b!.end - b!.start >= MIN_SHOWN_AI_SEC - 1e-6);
  }
  // а короткая сцена БЕЗ события по-прежнему уходит автору: три секунды украшения не нужны
  const decor = beatsFromRaw(
    [
      { fromPhrase: 1, toPhrase: 1, displayMode: "full_ai", visualAction: "a wide shot of the sky", eventIds: [] },
      { fromPhrase: 2, toPhrase: 5, displayMode: "author" },
    ] as any,
    phrasesFromWords(words), duration, words,
  );
  assert.equal(decor[1].displayMode, "author");
});

// ─────────────────────────────── 3. группировка не теряет действия

test("объединённый запрос содержит оба действия либо объединение отклонено", () => {
  const base = controlPlan().beats.find((b) => b.eventIds.includes("delivery"))!;
  const open: StoryBeat = { ...base, id: "B1", start: 0, end: 4, continuityGroup: "unbox", continuityRequired: true };
  const pull: StoryBeat = {
    ...open, id: "B2", start: 4, end: 8, eventIds: ["order"], continuityGroup: "unbox", continuityRequired: true,
    visualAction: "Gudini pulls the orange parachute out of the open parcel",
    keyMoment: "the parachute comes out",
    objects: [{ id: "parcel", before: "open", after: "empty" }],
  };
  // одно место и один ракурс — снимаем вместе, оба действия обязаны быть в запросе
  assert.ok(compatibleInOneShot(open, pull));
  const bible = bibleWith(EVENTS);
  const plan = buildFilmPlan({ character, bible, beats: [open, pull], duration: 8, cfg: cfg() });
  const merged = plan.shots.find((s) => s.beatIds.length > 1);
  assert.ok(merged, "два совместимых действия должны попасть в один запрос");
  assert.match(merged!.prompt, /tears open the delivered parcel/);
  assert.match(merged!.prompt, /pulls the orange parachute out of the open parcel/);
  assert.deepEqual(merged!.beatIds, ["B1", "B2"]);

  // разное место — объединять нельзя
  const elsewhere: StoryBeat = { ...pull, location: "open sky" };
  assert.equal(compatibleInOneShot(open, elsewhere), false);
  assert.deepEqual(compatiblePrefix([open, elsewhere]).map((b) => b.id), ["B1"]);
});

// ─────────────────────────────── 4. якорь задаёт время

test("якорь и длительность показа меняют временной контракт запроса", () => {
  const words = controlSpeech();
  const phrases = phrasesFromWords(words);
  const duration = words[words.length - 1].end;
  const withAnchor = beatsFromRaw(controlRaw() as any, phrases, duration, words);
  const tear = withAnchor.find((b) => b.eventIds.includes("tear"))!;
  assert.ok(tear.anchorAtSec != null && tear.anchorAtSec > 0, `якорь не найден: ${tear.anchorAtSec}`);

  // выдуманный якорь не сохраняется
  const bogus = beatsFromRaw(
    controlRaw().map((r) => (r.eventIds[0] === "tear" ? { ...r, anchorPhrase: "такого слова тут нет" } : r)) as any,
    phrases, duration, words,
  );
  assert.equal(bogus.find((b) => b.eventIds.includes("tear"))!.anchorAtSec, null);

  // разное время якоря даёт разный контракт в запросе
  const early = changeDeadline([{ ...tear, anchorAtSec: 1 }], tear.start);
  const late = changeDeadline([{ ...tear, anchorAtSec: 3 }], tear.start);
  assert.notEqual(early, late);
  const bible = bibleWith(EVENTS);
  const a = buildFilmPlan({ character, bible, beats: [{ ...tear, anchorAtSec: 1 }], duration, cfg: cfg() }).shots[0].prompt;
  const b = buildFilmPlan({ character, bible, beats: [{ ...tear, anchorAtSec: 3 }], duration, cfg: cfg() }).shots[0].prompt;
  assert.notEqual(a, b, "смена якоря обязана менять текст запроса");
  assert.match(a, /visible by second 1 of the clip/);
  assert.match(b, /visible by second 3 of the clip/);

  // монтажное окно входит в запрос: одно и то же действие с разной используемой длиной
  // даёт разные тексты. Раньше usedSeconds на промпт не влиял вовсе.
  const short = buildFilmPlan({ character, bible, beats: [{ ...tear, anchorAtSec: 1 }], duration, cfg: cfg() }).shots[0];
  const longer = buildFilmPlan({
    character, bible, beats: [{ ...tear, anchorAtSec: 1, end: tear.start + 8 }], duration: duration + 8, cfg: cfg(),
  }).shots[0];
  assert.notEqual(short.usedSeconds, longer.usedSeconds);
  assert.notEqual(short.prompt, longer.prompt, "длина используемого отрезка обязана менять запрос");

  // якорь за пределами используемого отрезка не превращается в невыполнимый срок:
  // требовать событие на 10-й секунде клипа, от которого в монтаж идут 3 с, бессмысленно
  const outside = buildFilmPlan({ character, bible, beats: [{ ...tear, anchorAtSec: 10 }], duration, cfg: cfg() });
  assert.equal(outside.shots[0].changeBySec, null);
  assert.doesNotMatch(outside.shots[0].prompt, /visible by second 10/);
  assert.ok(
    outside.issues.some((i) => i.code === "anchor-outside-shot"),
    `невозможный якорь обязан быть виден в плане: ${JSON.stringify(outside.issues)}`,
  );
});

test("якорь ищется по словам, а не по номеру фразы", () => {
  const words = controlSpeech();
  assert.equal(anchorOffset(words, "порвался", 6.0, 11.0) != null, true);
  assert.equal(anchorOffset(words, "порвался", 0, 3.2), null, "слова нет в этом отрезке речи");
});

// ─────────────────────────────── 5. камера остаётся согласованной

test("после переноса камеры вниз движение не остаётся прежним", () => {
  const b = {
    camera: "Camera is directly above him looking straight down; he falls away from the camera",
    cameraAngle: "overhead" as const,
    composition: "high_space_below" as const,
    visualAction: "Gudini falls as the canopy opens above him",
    keyMoment: "the canopy opens above him",
    motion: "he falls away from camera as the canopy fills the top of frame",
  };
  assert.equal(reconcileFraming(b), true);
  assert.equal(b.cameraAngle, "low_angle");
  assert.match(b.camera, /he falls toward the camera/);
  assert.doesNotMatch(b.camera, /away from/);
  assert.match(b.motion, /toward the camera/);
  assert.doesNotMatch(b.motion, /away from camera/);

  // и главное: обычная сцена не получает выдуманного падения. Герой стоит на полу
  // и поднимает книгу над головой — камера переезжает вниз, действие остаётся прежним.
  const still = {
    camera: "Camera is directly above him looking straight down",
    cameraAngle: "overhead" as const,
    composition: "high_space_below" as const,
    visualAction: "Gudini stands still and lifts a book above his head",
    keyMoment: "the book rises above his head",
    motion: "he lifts the book slowly",
  };
  assert.equal(reconcileFraming(still), true);
  assert.equal(still.cameraAngle, "low_angle");
  assert.doesNotMatch(still.camera, /falls/, "падение не выдумывается");
  assert.doesNotMatch(still.motion, /falls/);
  assert.equal(still.motion, "he lifts the book slowly");
});

// ─────────────────────────────── 6. состояния по предметам

test("основной и запасной купол не путаются", () => {
  const mk = (id: string, objects: { id: string; before: string; after: string }[]): StoryBeat => ({
    ...controlPlan().beats.find((b) => b.eventIds.includes("tear"))!, id, objects,
  });
  const bible = bibleWith([]);
  const ok = auditPlan(
    [
      mk("B1", [{ id: "main-canopy", before: "whole", after: "torn into strips" }]),
      mk("B2", [{ id: "reserve-canopy", before: "packed and closed", after: "fully open" }]),
    ],
    bible, character,
  );
  assert.ok(!ok.some((i) => i.code === "state-regression"), "запасной купол не отменяет разрыв основного");

  const bad = auditPlan(
    [
      mk("B1", [{ id: "main-canopy", before: "whole", after: "torn into strips" }]),
      mk("B2", [
        { id: "reserve-canopy", before: "packed and closed", after: "fully open" },
        { id: "main-canopy", before: "whole and folded", after: "whole and folded" },
      ]),
    ],
    bible, character,
  );
  const regress = bad.find((i) => i.code === "state-regression");
  assert.ok(regress, "восстановление основного купола должно находиться и рядом с другими предметами");
  assert.ok(regress!.beatIds.some((x) => x.includes("main-canopy")));
});

// ─────────────────────────────── 7. ворота и устаревание

test("непокрытое обязательное событие делает план негодным к генерации", () => {
  const raw = controlRaw().filter((r) => r.eventIds[0] !== "review");
  const { plan } = controlPlan(raw as any);
  const blocking = plan.issues.filter((i) => i.severity === "block");
  assert.ok(blocking.some((i) => i.code === "event-not-covered"), JSON.stringify(plan.issues));
  assert.ok(blocking[0].eventIds?.includes("review"));
});

test("смена промптов делает сохранённый план устаревшим", () => {
  const words = controlSpeech();
  const same = () => planKey(words, "script", character, universe, 20, compilerFingerprint(character, universe));
  assert.equal(same(), same(), "одинаковые входы дают одинаковый ключ");
  const other = planKey(words, "script", character, universe, 20, "0000000000000000");
  assert.notEqual(other, same());
  assert.deepEqual(planKeyDiff(other, same()), ["промпты планировщика и сборщика"]);
});

// ─────────────────────────────── 8. только применимая непрерывность

test("в промпт сцены уходят только относящиеся к ней правила непрерывности", () => {
  const rules = [
    "the main canopy stays bright orange in every shot",
    "the parcel keeps the same shipping label",
    "the reserve canopy is grey canvas",
  ];
  const picked = applicableContinuity(rules, [{ id: "parcel", before: "sealed", after: "open" }], "Gudini tears open the parcel");
  assert.deepEqual(picked, ["the parcel keeps the same shipping label"]);
  assert.equal(applicableContinuity(rules, [], "he walks along a road").length, 0);
});

// ─────────────────────────────── 8. контрпримеры разбора версии 9

test("перекладывание телефона не закрывает отправку отзыва", () => {
  const raw = controlRaw().map((r) =>
    r.eventIds[0] === "review"
      ? {
          ...r,
          visualAction: "Gudini takes the phone out of his pocket and puts it on the table",
          keyMoment: "the phone lies on the table",
          objects: [{ id: "phone", before: "in his pocket", after: "lying on the table" }],
        }
      : r,
  );
  const { plan } = controlPlan(raw as any);
  const missed = plan.issues.find((i) => i.code === "event-not-covered");
  assert.ok(missed, "обещанного перехода нет — событие не показано");
  assert.ok(missed!.eventIds?.includes("review"), JSON.stringify(plan.issues));
  assert.equal(missed!.severity, "block");
});

test("испорченный контракт и ссылка в никуда не дают зелёного плана", () => {
  // событие без предметов: доказывать нечем
  const bare = auditPlan(
    controlPlan().beats,
    bibleWith([{ id: "order", observable: "he taps buy", required: true, fromPhrase: 1, toPhrase: 1, objects: [] } as StoryEvent]),
    character,
  );
  assert.ok(bare.some((i) => i.code === "event-contract-broken" && i.severity === "block"), JSON.stringify(bare));
  // ссылка на событие, которого в контракте нет
  const dangling = auditPlan(
    controlPlan().beats,
    bibleWith(EVENTS.filter((e) => e.id !== "review")),
    character,
  );
  assert.ok(dangling.some((i) => i.code === "event-unknown-reference" && i.severity === "block"), JSON.stringify(dangling));
});

test("несовместимый соседний бит не исчезает из запросов", () => {
  // два действия одной непрерывной группы, но в разных местах: в один кадр их не снять
  const raw = controlRaw().map((r, i) => (i < 2 ? { ...r, continuityGroup: "c1", continuityRequired: true } : r));
  const { plan } = controlPlan(raw as any);
  const inShots = new Set(plan.shots.flatMap((s) => s.beatIds));
  const shown = plan.beats.filter((b) => b.displayMode !== "author");
  for (const b of shown) assert.ok(inShots.has(b.id), `бит ${b.id} остался в таймлайне, но не попал ни в один запрос`);
  assert.ok(!plan.issues.some((i) => i.code === "beat-not-in-shot"), JSON.stringify(plan.issues));
  // и оба действия видны в текстах запросов, а не только первое
  const prompts = plan.shots.map((s) => s.prompt).join(" ");
  assert.match(prompts, /taps buy/);
  assert.match(prompts, /tears open the delivered parcel/);
  assert.ok(!plan.issues.some((i) => i.code === "event-not-covered"), JSON.stringify(plan.issues));
});

test("два события одного клипа получают разные сроки", () => {
  // одно место, один ракурс, одна группа: биты объединяются в один запрос
  const raw = controlRaw().slice(0, 2).map((r, i) => ({
    ...r,
    location: "a kitchen table",
    cameraAngle: "eye_level",
    camera: "Camera is at eye level in front of him",
    continuityGroup: "c1",
    continuityRequired: true,
    anchorPhrase: i === 0 ? "заказал" : "коробка",
  }));
  const { plan } = controlPlan(raw as any);
  const merged = plan.shots.find((s) => s.beatIds.length > 1);
  assert.ok(merged, `биты не объединились: ${JSON.stringify(plan.shots.map((s) => s.beatIds))}`);
  assert.equal(merged!.deadlines.length, 2);
  const seconds = merged!.deadlines.map((d) => d.bySec);
  assert.notEqual(seconds[0], seconds[1], `сроки совпали: ${JSON.stringify(merged!.deadlines)}`);
  assert.match(merged!.prompt, /each at its own time/);
});

test("пауза в речи не сдвигает момент события", () => {
  // предыдущая фраза кончается на 4 с, следующая начинается на 6 с, слово звучит на 7 с
  const words: Word[] = [
    { word: "Он", start: 0, end: 1 },
    { word: "прыгнул.", start: 3, end: 4 },
    { word: "Купол", start: 6, end: 6.8 },
    { word: "порвался", start: 7, end: 7.8 },
    { word: "сразу.", start: 8, end: 8.6 },
  ];
  const phrases = phrasesFromWords(words);
  const raw = [
    { fromPhrase: 1, toPhrase: 1, displayMode: "author", visualAction: "", keyMoment: "", eventIds: [], objects: [], location: "", cameraAngle: "eye_level", camera: "", motion: "" },
    { fromPhrase: 2, toPhrase: 2, displayMode: "full_ai", visualAction: "The canopy tears above Gudini", keyMoment: "the canopy tears", anchorPhrase: "порвался", eventIds: ["tear"], objects: [{ id: "main-canopy", before: "open and whole", after: "torn into strips" }], location: "open sky", cameraAngle: "low_angle", camera: "Camera is below him looking up", motion: "the seam splits" },
  ];
  const beats = beatsFromRaw(raw as any, phrases, 8.6, words);
  const tear = beats.find((b) => b.eventIds.includes("tear"))!;
  assert.ok(tear.anchorAtSec != null, "якорь не найден");
  const absolute = tear.start + tear.anchorAtSec!;
  assert.ok(Math.abs(absolute - 7) < 0.35, `момент уехал: начало ${tear.start}, смещение ${tear.anchorAtSec}, абсолютно ${absolute}`);
});

test("возвращение в прежнее место и нечитаемая квитанция не запрещают генерацию", () => {
  const bible = bibleWith(EVENTS);
  const home = auditPlan(
    controlPlan(controlRaw().map((r, i) => (i === 0 || i === 2 ? { ...r, location: "a kitchen table" } : i === 1 ? { ...r, location: "a doorstep" } : r)) as any).beats,
    bible, character,
  );
  const jump = home.find((i) => i.code === "location-jump-back");
  if (jump) assert.equal(jump.severity, "warn", "возвращение домой не доказывает нарушение хронологии");
  const receipt = auditPlan(
    controlPlan(controlRaw().map((r) => (r.eventIds[0] === "delivery"
      ? { ...r, visualAction: "Gudini folds an unreadable receipt and puts it in his pocket", keyMoment: "the receipt goes into his pocket" }
      : r)) as any).beats,
    bible, character,
  );
  assert.ok(!receipt.some((i) => i.code === "readable-text"), JSON.stringify(receipt));
});
