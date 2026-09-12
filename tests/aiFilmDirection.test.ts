import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { beatsFromRaw, phrasesFromWords, normalizeBible } from "../lib/aiFilm/story";
import { buildFilmPlan } from "../lib/aiFilm/plan";
import { gateIssues } from "../lib/aiFilm/criteria";
import { loadCharacterProfile } from "../lib/aiFilm/character";
import { loadUniverseProfile } from "../lib/aiFilm/universe";
import type { AiFilmPlan, CharacterProfile, StoryEvent } from "../lib/aiFilm/types";
import type { PlanConfig } from "../lib/aiFilm/plan";
import type { Word } from "../lib/transcribe";

/**
 * Приёмка ОБЩЕЙ режиссуры: те же правила должны работать на разных темах, а не на истории
 * про парашют. Истории здесь вымышленные и нарочно разные — передача предмета, дорожные
 * работы, уступленное место, причина и следствие без героя, возврат в прежнее место,
 * обратимое изменение. Проверяется конечный запрос и готовность плана, а не наличие полей.
 *
 * Платных вызовов нет: сюда попадают уже готовые ответы планировщика, а не запрос к модели.
 */

const universe = loadUniverseProfile("gudini-photoreal", path.join(process.cwd(), "assets", "ai-film", "universes"));
const loaded = loadCharacterProfile("gudini-real", path.join(process.cwd(), "assets", "ai-film", "characters"));
const character: CharacterProfile = { ...loaded, referenceFiles: ["/tmp/ref.png"] };

const cfg = (over: Partial<PlanConfig> = {}): PlanConfig => ({
  key: "k", universe, budgetUsd: 12, maxCoverage: 1, concurrency: 3, callMinutes: 2, ...over,
});

/** Речь из коротких фраз: по одной на сцену, чтобы биты ложились предсказуемо. */
function speech(phrases: string[], per = 0.6): Word[] {
  const out: Word[] = [];
  let at = 0;
  for (const text of phrases) {
    for (const w of text.split(" ")) {
      out.push({ word: w, start: at, end: at + per * 0.9 });
      at += per;
    }
    at += 0.6;
  }
  return out;
}

type Raw = Record<string, unknown>;

function planOf(lines: string[], raw: Raw[], events: StoryEvent[], over: Partial<PlanConfig> = {}): AiFilmPlan {
  const words = speech(lines);
  const duration = words[words.length - 1].end;
  const beats = beatsFromRaw(raw as any, phrasesFromWords(words), duration, words);
  const bible = normalizeBible({ bible: { storyType: "explainer", events } } as any, character, universe);
  return buildFilmPlan({ character, bible, beats, duration, cfg: cfg(over) });
}

const scene = (over: Raw): Raw => ({
  fromPhrase: 1, toPhrase: 1, displayMode: "full_ai", priority: "high", purpose: "explain",
  cameraAngle: "eye_level", camera: "Camera is at eye level beside the table", motion: "his hand moves",
  location: "a room", eventIds: [], objects: [], ...over,
});

// ─────────────────────────────── передача предмета: роли и владелец сохраняются

