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
 * Приёмка единого описания монтажного окна: реквизит, расстановка, участники, фаза события
 * и состояния берутся из одного согласованного места, и проверки опираются на него же.
 *
 * Здесь лежат контрпримеры разбора версии 13: постановка второго бита при объединении,
 * участники из расстановки сцены, фаза окна в цепочке, независимость от внутренних имён,
 * наблюдение за процессом против заявления результата, план без обещаний.
 */

const universe = loadUniverseProfile("gudini-photoreal", path.join(process.cwd(), "assets", "ai-film", "universes"));
const loaded = loadCharacterProfile("gudini-real", path.join(process.cwd(), "assets", "ai-film", "characters"));
const character: CharacterProfile = { ...loaded, referenceFiles: ["/tmp/ref.png"] };

const cfg = (over: Partial<PlanConfig> = {}): PlanConfig => ({
  key: "k", universe, budgetUsd: 12, maxCoverage: 1, concurrency: 3, callMinutes: 2, ...over,
});

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

function planOf(lines: string[], raw: Raw[], events: StoryEvent[], extra: Record<string, unknown> = {}): AiFilmPlan {
  const words = speech(lines);
  const duration = words[words.length - 1].end;
  const beats = beatsFromRaw(raw as any, phrasesFromWords(words), duration, words);
  const bible = normalizeBible({ bible: { storyType: "explainer", events, ...extra } } as any, character, universe);
  return buildFilmPlan({ character, bible, beats, duration, cfg: cfg() });
}

const scene = (over: Raw): Raw => ({
  fromPhrase: 1, toPhrase: 1, displayMode: "full_ai", priority: "high", purpose: "explain", gudiniVisible: true,
  cameraAngle: "eye_level", camera: "Camera is at eye level beside the table", motion: "his hands move",
  location: "a room", eventIds: [], objects: [], ...over,
});

test("камера, наблюдающая за действием, не считается противоречием фаз", () => {
  const open: StoryEvent = {
    id: "open", observable: "the envelope goes from sealed to opened", required: true, fromPhrase: 1, toPhrase: 1,
    objects: [{ id: "envelope", before: "sealed", after: "opened" }],
  };
  const withCamera = (camera: string) =>
    planOf(
      ["Он вскрыл конверт прямо у стола и вынул оттуда сложенный вдвое лист.", "Потом он положил лист обратно на стол и вышел."],
      [
        scene({ fromPhrase: 1, toPhrase: 1, camera, visualAction: "He opens the sealed envelope at the table", keyMoment: "the envelope is opened", eventIds: ["open"], objects: [{ id: "envelope", before: "sealed", after: "opened" }] }),
        scene({ fromPhrase: 2, toPhrase: 2, purpose: "resolution", visualAction: "He puts the sheet back and walks out", keyMoment: "he walks out", eventIds: [], objects: [] }),
      ],
      [open],
    ).issues.map((i) => `${i.code}:${i.severity}`);

  const watching = withCamera("Camera stays beside the table and holds the envelope in frame as it is opened");
  assert.ok(!watching.includes("phase-conflict:block"), JSON.stringify(watching));
  // заявление, что кадр НАЧИНАЕТСЯ с результата, противоречием остаётся
  assert.ok(withCamera("Camera is at the table; the opened envelope lies in frame from the first moment").includes("phase-conflict:block"));
});

test("переименование внутренних имён не меняет полноту обязательства", () => {
  const deal = (money: string, item: string) => {
    const ev: StoryEvent = {
      id: "deal", observable: "the buyer pays and receives the cup", required: true, fromPhrase: 1, toPhrase: 1,
      objects: [
        { id: money, before: "in the buyer's hand", after: "in the seller's hand" },
        { id: item, before: "on the seller's counter", after: "in the buyer's hands" },
      ],
    };
    // сцена показывает только оплату: чашка остаётся у продавца
    return planOf(
      ["Покупатель отдал деньги продавцу прямо у прилавка небольшого магазина.", "После этого он отошёл в сторону от прилавка и остановился."],
      [
        scene({ fromPhrase: 1, toPhrase: 1, visualAction: "The buyer puts the notes into the seller's hand", keyMoment: "the notes reach the seller's hand", eventIds: ["deal"], objects: [{ id: money, before: "in the buyer's hand", after: "in the seller's hand" }] }),
        scene({ fromPhrase: 2, toPhrase: 2, purpose: "resolution", visualAction: "The buyer steps away from the counter", keyMoment: "he steps away", eventIds: [], objects: [] }),
      ],
      [ev],
    ).issues.map((i) => i.code).sort();
  };
  assert.ok(deal("money", "cup").includes("event-not-covered"), "неполная сделка обязана блокироваться");
  assert.deepEqual(deal("payment-token", "purchased-item"), deal("money", "cup"), "результат зависит от внутренних имён предметов");
});

test("план без обещаний показывает обстановку и не блокируется", () => {
  const plan = planOf(
    ["Улица в том городе была узкой, кирпичной и очень длинной на вид.", "По ней ходили пешком гораздо чаще, чем ездили на повозках."],
    [
      scene({ fromPhrase: 1, toPhrase: 1, purpose: "setup", gudiniVisible: false, visualAction: "A narrow brick street with cobbles runs between low houses", keyMoment: "the whole length of the street is visible", location: "a narrow brick street" }),
      scene({ fromPhrase: 2, toPhrase: 2, purpose: "explain", gudiniVisible: false, visualAction: "People walk along the cobbles between the houses", keyMoment: "the street is used on foot", location: "a narrow brick street" }),
    ],
    [],
  );
  assert.deepEqual(gateIssues(plan), [], JSON.stringify(plan.issues));
  assert.ok(plan.issues.some((i) => i.code === "no-events-declared" && i.severity === "warn"), JSON.stringify(plan.issues));
});

