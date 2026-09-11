import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { beatsFromRaw, phrasesFromWords, anchorOffset, reconcileFraming, normalizeBible, MIN_SHOWN_AI_SEC } from "../lib/aiFilm/story";
import { buildFilmPlan, compatiblePrefix, compatibleInOneShot, changeDeadline, compilerFingerprint, applicableContinuity } from "../lib/aiFilm/plan";
import { auditPlan, eventCovered } from "../lib/aiFilm/audit";
import { planKey, planKeyDiff } from "../lib/aiFilm/run";
import { preserveRequired } from "../lib/aiFilm/criteria";
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
  // событие обязательное, поэтому невыполнимое время — не замечание, а запрет оплаты:
  // сцену нужно переставить под свою реплику
  const hard = outside.issues.find((i) => i.code === "required-anchor-outside-shot");
  assert.ok(hard, `невозможный якорь обязан быть виден в плане: ${JSON.stringify(outside.issues)}`);
  assert.equal(hard!.severity, "block");
  assert.deepEqual(hard!.beatIds, [tear.id]);
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

// ─────────────────────────────── 9. контрпримеры разбора версии 10

test("неизменное состояние и отрицание не закрывают событие", () => {
  const submit: StoryEvent = {
    id: "review", observable: "Gudini types and submits his review", required: true, fromPhrase: 5, toPhrase: 5,
    objects: [{ id: "phone", before: "empty review form", after: "review submitted" }],
  };
  const withState = (before: string, after: string) => {
    const raw = controlRaw().map((r) => (r.eventIds[0] === "review" ? { ...r, objects: [{ id: "phone", before, after }] } : r));
    const words = controlSpeech();
    const duration = words[words.length - 1].end;
    const beats = beatsFromRaw(raw as any, phrasesFromWords(words), duration, words);
    const bible = bibleWith([...EVENTS.filter((e) => e.id !== "review"), submit]);
    return buildFilmPlan({ character, bible, beats, duration, cfg: cfg() });
  };
  const notCovered = (p: ReturnType<typeof withState>) =>
    p.issues.some((i) => i.code === "event-not-covered" && (i.eventIds ?? []).includes("review"));

  // ничего не изменилось: то же состояние до и после
  assert.ok(notCovered(withState("empty review form", "empty review form")), "неизменное состояние не показывает событие");
  // прямо противоположный результат
  assert.ok(notCovered(withState("empty review form", "review not submitted")), "отрицание переворачивает смысл состояния");
  // одно общее слово про предмет разговора — тоже не доказательство
  assert.ok(notCovered(withState("in his pocket", "the review screen is open")), "открытый экран — ещё не отправленный отзыв");
  // а настоящий переход засчитывается
  assert.ok(!notCovered(withState("empty review form", "review submitted")), "обещанный переход обязан закрывать событие");
  // лишние подробности разрешены
  assert.ok(!notCovered(withState("empty review form", "review submitted and five stars given")));
});

test("второй заход не может подменить содержание обязательного события", () => {
  const original: StoryEvent = {
    id: "review", observable: "Gudini types and submits his review", required: true, fromPhrase: 5, toPhrase: 5,
    objects: [{ id: "phone", before: "empty review form", after: "review submitted" }],
  };
  // тот же id и та же обязательность, но обещание уже другое
  const rewritten: StoryEvent = {
    ...original, observable: "Gudini places his phone on the table",
    objects: [{ id: "phone", before: "in his pocket", after: "resting on the table" }],
  };
  const kept = preserveRequired([original], [rewritten]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].observable, original.observable, "подменённое обещание обязано вернуться");
  assert.deepEqual(kept[0].objects, original.objects);

  // и план, собранный по подменённому обещанию, не проходит ворота
  const raw = controlRaw().map((r) => (r.eventIds[0] === "review"
    ? { ...r, visualAction: "Gudini places his phone on the table", keyMoment: "the phone reaches the table", objects: [{ id: "phone", before: "in his pocket", after: "resting on the table" }] }
    : r));
  const words = controlSpeech();
  const duration = words[words.length - 1].end;
  const beats = beatsFromRaw(raw as any, phrasesFromWords(words), duration, words);
  const plan = buildFilmPlan({ character, bible: bibleWith([...EVENTS.filter((e) => e.id !== "review"), ...kept]), beats, duration, cfg: cfg() });
  assert.ok(plan.issues.some((i) => i.code === "event-not-covered" && (i.eventIds ?? []).includes("review")), JSON.stringify(plan.issues));
});