test("передача письма: предмет один, владелец меняется, эпоха сохраняется", () => {
  const handover: StoryEvent = {
    id: "handover", observable: "the sealed letter passes from the courier to the merchant", required: true,
    fromPhrase: 2, toPhrase: 2, objects: [{ id: "letter", before: "in the courier's hand, sealed", after: "in the merchant's hand, still sealed" }],
  };
  const plan = planOf(
    ["Посыльный весь день вёз запечатанное письмо через город до самой лавки.", "У прилавка он передал это письмо торговцу из рук в руки.", "Восковую печать на нём сломали только поздно вечером при свече."],
    [
      scene({ fromPhrase: 1, toPhrase: 1, visualAction: "A courier in a wool riding coat steps up to a wooden counter holding a sealed letter", keyMoment: "the courier reaches the counter", purpose: "setup", eventIds: [], objects: [], scene: { props: ["the same sealed wax-stamped letter"], who: "the courier faces the counter, the merchant behind it" } }),
      scene({ fromPhrase: 2, toPhrase: 2, visualAction: "The courier holds out the sealed letter and the merchant takes it with both hands", keyMoment: "the letter passes into the merchant's hands", eventIds: ["handover"], objects: [{ id: "letter", before: "in the courier's hand, sealed", after: "in the merchant's hand, still sealed" }], scene: { who: "the courier on the left, the merchant behind the counter on the right", props: ["the same sealed wax-stamped letter"] }, camera: "Camera is level with the counter three steps back; both pairs of hands stay in frame" }),
      scene({ fromPhrase: 3, toPhrase: 3, visualAction: "The merchant breaks the wax seal and unfolds the letter", keyMoment: "the wax seal breaks", eventIds: [], objects: [{ id: "letter", before: "in the merchant's hand, still sealed", after: "unfolded, broken wax on the counter" }] }),
    ],
    [handover],
  );
  assert.deepEqual(gateIssues(plan), [], JSON.stringify(plan.issues));
  const shot = plan.shots.find((s) => s.eventIds.includes("handover"))!;
  // предмет назван и не потерян, передача видна, участники не слиты в одного
  assert.match(shot.prompt, /sealed wax-stamped letter/);
  assert.match(shot.prompt, /passes into the merchant's hands/);
  assert.match(shot.prompt, /courier on the left, the merchant behind the counter on the right/);
  // готовый результат в первой сцене событием не считается
  assert.ok(!plan.shots[0].eventIds.includes("handover"));
});

// ─────────────────────────────── событие без изменения предмета

test("уступленное место: событие без ломания предмета проходит проверку", () => {
  const yield_: StoryEvent = {
    id: "seat", observable: "the seat changes owner: he stands up and the older passenger sits down", required: true,
    fromPhrase: 2, toPhrase: 2, objects: [{ id: "seat", before: "taken by the young passenger", after: "taken by the older passenger" }],
  };
  const plan = planOf(
    ["В вагоне трамвая было тесно, люди стояли в проходе вплотную.", "Он поднялся со своего места и уступил его пожилому пассажиру.", "Дальше всю дорогу он ехал стоя и держался за поручень."],
    [
      scene({ fromPhrase: 1, toPhrase: 1, purpose: "setup", visualAction: "A crowded tram carriage moves, people stand in the aisle", keyMoment: "the carriage is full", location: "a tram carriage", eventIds: [], objects: [] }),
      scene({
        fromPhrase: 2, toPhrase: 2, location: "a tram carriage",
        visualAction: "The young passenger stands up and steps aside, and the older passenger sits down in the freed seat",
        keyMoment: "the older passenger sits down in the freed seat", eventIds: ["seat"],
        objects: [{ id: "seat", before: "taken by the young passenger", after: "taken by the older passenger" }],
        camera: "Camera is level with the seats across the aisle; the exchange happens across frame",
        scene: { who: "the young passenger by the window, the older passenger in the aisle" },
      }),
      scene({ fromPhrase: 3, toPhrase: 3, purpose: "resolution", location: "a tram carriage", visualAction: "The young passenger holds the overhead rail and rides standing", keyMoment: "he rides standing", eventIds: [], objects: [] }),
    ],
    [yield_],
  );
  assert.deepEqual(gateIssues(plan), [], JSON.stringify(plan.issues));
  // сцена обстановки не обязана ничего ломать и не считается провальной
  assert.ok(!plan.warnings.some((w) => /Сцены без события \(B1\)/.test(w)), plan.warnings.join(" | "));
});

// ─────────────────────────────── причина раньше следствия, героя в кадре нет

test("мяч и стакан: причина и контакт предшествуют следствию, герой не нужен", () => {
  const knock: StoryEvent = {
    id: "glass", observable: "the rolling ball hits the glass and the glass goes over the edge", required: true,
    fromPhrase: 1, toPhrase: 1, objects: [{ id: "glass", before: "upright on the table edge", after: "tipped over the edge and falling" }],
  };
  const plan = planOf(
    ["Теннисный мяч медленно катился по столу прямо к краю стакана.", "Стакан от толчка ушёл за край стола и полетел вниз."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, gudiniVisible: false,
        visualAction: "A tennis ball rolls across the table, touches the base of the glass and pushes it over the edge",
        keyMoment: "the ball touches the glass and the glass tips over the edge", eventIds: ["glass"],
        objects: [{ id: "glass", before: "upright on the table edge", after: "tipped over the edge and falling" }],
        scene: { props: ["the same tennis ball", "a plain drinking glass"], mechanics: "the ball keeps rolling after contact, the glass tips from the push and leaves the table" },
        camera: "Camera is beside the table at table height; the ball crosses frame left to right into the glass",
        motion: "the ball rolls into the glass, then the glass tips over the edge",
      }),
      scene({ fromPhrase: 2, toPhrase: 2, purpose: "resolution", gudiniVisible: false, visualAction: "The glass lands on the floor and rolls to a stop", keyMoment: "the glass comes to rest on the floor", eventIds: [], objects: [{ id: "glass", before: "falling", after: "on the floor, at rest" }] }),
    ],
    [knock],
  );
  assert.deepEqual(gateIssues(plan), [], JSON.stringify(plan.issues));
  const shot = plan.shots[0];
  assert.match(shot.prompt, /How it physically happens: the ball keeps rolling after contact/);
  // мяч в кадре весь клип, стакан меняется — он в отдельной строке, привязанной к действию
  assert.match(shot.prompt, /Present in frame throughout: the same tennis ball/);
  assert.match(shot.prompt, /In frame, in the state the action describes at that moment: a plain drinking glass/);
});