test("объединённое окно несёт постановку обоих битов и всех участников", () => {
  const events: StoryEvent[] = [
    { id: "open", observable: "the case opens", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "case", before: "sealed", after: "open" }] },
    { id: "valve", observable: "the valve opens", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "valve", before: "closed", after: "open" }] },
  ];
  const plan = planOf(
    ["Он открыл футляр на верстаке и сразу повернул вентиль рядом с ним.", "Дальше он просто ждал, пока давление в трубке упадёт."],
    [
      scene({ fromPhrase: 1, toPhrase: 1, location: "a workshop", visualAction: "Gudini opens the sealed case", keyMoment: "the case opens", anchorPhrase: "открыл", eventIds: ["open"], objects: [{ id: "case", before: "sealed", after: "open" }], scene: { props: ["a round brass clock on the workbench"], who: "Gudini faces the workbench" }, continuityGroup: "c", continuityRequired: true }),
      scene({ fromPhrase: 1, toPhrase: 1, location: "a workshop", visualAction: "Gudini turns the valve", keyMoment: "the valve opens", eventIds: ["valve"], objects: [{ id: "valve", before: "closed", after: "open" }], scene: { worn: ["a clear protective visor"], props: ["a splash guard beside the valve"], who: "Ada stands at the right of the bench" }, continuityGroup: "c", continuityRequired: true }),
      scene({ fromPhrase: 2, toPhrase: 2, purpose: "resolution", location: "a workshop", visualAction: "Gudini waits at the bench", keyMoment: "the needle drops" }),
    ],
    events,
    { supportingCharacters: [{ name: "Ada", function: "partner", appearance: "an adult woman in a green wool coat" }] },
  );
  const merged = plan.shots.find((s) => s.beatIds.length > 1);
  assert.ok(merged, `биты не объединились: ${JSON.stringify(plan.shots.map((s) => s.beatIds))}`);
  // реквизит первого бита держится весь клип, реквизит второго появляется со вторым действием
  assert.match(merged!.prompt, /Present in frame throughout: a round brass clock on the workbench/);
  assert.match(merged!.prompt, /Appears with the later action in this clip: a clear protective visor; a splash guard beside the valve/);
  // расстановка обоих битов на месте, и оба человека считаются участниками
  assert.match(merged!.prompt, /Gudini faces the workbench Then: Ada stands at the right of the bench/);
  // участники берутся из согласованного списка, а число не выдумывается по словам расстановки
  assert.match(merged!.prompt, /only those named above in Positions \(Gudini, Ada among them\), and nobody else/);
});

test("цепочка после раннего изменения не возвращает состояние назад", () => {
  const open: StoryEvent = { id: "open", observable: "the case opens", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "case", before: "sealed", after: "open" }] };
  const plan = planOf(
    ["Он открыл футляр почти сразу и потом очень долго разбирал его содержимое на верстаке до самого позднего вечера того дня."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, location: "a workshop", continuityGroup: "c", continuityRequired: true,
        visualAction: "Gudini opens the sealed case", keyMoment: "the case opens", anchorPhrase: "открыл", eventIds: ["open"],
        objects: [{ id: "case", before: "sealed", after: "open" }],
        scene: { props: ["the same red case"], mechanics: "his fingers break the seal and lift the lid off the case" },
      }),
    ],
    [open],
  );
  assert.ok(plan.shots.length > 1, `длинный бит должен стать цепочкой: ${plan.shots.length}`);
  const [head, ...rest] = plan.shots;
  assert.ok(head.prompt.includes("After: case — open"), head.prompt.slice(0, 400));
  for (const tail of rest) {
    assert.ok(tail.prompt.includes("Already done in the previous clip"), tail.prompt.slice(0, 300));
    assert.ok(!tail.prompt.includes("the action is still under way"), "окно последствий не может быть началом действия");
    assert.ok(!tail.prompt.includes("Do not show the case opens in this clip"), "два взаимоисключающих указания в одном запросе");
    assert.ok(!tail.prompt.includes("break the seal"), "механика открывания не повторяется в последствиях");
  }
});

test("сводка сцены не исчезает из-за имени предмета", () => {
  const build = (id: string) =>
    planOf(
      ["Он держал футляр на коленях и открыл его прямо в узком кресле у самого окна."],
      [
        scene({
          fromPhrase: 1, toPhrase: 1, visualAction: "Gudini opens the sealed case on his knees",
          keyMoment: "the case opens", eventIds: ["open"], objects: [{ id, before: "sealed", after: "open" }],
          stateBefore: "Gudini holds the case on his knees while seated in a narrow chair",
        }),
      ],
      [{ id: "open", observable: "the case opens", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id, before: "sealed", after: "open" }] }],
    ).shots[0].prompt;
  for (const id of ["case", "prop-17"]) {
    assert.ok(build(id).includes("on his knees while seated in a narrow chair"), `постановка потеряна при id ${id}`);
  }
});

