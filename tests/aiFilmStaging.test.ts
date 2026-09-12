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