// ─────────────────────────────── A→B→A и сохранение предмета между сценами

test("стол → дверь → стол: возврат допустим, предмет сохраняется", () => {
  const delivery: StoryEvent = {
    id: "parcel", observable: "the parcel moves from the courier to his hands", required: true,
    fromPhrase: 2, toPhrase: 2, objects: [{ id: "parcel", before: "in the courier's hands", after: "in his own hands" }],
  };
  const plan = planOf(
    ["Он спокойно работал за своим заваленным бумагами столом почти всё утро.", "Курьер принёс посылку прямо к двери квартиры и передал её.", "С этой самой посылкой он вернулся обратно к рабочему столу."],
    [
      scene({ fromPhrase: 1, toPhrase: 1, purpose: "setup", location: "a home desk", visualAction: "Gudini works at a cluttered desk", keyMoment: "he is working at the desk", gudiniVisible: true, eventIds: [], objects: [] }),
      scene({ fromPhrase: 2, toPhrase: 2, location: "a flat doorway", gudiniVisible: true, visualAction: "Gudini takes a taped cardboard parcel from the courier at the door", keyMoment: "the parcel passes into his hands", eventIds: ["parcel"], objects: [{ id: "parcel", before: "in the courier's hands", after: "in his own hands" }], scene: { props: ["the same taped cardboard parcel"] }, cameraAngle: "profile", camera: "Camera is in the hallway to the side; the parcel crosses between them" }),
      scene({ fromPhrase: 3, toPhrase: 3, location: "a home desk", gudiniVisible: true, purpose: "resolution", visualAction: "Gudini sets the same taped cardboard parcel down on the desk", keyMoment: "the parcel lands on the desk", eventIds: [], objects: [{ id: "parcel", before: "in his own hands", after: "on the desk" }], scene: { props: ["the same taped cardboard parcel"] } }),
    ],
    [delivery],
  );
  // возврат в прежнее место не запрещает генерацию
  assert.deepEqual(gateIssues(plan), [], JSON.stringify(plan.issues));
  const back = plan.shots[plan.shots.length - 1];
  assert.match(back.prompt, /the same taped cardboard parcel/);
});

// ─────────────────────────────── обратимое изменение

test("шар надувают и сдувают: обратный переход допустим и получает своё время", () => {
  const events: StoryEvent[] = [
    { id: "inflate", observable: "the balloon fills with air", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "balloon", before: "flat rubber in his fingers", after: "round and tight with air" }] },
    { id: "deflate", observable: "the balloon empties again", required: true, fromPhrase: 2, toPhrase: 2, objects: [{ id: "balloon", before: "round and tight with air", after: "flat rubber again, air gone" }] },
  ];
  const plan = planOf(
    ["Он надувал резиновый шар до тех пор, пока тот не стал тугим.", "Потом он отпустил горлышко, и шар сдулся прямо у него в руке."],
    [
      scene({ fromPhrase: 1, toPhrase: 1, gudiniVisible: true, visualAction: "Gudini blows into a flat rubber balloon until it is round and tight", keyMoment: "the balloon fills and goes tight", eventIds: ["inflate"], objects: [{ id: "balloon", before: "flat rubber in his fingers", after: "round and tight with air" }], scene: { mechanics: "the rubber stretches as air enters, the neck stays pinched between his fingers" } }),
      scene({ fromPhrase: 2, toPhrase: 2, gudiniVisible: true, cameraAngle: "profile", camera: "Camera is to his side at hand height", visualAction: "Gudini lets the neck go and the balloon empties in his hand", keyMoment: "the balloon goes flat again", eventIds: ["deflate"], objects: [{ id: "balloon", before: "round and tight with air", after: "flat rubber again, air gone" }], scene: { mechanics: "air escapes through the released neck and the rubber collapses onto his palm" } }),
    ],
    events,
  );
  assert.deepEqual(gateIssues(plan), [], JSON.stringify(plan.issues));
  assert.equal(plan.shots.length, 2, "каждому переходу нужен свой клип");
  assert.ok(!plan.issues.some((i) => i.code === "state-regression"), JSON.stringify(plan.issues));
});