test("смешанное окно: завершённое действие не повторяется, новое сохраняет своё", () => {
  const events: StoryEvent[] = [
    { id: "open", observable: "the case opens", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "case", before: "sealed", after: "open" }] },
    { id: "take", observable: "the instrument comes out of the case", required: true, fromPhrase: 2, toPhrase: 2, objects: [{ id: "instrument", before: "in its foam slot", after: "raised above the workbench" }] },
  ];
  const chain = { location: "a workshop", continuityGroup: "c", continuityRequired: true };
  const plan = planOf(
    ["Он открыл запечатанный футляр почти сразу и потом очень долго разглядывал его содержимое при свете лампы.", "Затем он достал инструмент из открытого футляра и поднял его над верстаком."],
    [
      scene({ ...chain, fromPhrase: 1, toPhrase: 1, visualAction: "Gudini opens the sealed case", keyMoment: "the case opens", anchorPhrase: "открыл", eventIds: ["open"], objects: [{ id: "case", before: "sealed", after: "open" }], motion: "Gudini lifts the lid", scene: { mechanics: "his fingers break the seal and lift the lid off the case" } }),
      scene({ ...chain, fromPhrase: 2, toPhrase: 2, visualAction: "Gudini takes the instrument out of the open case", keyMoment: "the instrument comes out of the case", anchorPhrase: "достал", eventIds: ["take"], objects: [{ id: "instrument", before: "in its foam slot", after: "raised above the workbench" }], motion: "Gudini lifts the instrument above the workbench", scene: { mechanics: "his hand lifts the instrument out of its foam slot" } }),
    ],
    events,
  );
  assert.deepEqual(gateIssues(plan), [], JSON.stringify(plan.issues));
  // у каждого бита окна своя фаза, а не одна на весь клип
  assert.ok(plan.shots.every((s) => (s.phases ?? []).length === s.beatIds.length), JSON.stringify(plan.shots.map((s) => s.phases)));
  for (const shot of plan.shots) {
    const doneHere = (shot.phases ?? []).filter((p) => p.phase === "aftermath").map((p) => p.beatId);
    for (const id of doneHere) {
      const beat = plan.beats.find((b) => b.id === id)!;
      assert.ok(!shot.prompt.includes(`Action: ${beat.visualAction}`), `завершённое действие повторяется в ${shot.id}`);
      assert.ok(!shot.prompt.includes(beat.motion), `движение завершённого действия повторяется в ${shot.id}`);
      assert.ok(!shot.prompt.includes(beat.scene!.mechanics!), `механика завершённого действия повторяется в ${shot.id}`);
      assert.ok(shot.prompt.includes("Already done in the previous clip"), shot.prompt.slice(0, 200));
    }
    // новое действие окна на месте вместе со своим сроком
    const fresh = (shot.phases ?? []).filter((p) => p.phase !== "aftermath").map((p) => p.beatId);
    for (const id of fresh) {
      const beat = plan.beats.find((b) => b.id === id)!;
      assert.ok(shot.prompt.includes(beat.visualAction), `действие ${id} потеряно в ${shot.id}`);
    }
  }
});

test("расстановка не превращает заглавные слова в участников", () => {
  const line = (who: string) => {
    const plan = planOf(
      ["Курьер передал ему посылку прямо у стойки и сразу ушёл обратно на улицу."],
      [
        scene({
          fromPhrase: 1, toPhrase: 1, visualAction: "The courier hands the parcel over the counter",
          keyMoment: "the parcel changes hands", eventIds: ["give"],
          objects: [{ id: "parcel", before: "in the courier's hands", after: "in his own hands" }],
          motion: "the parcel crosses the counter", scene: { who },
        }),
      ],
      [{ id: "give", observable: "the parcel changes hands", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "parcel", before: "in the courier's hands", after: "in his own hands" }] }],
    );
    return plan.shots[0].prompt.split("\n").find((l) => l.startsWith("People taking part")) ?? "";
  };
  for (const who of [
    "The courier stands on the left; Gudini waits at the counter",
    "On the left, Gudini faces the courier standing on the right",
    "Gudini stands on the left; Alice Smith stands on the right",
  ]) {
    const l = line(who);
    assert.ok(l.includes("only those named above in Positions"), l);
    for (const ghost of [" The,", " On,", "— The", "— On", "Smith,"]) {
      assert.ok(!l.includes(ghost), `в участниках появилось лишнее из «${who}»: ${l}`);
    }
    assert.ok(!/exactly \d/.test(l), `число участников выдумано по словам: ${l}`);
  }
});

test("явная роль состояния переживает нормализацию", async () => {
  const { objectStates } = await import("../lib/aiFilm/story");
  const kept = objectStates([
    { id: "keys", before: "held by Gudini", after: "held by Ada", role: "change" },
    { id: "lamp", before: "lit at the table", after: "casting a warm pool of light", role: "keep" },
  ]);
  assert.deepEqual(kept.map((o) => o.role), ["change", "keep"], "роль потеряна при разборе ответа модели");

  // и тот же контракт после полного пути нормализации не превращает условие в обязательство
  const ev: StoryEvent = {
    id: "handover", observable: "the keys change owner", required: true, fromPhrase: 1, toPhrase: 1,
    objects: [
      { id: "keys", before: "held by Gudini", after: "held by Ada", role: "change" },
      { id: "lamp", before: "lit at the table", after: "casting a warm pool of light", role: "keep" },
    ],
  };
  const plan = planOf(
    ["Он передал ключи соседке прямо за столом под горящей настольной лампой."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, visualAction: "Gudini puts the keys into Ada's hand", keyMoment: "the keys reach Ada's hand",
        eventIds: ["handover"],
        objects: [
          { id: "keys", before: "held by Gudini", after: "held by Ada", role: "change" },
          { id: "lamp", before: "lit at the table", after: "still lit at the table", role: "keep" },
        ],
        scene: { who: "Gudini at the left of the table; Ada at the right" },
      }),
    ],
    [ev],
    { supportingCharacters: [{ name: "Ada", function: "partner", appearance: "an adult woman in a green wool coat" }] },
  );
  assert.deepEqual(gateIssues(plan), [], JSON.stringify(plan.issues));
});