test("полностью испорченная запись контракта остаётся ошибкой рядом с исправной", () => {
  const bible = bibleWith([EVENTS[0], { id: "", observable: "", required: true, fromPhrase: 1, toPhrase: 1, objects: [] } as StoryEvent]);
  assert.equal(bible.eventsDropped, 1, "потерянная запись обязана быть посчитана");
  const issues = auditPlan(controlPlan().beats, bible, character);
  assert.ok(issues.some((i) => i.code === "event-contract-broken" && i.severity === "block"), JSON.stringify(issues));
});

test("срок события не выходит за использованный отрезок клипа", () => {
  const words = controlSpeech();
  const duration = words[words.length - 1].end;
  const tear = controlPlan().beats.find((b) => b.eventIds.includes("tear"))!;
  // якорь у самого конца бита: округление вверх выносило срок за край окна
  const late = { ...tear, anchorAtSec: Math.max(0, tear.end - tear.start - 0.05) };
  const shot = buildFilmPlan({ character, bible: bibleWith(EVENTS), beats: [late], duration, cfg: cfg() }).shots[0];
  assert.ok(shot.changeBySec != null);
  assert.ok(shot.changeBySec! <= shot.usedSeconds, `срок ${shot.changeBySec} за пределами окна ${shot.usedSeconds}`);
  assert.ok(shot.prompt.includes(`by second ${shot.changeBySec} of the clip`), shot.prompt.slice(0, 400));
});

test("бюджет снимает необязательную вставку раньше обязательного события", () => {
  const words = controlSpeech();
  const duration = words[words.length - 1].end;
  // необязательное открывание занавески в начале и обязательный отзыв позже
  const curtain: StoryEvent = { id: "curtain", observable: "the curtain opens", required: false, fromPhrase: 1, toPhrase: 1, objects: [{ id: "curtain", before: "closed", after: "open" }] };
  const review = EVENTS.find((e) => e.id === "review")!;
  const raw = [
    { ...controlRaw()[0], visualAction: "A hand opens the curtain", keyMoment: "the curtain opens", eventIds: ["curtain"], objects: [{ id: "curtain", before: "closed", after: "open" }], priority: "medium" },
    controlRaw()[4],
  ];
  const beats = beatsFromRaw(raw as any, phrasesFromWords(words), duration, words);
  // денег ровно на один запрос
  const plan = buildFilmPlan({ character, bible: bibleWith([curtain, review]), beats, duration, cfg: cfg({ budgetUsd: 0.64 }) });
  assert.equal(plan.shots.length, 1, JSON.stringify(plan.shots.map((s) => s.beatIds)));
  assert.ok(plan.shots[0].eventIds.includes("review"), `сняли не ту сцену: ${JSON.stringify(plan.shots[0].eventIds)}`);
  assert.deepEqual(plan.issues.filter((i) => i.severity === "block"), [], JSON.stringify(plan.issues));
});

// ─────────────────────────────── 10. контрпримеры разбора версии 11