// ─────────────────────────────── контрпримеры: что теперь не проходит

test("контрпримеры общей режиссуры выявляются", () => {
  const pass: StoryEvent = {
    id: "keys", observable: "the keys pass from the owner to the neighbour", required: true, fromPhrase: 1, toPhrase: 1,
    objects: [{ id: "keys", before: "in the owner's hand", after: "in the neighbour's hand" }],
  };
  const codes = (over: Raw, events: StoryEvent[] = [pass]) =>
    planOf(
      ["Он протянул ключи от квартиры соседу и тот забрал их себе.", "Сосед с этими ключами ушёл вниз по лестнице и скрылся."],
      [
        scene({ fromPhrase: 1, toPhrase: 1, visualAction: "He holds out the keys and the neighbour takes them", keyMoment: "the keys pass into the neighbour's hand", eventIds: ["keys"], objects: [{ id: "keys", before: "in the owner's hand", after: "in the neighbour's hand" }], ...over }),
        scene({ fromPhrase: 2, toPhrase: 2, purpose: "resolution", visualAction: "The neighbour walks away down the stairs", keyMoment: "he is gone", eventIds: [], objects: [] }),
      ],
      events,
    ).issues.map((i) => `${i.code}:${i.severity}`);

  // готовый результат вместо совершения
  assert.ok(
    codes({ visualAction: "The neighbour already holds the keys", keyMoment: "the keys are with the neighbour", objects: [{ id: "keys", before: "in the neighbour's hand", after: "in the neighbour's hand, being pocketed" }] })
      .includes("event-not-covered:block"),
  );
  // состояние предмета описывает позу человека
  assert.ok(
    codes({ objects: [{ id: "keys", before: "standing in the doorway, facing the neighbour", after: "in the neighbour's hand" }] })
      .some((c) => c.startsWith("object-state-describes-person")),
  );
  // камера уже описывает конечное состояние, хотя сцена начинается с исходного
  assert.ok(
    codes({ camera: "Camera is at eye level; the keys already in the neighbour's hand fill the frame" })
      .includes("phase-conflict:block"),
  );
  // сопровождение без ориентира движения
  assert.ok(
    codes({ camera: "Camera follows him at a constant distance", motion: "he walks" })
      .some((c) => c.startsWith("follow-without-reference")),
  );
  // исправная сцена не даёт ни одного из этих замечаний
  const clean = codes({});
  for (const bad of ["event-not-covered", "object-state-describes-person", "phase-conflict", "follow-without-reference"]) {
    assert.ok(!clean.some((c) => c.startsWith(bad)), `${bad} на исправной сцене: ${clean.join(", ")}`);
  }
});

test("имена и предметы не влияют на результат: та же структура на других словах", () => {
  const make = (thing: string, from: string, to: string) => {
    const ev: StoryEvent = {
      id: "move", observable: `the ${thing} passes from one hand to the other`, required: true, fromPhrase: 1, toPhrase: 1,
      objects: [{ id: thing, before: from, after: to }],
    };
    return planOf(
      ["Он протянул этот предмет второму человеку и тот забрал его себе.", "Второй человек с ним ушёл вниз по лестнице и скрылся."],
      [
        scene({ fromPhrase: 1, toPhrase: 1, visualAction: `He holds out the ${thing} and the other man takes it`, keyMoment: `the ${thing} passes into the other man's hand`, eventIds: ["move"], objects: [{ id: thing, before: from, after: to }] }),
        scene({ fromPhrase: 2, toPhrase: 2, purpose: "resolution", visualAction: "The other man walks away", keyMoment: "he is gone", eventIds: [], objects: [] }),
      ],
      [ev],
    );
  };
  const a = make("ticket", "in his own hand", "in the other man's hand");
  const b = make("wrench", "on the workbench", "in the other man's hand");
  assert.deepEqual(gateIssues(a), [], JSON.stringify(a.issues));
  assert.deepEqual(gateIssues(b), [], JSON.stringify(b.issues));
  assert.deepEqual(
    a.issues.map((i) => i.code).sort(),
    b.issues.map((i) => i.code).sort(),
    "результат зависит от слов, а не от структуры истории",
  );
});