test("начатое действие в смешанном окне не требуется завершить", () => {
  const events: StoryEvent[] = [
    { id: "open", observable: "the case opens", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "case", before: "sealed", after: "open" }] },
    { id: "take", observable: "the instrument leaves the case", required: true, fromPhrase: 2, toPhrase: 2, objects: [{ id: "instrument", before: "inside the open case", after: "raised above the workbench" }] },
  ];
  const chain = { location: "a workshop", continuityGroup: "c", continuityRequired: true };
  const plan = planOf(
    ["Он открыл футляр почти сразу.", "Потом он очень долго доставал оттуда инструмент и наконец поднял его над верстаком к самому концу этой длинной фразы."],
    [
      scene({ ...chain, fromPhrase: 1, toPhrase: 1, visualAction: "Gudini opens the sealed case", keyMoment: "the case opens", anchorPhrase: "открыл", eventIds: ["open"], objects: [{ id: "case", before: "sealed", after: "open" }], motion: "Gudini lifts the lid", scene: { mechanics: "his fingers break the seal and lift the lid off the case" } }),
      scene({ ...chain, fromPhrase: 2, toPhrase: 2, visualAction: "Gudini takes the instrument out of the open case", keyMoment: "the instrument leaves the case", anchorPhrase: "поднял", eventIds: ["take"], objects: [{ id: "instrument", before: "inside the open case", after: "raised above the workbench" }], motion: "Gudini lifts the instrument above the workbench", scene: { mechanics: "his hand lifts the instrument out of its foam slot" } }),
    ],
    events,
  );
  assert.deepEqual(gateIssues(plan), [], JSON.stringify(plan.issues));
  for (const shot of plan.shots) {
    const starting = (shot.phases ?? []).filter((p) => p.phase === "start").map((p) => p.beatId);
    for (const id of starting) {
      const beat = plan.beats.find((b) => b.id === id)!;
      // действие названо началом, а движение и механика завершения в этот клип не уходят
      assert.ok(shot.prompt.includes("only the beginning"), shot.prompt.slice(0, 400));
      assert.ok(!shot.prompt.includes(beat.motion), `движение завершения попало в окно начала (${shot.id})`);
      assert.ok(!shot.prompt.includes(beat.scene!.mechanics!), `механика завершения попала в окно начала (${shot.id})`);
      assert.ok(!shot.prompt.includes("all of it inside one continuous take"), "заголовок требует завершить всё в этом клипе");
    }
    // а завершающее окно получает и движение, и механику, и срок
    const whole = (shot.phases ?? []).filter((p) => p.phase === "whole").map((p) => p.beatId);
    for (const id of whole) {
      const beat = plan.beats.find((b) => b.id === id)!;
      if (beat.motion) assert.ok(shot.prompt.includes(beat.motion), `движение ${id} потеряно в ${shot.id}`);
    }
  }
});

test("общая часть имени не приводит в кадр другого персонажа", async () => {
  const { mentionsPerson } = await import("../lib/aiFilm/plan");
  const cast = ["Alice Smith", "Robert Smith", "Alice Jones", "Ada"];
  const text = "gudini stands on the left; alice smith stands on the right".toLowerCase();
  assert.equal(mentionsPerson("Alice Smith", text, cast), true);
  assert.equal(mentionsPerson("Robert Smith", text, cast), false, "общая фамилия привела второго человека");
  assert.equal(mentionsPerson("Alice Jones", text, cast), false, "общее имя привело второго человека");
  assert.equal(mentionsPerson("Ada", "ada waits by the door", cast), true, "однословное имя должно находиться");

  // и то же самое на конечном запросе
  const plan = planOf(
    ["Он передал письмо соседке прямо за столом у окна и сразу отошёл в сторону."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, visualAction: "Gudini passes the letter to Alice Smith", keyMoment: "the letter reaches her hand",
        eventIds: ["pass"], objects: [{ id: "letter", before: "in Gudini's hand", after: "in her hand" }],
        scene: { who: "Gudini stands on the left; Alice Smith stands on the right" },
      }),
    ],
    [{ id: "pass", observable: "the letter changes hands", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "letter", before: "in Gudini's hand", after: "in her hand" }] }],
    { supportingCharacters: [
      { name: "Alice Smith", function: "partner", appearance: "an adult in a plain green coat" },
      { name: "Robert Smith", function: "witness", appearance: "an adult in a grey jacket" },
    ] },
  );
  const prompt = plan.shots[0].prompt;
  assert.ok(prompt.includes("Alice Smith"), prompt.slice(0, 300));
  assert.ok(!prompt.includes("Robert Smith"), "в запрос попал персонаж, которого в сцене нет");
  assert.ok(!prompt.includes("grey jacket"), "в запрос попала внешность постороннего персонажа");
});