test("уже порванный купол не засчитывается за показ разрыва", () => {
  const tear: StoryEvent = {
    id: "tear", observable: "The intact main canopy tears into strips in the air", required: true, fromPhrase: 3, toPhrase: 3,
    objects: [{ id: "main-canopy", before: "intact orange canopy", after: "torn into strips" }],
  };
  const withStates = (visualAction: string, keyMoment: string, before: string, after: string) => {
    const raw = controlRaw().map((r) => (r.eventIds[0] === "tear"
      ? { ...r, visualAction, keyMoment, objects: [{ id: "main-canopy", before, after }] }
      : r));
    const words = controlSpeech();
    const duration = words[words.length - 1].end;
    const beats = beatsFromRaw(raw as any, phrasesFromWords(words), duration, words);
    const bible = bibleWith([...EVENTS.filter((e) => e.id !== "tear"), tear]);
    return buildFilmPlan({ character, bible, beats, duration, cfg: cfg() });
  };
  const missed = (p: ReturnType<typeof withStates>) =>
    p.issues.some((i) => i.code === "event-not-covered" && (i.eventIds ?? []).includes("tear"));

  // последствие вместо самого перехода: разрыв уже случился до начала сцены
  assert.ok(
    missed(withStates(
      "Gudini falls beneath the already torn main canopy; the strips flap in the wind",
      "the loose strips flap in the wind",
      "torn into strips", "torn into strips fluttering in the wind",
    )),
    "колыхание полос — это не разрыв",
  );
  // настоящий переход проходит
  assert.ok(
    !missed(withStates(
      "The intact orange canopy splits and tears into strips above Gudini",
      "the canopy tears into strips",
      "intact orange canopy", "torn into strips",
    )),
    "целый купол, который рвётся, обязан закрывать событие",
  );
});

test("первый клип цепочки не требует того, что произойдёт в продолжении", () => {
  const beat: StoryBeat = {
    id: "B1", start: 0, end: 12, meaning: "", storyBeat: "", displayMode: "full_ai", purpose: "explain",
    priority: "high", requiresGeneration: true, gudiniVisible: false, universeAdaptation: "",
    visualAction: "A hand opens the sealed box and removes the lid", keyMoment: "the box opens",
    anchorPhrase: "", anchorAtSec: 10, anchorAbsSec: 10, eventIds: ["open"],
    objects: [{ id: "box", before: "sealed", after: "open" }],
    location: "a kitchen", motion: "the lid comes off", stateBefore: "sealed", stateAfter: "open",
    continuityGroup: "c", continuityRequired: true, transition: "cut", shotType: "medium",
    camera: "Camera is at eye level", cameraAngle: "eye_level", composition: "center", suggestedDuration: 12,
  };
  const bible = bibleWith([{ id: "open", observable: "the box opens", required: true, fromPhrase: 1, toPhrase: 1, objects: beat.objects }]);
  const plan = buildFilmPlan({ character, bible, beats: [beat], duration: 12, cfg: cfg() });
  assert.deepEqual(plan.shots.map((s) => s.mode), ["text", "extend"]);
  const [head, tail] = plan.shots;

  // первый клип: коробка остаётся закрытой, открытие в нём не запрашивается
  assert.deepEqual(head.deadlines, []);
  assert.ok(!head.prompt.includes("After: box — open"), head.prompt.slice(0, 500));
  assert.ok(head.prompt.includes("At the end of this clip: box — sealed"), head.prompt.slice(0, 500));
  assert.ok(head.prompt.includes("Do not show the box opens in this clip"), head.prompt.slice(0, 500));

  // продолжение: начинается с того же закрытого состояния и требует открытия
  assert.ok(tail.prompt.includes("Previous moment: box — sealed"), tail.prompt.slice(0, 300));
  assert.ok(tail.prompt.includes("has not happened yet"), tail.prompt.slice(0, 300));
  assert.ok(tail.prompt.includes("the box opens"), tail.prompt.slice(0, 400));
  assert.equal(tail.changeBySec, 2);
  assert.ok(tail.prompt.includes("After: box — open"), tail.prompt.slice(0, 600));
});