test("имя ищется целиком, а не как часть обычного слова", async () => {
  const { mentionsPerson, containsWord } = await import("../lib/aiFilm/plan");
  const cast = ["Ben", "Ann", "Ben Carter", "Anna", "Jean-Luc Picard"];

  // обычные слова именами не становятся
  assert.equal(mentionsPerson("Ben", "the courier sits on a wooden bench", cast), false);
  assert.equal(mentionsPerson("Ann", "Anna hands over the parcel", cast), false);
  assert.equal(mentionsPerson("Ann", "a banner hangs over the door", cast), false);
  assert.equal(mentionsPerson("Ben Carter", "the courier sits on a wooden bench", cast), false);

  // прямое упоминание человека по-прежнему находится
  assert.equal(mentionsPerson("Ben", "Ben waits by the door", cast), true);
  assert.equal(mentionsPerson("Ann", "Ann signs the form, then leaves", cast), true);
  assert.equal(mentionsPerson("Ben Carter", "Ben Carter counts the boxes", cast), true);
  assert.equal(mentionsPerson("Anna", "Anna hands over the parcel", cast), true);
  assert.equal(mentionsPerson("Jean-Luc Picard", "Jean-Luc Picard steps aside.", cast), true, "составное имя и точка рядом");

  // границы считаются по буквам любого алфавита
  assert.equal(containsWord("скамья у двери", "ска"), false);
  assert.equal(containsWord("ска, потом дверь", "ска"), true);

  // и то же самое на конечном запросе: лишнего человека и его внешности в нём нет
  const plan = planOf(
    ["Курьер оставил посылку возле деревянной скамьи и почти сразу ушёл обратно."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, visualAction: "The courier sets the parcel down on a wooden bench",
        keyMoment: "the parcel rests on the bench", eventIds: ["drop"],
        objects: [{ id: "parcel", before: "in the courier's hands", after: "on the wooden bench" }],
        scene: { who: "Gudini watches from the door; the courier stands at the bench" },
      }),
    ],
    [{ id: "drop", observable: "the parcel reaches the bench", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "parcel", before: "in the courier's hands", after: "on the wooden bench" }] }],
    { supportingCharacters: [{ name: "Ben", function: "witness", appearance: "an adult in a striped shirt" }] },
  );
  const prompt = plan.shots[0].prompt;
  assert.ok(!prompt.includes("Ben"), "скамья привела в кадр персонажа Ben");
  assert.ok(!prompt.includes("striped shirt"), "в запрос попала внешность постороннего персонажа");
});

test("одно общее слово в сводке не считается заявлением конечного состояния", () => {
  const open: StoryEvent = {
    id: "screens", observable: "the cover screen gives way to the larger inner screen", required: true, fromPhrase: 1, toPhrase: 1,
    objects: [{ id: "cover-screen", before: "not shown", after: "visible lit 5.4-inch cover display", role: "change" }],
  };
  // из настоящего плана: кадр начинается со сложенного телефона, у которого внешний экран горит
  const plan = planOf(
    ["Он держит телефон закрытым, а потом раскрывает его и показывает большой внутренний экран."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, visualAction: "Gudini holds the phone closed with the small cover screen lit, then unfolds it",
        keyMoment: "the small lit cover screen gives way to the larger inner screen", eventIds: ["screens"],
        objects: [{ id: "cover-screen", before: "not shown", after: "visible lit 5.4-inch cover display", role: "change" }],
        stateBefore: "phone closed, cover screen lit",
        camera: "Camera is in front at chest height; hands unfold the phone toward the camera, both screens staying in frame in sequence",
      }),
    ],
    [open],
  );
  assert.ok(!plan.issues.some((i) => i.code === "phase-conflict"), JSON.stringify(plan.issues.map((i) => i.code)));

  // а полное заявление конечного состояния в первом кадре по-прежнему запрет
  const conflict = planOf(
    ["Он держит телефон закрытым, а потом раскрывает его и показывает большой внутренний экран."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, visualAction: "Gudini unfolds the phone", keyMoment: "the inner screen opens", eventIds: ["screens"],
        objects: [{ id: "cover-screen", before: "not shown", after: "visible lit cover display", role: "change" }],
        stateBefore: "the visible lit cover display fills the frame from the first moment",
        camera: "Camera is in front at chest height",
      }),
    ],
    [open],
  );
  assert.ok(conflict.issues.some((i) => i.code === "phase-conflict" && i.severity === "block"), JSON.stringify(conflict.issues.map((i) => i.code)));
});

test("обязательный момент остаётся внутри клипа, когда длинный бит обрезается", () => {
  const pay: StoryEvent = {
    id: "pay", observable: "the small tax bill is set beside the large one", required: true, fromPhrase: 1, toPhrase: 2,
    objects: [{ id: "bills", before: "one bill on the table", after: "two bills side by side, sizes compared", role: "change" }],
  };
  // бит длиннее восьми секунд, а его момент звучит в самом конце
  const plan = planOf(
    [
      "Он выложил на стол первую квитанцию.",
      "Потом достал вторую бумагу и положил рядом.",
      "На ней стояли уже почти двести тысяч.",
    ],
    [
      scene({
        fromPhrase: 1, toPhrase: 3, visualAction: "Gudini sets the second, larger bill beside the small one",
        keyMoment: "the larger bill lands beside the small one", anchorPhrase: "двести", eventIds: ["pay"],
        objects: [{ id: "bills", before: "one bill on the table", after: "two bills side by side, sizes compared", role: "change" }],
      }),
    ],
    [pay],
  );
  assert.deepEqual(gateIssues(plan), [], JSON.stringify(plan.issues));
  const shot = plan.shots.find((s) => s.eventIds.includes("pay"));
  assert.ok(shot, "сцена с обязательным событием пропала");
  assert.ok(shot!.changeBySec != null, "момент события остался за пределами клипа");
  const beat = plan.beats.find((b) => b.id === shot!.beatIds[0])!;
  assert.ok(beat.anchorAbsSec != null && beat.anchorAbsSec >= beat.start - 1e-6 && beat.anchorAbsSec <= beat.end + 1e-6,
    `момент ${beat.anchorAbsSec} вне окна ${beat.start}–${beat.end}`);
});

test("чтение персонажем не требует читаемости для зрителя", () => {
  const restore: StoryEvent = {
    id: "restore", observable: "the new device gains access from the backup card", required: true, fromPhrase: 1, toPhrase: 1,
    objects: [{ id: "device", before: "new and empty", after: "restored and unlocked", role: "change" }],
  };
  const build = (props: string[], visualAction: string) =>
    planOf(
      ["Он взял карточку с резервной фразой и по ней восстановил доступ на новом устройстве."],
      [
        scene({
          fromPhrase: 1, toPhrase: 1, visualAction, keyMoment: "the new device shows a restored wallet", eventIds: ["restore"],
          objects: [{ id: "device", before: "new and empty", after: "restored and unlocked", role: "change" }],
          scene: { props },
        }),
      ],
      [restore],
    ).issues.map((i) => `${i.code}:${i.severity}`);

  // предмет прямо объявлен нечитаемым — требования разобрать надпись нет
  const blurred = build(
    ["a paper card with a row of blurred handwritten words"],
    "Gudini picks up the card and reads the words while entering them into a new device",
  );
  assert.ok(!blurred.includes("readable-text:block"), JSON.stringify(blurred));

  // а требование прочитать ДРУГОЙ предмет размытая карточка не отменяет
  const other = build(
    ["a paper card with a row of blurred handwritten words"],
    "Gudini enters the phrase while the screen clearly shows the price of the transfer",
  );
  assert.ok(other.includes("readable-text:block"), JSON.stringify(other));
});

test("отказ от читаемости не считается требованием её показать", () => {
  const ev: StoryEvent = {
    id: "block", observable: "the withdrawal request is refused on screen", required: true, fromPhrase: 1, toPhrase: 1,
    objects: [{ id: "screen", before: "normal balance layout", after: "red-tinted blocked layout", role: "change" }],
  };
  const build = (visualAction: string, keyMoment: string) =>
    planOf(
      ["Он нажал вывод на телефоне, и заявка сразу повисла в ожидании."],
      [
        scene({
          fromPhrase: 1, toPhrase: 1, visualAction, keyMoment, eventIds: ["block"],
          objects: [{ id: "screen", before: "normal balance layout", after: "red-tinted blocked layout", role: "change" }],
        }),
      ],
      [ev],
    ).issues.map((i) => `${i.code}:${i.severity}`);

  // сцена прямо отказывается от читаемого текста
  const denied = build(
    "Gudini taps the button and the screen changes to a plain red-tinted blocked layout with no readable text",
    "the screen switches to the blocked layout",
  );
  assert.ok(!denied.includes("readable-text:block"), JSON.stringify(denied));

  // а прямое требование разобрать цифру остаётся запретом
  const demanded = build(
    "Gudini sets a card down and the number 1999 is clearly visible and readable",
    "the number on the card is readable",
  );
  assert.ok(demanded.includes("readable-text:block"), JSON.stringify(demanded));
});

test("реквизит не заявляет конечное состояние, а изменение имеет причину", () => {
  const fold: StoryEvent = {
    id: "fold", observable: "the phone opens flat", required: true, fromPhrase: 1, toPhrase: 1,
    objects: [{ id: "phone", before: "half-open at an angle", after: "fully open and flat", role: "change" }],
  };
  const plan = planOf(
    ["Он раскрывает телефон до конца, и внутренний экран становится виден целиком."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, visualAction: "Gudini finishes opening the folding phone flat with both hands",
        keyMoment: "the phone reaches fully flat", eventIds: ["fold"],
        objects: [{ id: "phone", before: "half-open at an angle", after: "fully open and flat", role: "change" }],
        motion: "both hands straighten the hinge until the phone lies flat",
        scene: { props: ["the black folding phone, now fully open and flat"] },
      }),
    ],
    [fold],
  );
  const shot = plan.shots[0];
  // строка присутствия называет предмет без его фазы
  // предмет меняется в этом окне, поэтому он не «весь кадр», а в состоянии из действия
  assert.ok(shot.prompt.includes("In frame, in the state the action describes at that moment: the black folding phone"), shot.prompt.slice(0, 300));
  assert.ok(!shot.prompt.includes("now fully open and flat.\n") && !/throughout: [^\n]*fully open and flat/.test(shot.prompt), shot.prompt.slice(0, 300));
  assert.ok(plan.issues.some((i) => i.code === "prop-asserts-end-state"), JSON.stringify(plan.issues.map((i) => i.code)));

  // изменение без причины в действии — отдельное замечание
  const uncaused = planOf(
    ["Он идёт вдоль изгороди, а сено на поле уже скошено ровными рядами."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, visualAction: "Gudini walks along the fence past the field",
        keyMoment: "the mowed rows are visible behind the fence", eventIds: ["hay"],
        objects: [{ id: "hay", before: "uncut in the field", after: "mowed into rows", role: "change" }],
        motion: "he walks along the fence",
        scene: { props: ["a wooden fence"] },
      }),
    ],
    [{ id: "hay", observable: "the hay is cut into rows", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "hay", before: "uncut in the field", after: "mowed into rows", role: "change" }] }],
  );
  assert.ok(uncaused.issues.some((i) => i.code === "change-without-cause"), JSON.stringify(uncaused.issues.map((i) => i.code)));

  // а когда предмет назван в действии, замечания нет
  const caused = planOf(
    ["Он проводит косой по траве, и полоса ложится ровным рядом за его спиной."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, visualAction: "Gudini swings the scythe through the standing hay",
        keyMoment: "the cut hay falls into a row behind him", eventIds: ["hay"],
        objects: [{ id: "hay", before: "standing uncut", after: "cut and lying in a row", role: "change" }],
        motion: "the blade sweeps through the stalks and they fall",
        scene: { mechanics: "the blade cuts the hay stalks at the base and they drop into a row" },
      }),
    ],
    [{ id: "hay", observable: "the hay is cut into a row", required: true, fromPhrase: 1, toPhrase: 1, objects: [{ id: "hay", before: "standing uncut", after: "cut and lying in a row", role: "change" }] }],
  );
  assert.ok(!caused.issues.some((i) => i.code === "change-without-cause"), JSON.stringify(caused.issues.map((i) => i.code)));
});