test("защищённое необязательное вступление уступает обязательному событию", () => {
  const words = controlSpeech();
  const duration = words[words.length - 1].end;
  const intro: StoryEvent = { id: "intro", observable: "he puts the phone on the table", required: false, fromPhrase: 1, toPhrase: 1, objects: [{ id: "phone", before: "in his pocket", after: "resting on the table" }] };
  const review = EVENTS.find((e) => e.id === "review")!;
  const raw = [
    { ...controlRaw()[0], visualAction: "Gudini puts his phone on the table", keyMoment: "the phone reaches the table", eventIds: ["intro"], objects: [{ id: "phone", before: "in his pocket", after: "resting on the table" }], purpose: "hook", priority: "high" },
    { ...controlRaw()[4], purpose: "resolution", priority: "high" },
  ];
  const beats = beatsFromRaw(raw as any, phrasesFromWords(words), duration, words);
  const plan = buildFilmPlan({ character, bible: bibleWith([intro, review]), beats, duration, cfg: cfg({ budgetUsd: 0.64 }) });
  assert.equal(plan.shots.length, 1, JSON.stringify(plan.shots.map((s) => s.eventIds)));
  assert.ok(plan.shots[0].eventIds.includes("review"), `защита вступления вытеснила обязательное событие: ${JSON.stringify(plan.shots[0].eventIds)}`);
  assert.deepEqual(plan.issues.filter((i) => i.severity === "block"), [], JSON.stringify(plan.issues));
});

test("контрольная история: у каждого события в запросе стоит именно его переход", () => {
  const { plan, bible } = controlPlan();
  assert.deepEqual(plan.issues.filter((i) => i.severity === "block"), [], JSON.stringify(plan.issues));

  // что именно просят показать для каждого обязательного события
  const wanted: Record<string, { action: RegExp; change: RegExp; after: RegExp }> = {
    order: { action: /taps buy/i, change: /the order goes through/i, after: /order placed/i },
    delivery: { action: /tears open the delivered parcel/i, change: /the parcel opens/i, after: /open and empty/i },
    tear: { action: /tears apart/i, change: /the canopy tears/i, after: /torn into strips/i },
    reserve: { action: /reserve canopy opens/i, change: /the reserve opens/i, after: /fully open/i },
    review: { action: /types a review/i, change: /sends the review/i, after: /review typed/i },
  };
  for (const [id, want] of Object.entries(wanted)) {
    const shot = plan.shots.find((s) => s.eventIds.includes(id));
    assert.ok(shot, `событие ${id} не попало ни в один запрос`);
    assert.match(shot!.prompt, want.action, `${id}: в запросе не то действие`);
    assert.match(shot!.prompt, want.change, `${id}: в запросе не названо нужное изменение`);
    assert.match(shot!.prompt, want.after, `${id}: в запросе нет обещанного результата`);
    // и событие действительно закрывается по контракту, а не по совпадению слов
    const event = (bible.events ?? []).find((e) => e.id === id)!;
    assert.ok(eventCovered(event, plan.beats, plan.shots), `${id}: переход не подтверждён конечными запросами`);
  }

  // приземление отзывом не становится: в запросе отзыва нет посадки
  const review = plan.shots.find((s) => s.eventIds.includes("review"))!;
  assert.doesNotMatch(review.prompt, /lands on the grass/i);
  // каждый запрос просит своё, а не один и тот же кадр
  assert.equal(new Set(plan.shots.map((s) => s.prompt)).size, plan.shots.length);
});

// ─────────────────────────────── 11. проверка на настоящем ответе планировщика

test("живое описание результата засчитывается, подмена — нет", () => {
  // формулировки из настоящего плана: контракт и сцена говорят об одном разными словами
  const review: StoryEvent = {
    id: "review", observable: "Gudini taps on his phone screen typing out a product review", required: true,
    fromPhrase: 5, toPhrase: 5,
    objects: [{ id: "phone", before: "dark screen, held loosely in hand", after: "screen showing a typed review text being entered" }],
  };
  const beat = (before: string, after: string): StoryBeat => ({
    ...controlPlan().beats.find((b) => b.eventIds.includes("review"))!,
    objects: [{ id: "phone", before, after }],
  });
  assert.ok(
    eventCovered(review, [beat("in his hand, screen off", "in his hand, showing a typed review on screen")]),
    "то же самое другими словами обязано засчитываться",
  );
  assert.ok(
    !eventCovered(review, [beat("in his pocket", "resting on the table")]),
    "перекладывание телефона по-прежнему не закрывает отзыв",
  );
  assert.ok(
    !eventCovered(review, [beat("dark screen, held loosely in hand", "dark screen, held loosely in his other hand")]),
    "смена руки — не отправленный отзыв",
  );
});

test("предмет обстановки в записи события не требуется от сцены", () => {
  // из настоящего плана: событие про запасной купол упоминает и основной — как обстановку
  const deploy: StoryEvent = {
    id: "reserve-deploys", observable: "Gudini pulls the reserve handle and the grey reserve canopy opens fully above him",
    required: true, fromPhrase: 4, toPhrase: 4,
    objects: [
      { id: "reserve-canopy", before: "packed flat inside a harness pouch, unopened", after: "fully open grey canopy billowing above him" },
      { id: "main-canopy", before: "torn into shredded orange strips", after: "still torn into shredded orange strips, flapping uselessly alongside" },
    ],
  };
  const base = controlPlan().beats.find((b) => b.eventIds.includes("reserve"))!;
  const beat: StoryBeat = {
    ...base, eventIds: ["reserve-deploys"],
    objects: [{ id: "reserve-canopy", before: "packed tightly in a harness pouch on his chest", after: "fully open grey canopy overhead, slowing his fall" }],
  };
  assert.ok(eventCovered(deploy, [beat]), "показанный запасной купол закрывает событие про запасной купол");
  // но подменить его основным куполом нельзя
  const wrong: StoryBeat = { ...beat, objects: [{ id: "main-canopy", before: "torn", after: "still torn and flapping" }] };
  assert.ok(!eventCovered(deploy, [wrong]));
});

test("переименованное обязательство не превращается в два", () => {
  const first: StoryEvent = {
    id: "canopy-opens-and-tears", observable: "the orange main canopy inflates then rips apart", required: true,
    fromPhrase: 3, toPhrase: 3,
    objects: [{ id: "main-canopy", before: "packed inside the harness", after: "torn into flapping shredded orange strips" }],
  };
  const renamed: StoryEvent = {
    ...first, id: "canopy-tears", observable: "the orange main canopy opens briefly then rips apart in mid-air",
    objects: [{ id: "main-canopy", before: "opening fully overhead, intact orange nylon", after: "torn into ragged flapping pieces" }],
  };
  const kept = preserveRequired([first], [renamed]);
  assert.equal(kept.length, 1, `обязательство задвоилось: ${JSON.stringify(kept.map((e) => e.id))}`);
  assert.equal(kept[0].id, "canopy-tears");
  // а настоящая потеря события по-прежнему возвращается
  const other: StoryEvent = { ...first, id: "landing", observable: "his feet hit the ground", objects: [{ id: "boots", before: "in the air", after: "on the grass" }] };
  assert.equal(preserveRequired([first], [other]).length, 2);
});

test("короткая сцена с событием занимает время у соседа, а не уходит автору", () => {
  // из настоящего плана: раскрытию запасного купола досталось 1.2 с между двумя сценами
  const words = controlSpeech();
  const duration = words[words.length - 1].end;
  const phrases = phrasesFromWords(words);
  const raw = [
    { ...controlRaw()[0] },
    { ...controlRaw()[2], fromPhrase: 3, toPhrase: 3 },
    { ...controlRaw()[3], fromPhrase: 4, toPhrase: 4 },
    { ...controlRaw()[4], fromPhrase: 5, toPhrase: 5 },
  ];
  const beats = beatsFromRaw(raw as any, phrases, duration, words);
  const reserve = beats.find((b) => (b.eventIds ?? []).includes("reserve"));
  assert.ok(reserve, "сцена запасного купола пропала из плана");
  assert.notEqual(reserve!.displayMode, "author", `сцена с событием ушла автору: ${reserve!.reduced ?? ""}`);
  assert.ok(reserve!.end - reserve!.start >= MIN_SHOWN_AI_SEC - 1e-6, `сцена короче порога показа: ${reserve!.end - reserve!.start}`);

  // биты остаются встык: время у соседа занято, а не выдумано
  for (let i = 1; i < beats.length; i++) {
    assert.ok(Math.abs(beats[i].start - beats[i - 1].end) < 1e-6, `разрыв между ${beats[i - 1].id} и ${beats[i].id}`);
  }
  assert.ok(Math.abs(beats[beats.length - 1].end - duration) < 0.5, "речь покрыта целиком");
});