test("кадр описывает выбранный планировщиком субъект, а сборщик своего не назначает", () => {
  const press: StoryEvent = {
    id: "sign", observable: "the device screen confirms the signature", required: true, fromPhrase: 1, toPhrase: 1,
    objects: [{ id: "hardware-wallet", before: "screen showing an unsigned prompt", after: "screen showing a signed confirmation", role: "change" }],
  };
  const walletScene = (over: Record<string, unknown> = {}) =>
    planOf(
      ["Он нажимает единственную кнопку на устройстве, и экран подтверждает подпись."],
      [
        scene({
          fromPhrase: 1, toPhrase: 1, shotType: "close", visualAction: "Gudini presses the single button on the hardware wallet",
          keyMoment: "the hardware wallet screen flips to a signed confirmation", eventIds: ["sign"],
          objects: [{ id: "hardware-wallet", before: "screen showing an unsigned prompt", after: "screen showing a signed confirmation", role: "change" }],
          camera: "Camera is close on his hand and the device",
          ...over,
        }),
      ],
      [press],
    ).shots[0].prompt;

  // субъект кадра назван планировщиком: крупность и ракурс относятся именно к нему
  const chosen = walletScene({ frameSubject: "his thumb on the device button and the device screen" });
  assert.match(chosen, /Framing: .* close shot on his thumb on the device button and the device screen\./);
  assert.match(chosen, /Camera: Camera is close on his hand and the device\./);
  assert.doesNotMatch(chosen, /Camera angle:/);
  assert.ok(!/sits near the centre of the frame with normal headroom/.test(chosen), chosen.slice(0, 400));

  // субъекта нет — сборщик не подставляет вместо него ведущего и не переписывает ракурс
  const silent = walletScene();
  assert.match(silent, /Framing: .* close shot\. What this shot is about sits near the centre of the frame\./);
  assert.doesNotMatch(silent, /Camera angle:/);
  assert.ok(!silent.includes("The subject sits"), silent.slice(0, 400));
  // доказательство должно быть различимо, а не обязательно в середине кадра
  assert.match(silent, /large enough to read and not cropped away/);

  // наличие меняющегося предмета не назначает субъект кадра: планировщик выбрал лицо
  const face = walletScene({ frameSubject: "his face", shotType: "close", composition: "center" });
  assert.match(face, /Framing: .* close shot on his face\./);
  assert.match(face, /His face sits near the centre of the frame\./);
  assert.ok(!face.includes("hardware wallet sits"), face.slice(0, 400));
});


test("появление результата, удержание и конец отрезка — три разных времени", () => {
  const sign: StoryEvent = {
    id: "sign", observable: "the device screen confirms the signature", required: true, fromPhrase: 1, toPhrase: 1,
    objects: [{ id: "hardware-wallet", before: "screen showing an unsigned prompt", after: "screen showing a signed confirmation", role: "change" }],
  };
  const words = ["Он нажимает кнопку на устройстве, и экран показывает подтверждение подписи прямо сейчас."];
  const walletOf = (over: Record<string, unknown>) =>
    planOf(
      words,
      [
        scene({
          fromPhrase: 1, toPhrase: 1, shotType: "close", visualAction: "Gudini presses the single button on the hardware wallet",
          keyMoment: "the hardware wallet screen flips to a signed confirmation", eventIds: ["sign"], anchorPhrase: "подтверждение",
          objects: [{ id: "hardware-wallet", before: "screen showing an unsigned prompt", after: "screen showing a signed confirmation", role: "change" }],
          ...over,
        }),
      ],
      [sign],
    );

  // читаемый результат обязан остаться на экране, а не смениться обратно внутри клипа
  const read = walletOf({ hold: "read" });
  const shot = read.shots[0];
  assert.equal(shot.deadlines[0].holdSec, 2);
  assert.ok(shot.deadlines[0].untilSec! > shot.deadlines[0].bySec!, JSON.stringify(shot.deadlines[0]));
  assert.match(shot.prompt, /Once it is there it stays: at least until second \d+ of the clip/);
  assert.match(shot.prompt, /does not go back to the state it had before, inside this clip/);

  // мгновенному событию удержание не приписывается: вспышка и не должна стоять в кадре
  const instant = walletOf({ hold: "instant" });
  assert.equal(instant.shots[0].deadlines[0].holdSec, 0);
  assert.ok(!instant.shots[0].prompt.includes("Once it is there it stays"), instant.shots[0].prompt.slice(0, 300));

  // срок появления от удержания не сдвигается молча
  assert.equal(read.shots[0].deadlines[0].bySec, instant.shots[0].deadlines[0].bySec);
});

test("результат, который не успеть рассмотреть, попадает в замечания плана", () => {
  const sign: StoryEvent = {
    id: "sign", observable: "the device screen confirms the signature", required: true, fromPhrase: 1, toPhrase: 1,
    objects: [{ id: "hardware-wallet", before: "screen showing an unsigned prompt", after: "screen showing a signed confirmation", role: "change" }],
  };
  // якорь стоит на последнем слове реплики: результат появится к самому концу отрезка
  const late = planOf(
    ["Он нажимает кнопку и держит устройство перед собой, пока на экране не появится подтверждение."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, shotType: "close", visualAction: "Gudini presses the single button on the hardware wallet",
        keyMoment: "the hardware wallet screen flips to a signed confirmation", eventIds: ["sign"], anchorPhrase: "подтверждение", hold: "read",
        objects: [{ id: "hardware-wallet", before: "screen showing an unsigned prompt", after: "screen showing a signed confirmation", role: "change" }],
      }),
    ],
    [sign],
  );
  assert.ok(late.issues.some((i) => i.code === "hold-outside-window"), JSON.stringify(late.issues.map((i) => i.code)));
  // это замечание, а не запрет оплаты: кадр выполним
  assert.ok(!gateIssues(late).some((i) => i.code === "hold-outside-window"));
});


test("неразобранный ответ планировщика попадает в ошибку вместе с концом текста", async () => {
  // Ответ уже оплачен: если он не разобрался, причину ищут по его же тексту.
  const { planStory } = await import("../lib/aiFilm/story");
  const words = speech(["Он нажимает кнопку на устройстве и ждёт ответа экрана.", "Экран показывает подтверждение подписи.", "Он кладёт устройство на стол."]);
  const seen: string[] = [];
  await assert.rejects(
    () =>
      planStory({
        words, script: "x", topic: "t", character, universe, duration: words[words.length - 1].end, coverage: { target: 0.5, max: 0.7 },
        complete: async () => "вот план: {beats: [ // без кавычек",
        onCall: ({ raw }) => seen.push(raw),
      }),
    (e: Error) => {
      assert.match(e.message, /не разобрался как JSON/);
      assert.match(e.message, /конец ответа/);
      return true;
    },
  );
  assert.equal(seen.length, 1, "ответ модели обязан дойти до наблюдателя до разбора");
});


test("требование прочитать бумагу ловится и в механике сцены", () => {
  const stamp: StoryEvent = {
    id: "reject", observable: "the exemption form is rejected", required: true, fromPhrase: 1, toPhrase: 1,
    objects: [{ id: "form", before: "blank", after: "stamped rejected", role: "change" }],
  };
  const plan = planOf(
    ["Он ставит на заявление красный отказ и кладёт рядом папку с документами клуба."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, shotType: "close", visualAction: "Gudini stamps the exemption form on the desk",
        keyMoment: "the red stamp lands across the form", eventIds: ["reject"],
        objects: [{ id: "form", before: "blank", after: "stamped rejected", role: "change" }],
        scene: { who: "Gudini at the desk", props: ["exemption form", "red stamp"], mechanics: "the folder's papers make the LLC ownership status readable at a glance" },
      }),
    ],
    [stamp],
  );
  assert.ok(plan.issues.some((i) => i.code === "readable-text"), JSON.stringify(plan.issues.map((i) => i.code)));
});


test("названная планировщиком точка съёмки не пересказывается шаблоном ракурса", () => {
  const marker = (camera: string) =>
    planOf(
      ["Он подходит к гранитной плите в траве рядом с лункой и останавливается."],
      [
        scene({
          fromPhrase: 1, toPhrase: 1, shotType: "medium_wide", cameraAngle: "low_angle", composition: "center",
          visualAction: "Gudini walks to the grey granite marker set in the turf beside the flagged hole",
          keyMoment: "the granite marker beside the flagged hole", frameSubject: "the grave marker in the turf beside the flagged hole",
          camera,
        }),
      ],
      [],
    ).shots[0].prompt;
  // позиция названа — строки «камера под плитой в траве» быть не может
  const stated = marker("Camera is on the fairway about six meters back at knee height; Gudini walks away from camera");
  assert.doesNotMatch(stated, /Camera angle:/);
  assert.ok(!stated.includes("camera below the grave marker"), stated.slice(0, 500));
  // позиции нет — шаблон ракурса остаётся и описан относительно субъекта кадра
  const bare = marker("slow drift");
  assert.match(bare, /Camera angle: camera below the grave marker in the turf beside the flagged hole/);
});

test("видимый заголовок документа — это требование читаемого текста", () => {
  const llc: StoryEvent = {
    id: "llc", observable: "the folder shows the club is an ordinary company", required: true, fromPhrase: 1, toPhrase: 1,
    objects: [{ id: "folder", before: "closed", after: "open on the registration page", role: "change" }],
  };
  const plan = planOf(
    ["Он открывает папку, и там документы клуба как обычной компании."],
    [
      scene({
        fromPhrase: 1, toPhrase: 1, shotType: "medium", eventIds: ["llc"],
        visualAction: "Gudini opens a manila folder revealing a printed page with the club's LLC registration heading visible on top",
        keyMoment: "the folder lies open on the registration page",
        objects: [{ id: "folder", before: "closed", after: "open on the registration page", role: "change" }],
      }),
    ],
    [llc],
  );
  assert.ok(plan.issues.some((i) => i.code === "readable-text"), JSON.stringify(plan.issues.map((i) => i.code)));
});