test("сцена «перед прыжком» после прыжка получает замечание порядка", () => {
  const raw = controlRaw().map((r, i) => (i === 3
    ? { ...r, visualAction: "Before the jump, Gudini straps the grey reserve pack onto his chest in a room", keyMoment: "the reserve pack goes from the floor onto his chest", location: "a room" }
    : r));
  const { plan } = controlPlan(raw as any);
  const out = plan.issues.find((i) => i.code === "scene-out-of-order");
  assert.ok(out, `флешбэк после прыжка обязан быть виден: ${JSON.stringify(plan.issues.map((i) => i.code))}`);
  assert.equal(out!.severity, "warn");
  // обычная сцена такого замечания не получает
  assert.ok(!controlPlan().plan.issues.some((i) => i.code === "scene-out-of-order"));
});

test("экран с картинкой — замечание, требование разборчивых букв — запрет", () => {
  const withAction = (visualAction: string, keyMoment: string) => {
    const raw = controlRaw().map((r, i) => (i === 0 ? { ...r, visualAction, keyMoment } : r));
    return controlPlan(raw as any).plan.issues;
  };
  // экран с товаром снять можно: подпись выйдет нечитаемой, но событие читается по действию
  const soft = withAction("Gudini sits at a desk and looks at a laptop screen showing a product photo of a parachute, then taps buy", "the screen changes to an order confirmation");
  assert.ok(!soft.some((i) => i.code === "readable-text"), JSON.stringify(soft.map((i) => i.code)));
  assert.ok(soft.some((i) => i.code === "screen-content" && i.severity === "warn"), JSON.stringify(soft.map((i) => i.code)));
  // а вот разборчивые буквы Veo не выводит вовсе
  const hard = withAction("Gudini holds a receipt and the text on it says five dollars", "the price is clearly shows the price on paper");
  assert.ok(hard.some((i) => i.code === "readable-text" && i.severity === "block"), JSON.stringify(hard.map((i) => i.code)));
});

test("ссылка сцены на событие, забытое в контракте, чинится, а не блокирует план", async () => {
  const { reconcileEventRefs } = await import("../lib/aiFilm/story");
  const bible = bibleWith(EVENTS.filter((e) => e.id !== "review"));
  const { beats } = controlPlan();
  const added = reconcileEventRefs(bible, beats);
  assert.equal(added, 1, "забытое событие обязано вернуться в контракт");
  const restored = bible.events.find((e) => e.id === "review")!;
  assert.equal(restored.required, false, "восстановленное событие необязательное: обязательность ставит только модель");
  assert.ok(restored.objects.length, "у восстановленного события есть проверяемые предметы");
  const issues = auditPlan(beats, bible, character);
  assert.ok(!issues.some((i) => i.code === "event-unknown-reference"), JSON.stringify(issues.map((i) => i.code)));

  // сцена без предметов подтвердить нечем — ссылка остаётся битой и разбор об этом говорит
  const bare = bibleWith(EVENTS.filter((e) => e.id !== "review"));
  const stripped = beats.map((b) => (b.eventIds.includes("review") ? { ...b, objects: [] } : b));
  assert.equal(reconcileEventRefs(bare, stripped), 0);
  assert.ok(auditPlan(stripped, bare, character).some((i) => i.code === "event-unknown-reference"));
});
