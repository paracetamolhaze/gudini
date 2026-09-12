import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeBible, beatsFromRaw, phrasesFromWords, storySystemPrompt } from "../lib/aiFilm/story";
import { shotPrompt, buildShots, coverageConfig, veoCallMinutes, veoConcurrency, authorStretchWarnings } from "../lib/aiFilm/plan";
import { loadUniverseProfile } from "../lib/aiFilm/universe";
import { loadCharacterProfile } from "../lib/aiFilm/character";
import { planKey } from "../lib/aiFilm/run";
import { veoBody } from "../lib/aiFilm/veo";
import type { CharacterProfile, StoryBeat, StoryBible, StoryType } from "../lib/aiFilm/types";

/**
 * Проверки поведения фотореалистичного режима: постановка зависит от типа истории,
 * реквизит не путешествует между сценами, владелец не подставляется вместо реального
 * участника новости, и всё это стоит по-прежнему одну генерацию на сцену.
 *
 * Тесты смотрят на собранные промпты и планы, а не на снимок большого системного текста:
 * снимок ломается от любой запятой и ничего не доказывает.
 */

const universe = loadUniverseProfile("gudini-photoreal", path.join(process.cwd(), "assets", "ai-film", "universes"));
const loaded = loadCharacterProfile("gudini-real", path.join(process.cwd(), "assets", "ai-film", "characters"));
const character: CharacterProfile = { ...loaded, referenceFiles: [] };
const withRefs: CharacterProfile = { ...character, referenceFiles: ["/tmp/r1.png"] };

const bibleOf = (storyType: StoryType, extra: Record<string, unknown> = {}): StoryBible =>
  normalizeBible({ bible: { storyType, mood: "tense", lighting: "overcast daylight", ...extra } } as any, character, universe);

const beat = (o: Partial<StoryBeat> & { visualAction: string }): StoryBeat => ({
  id: "B1", start: 0, end: 8, meaning: "", storyBeat: "", displayMode: "full_ai",
  purpose: "explain", priority: "medium", requiresGeneration: true, gudiniVisible: false,
  universeAdaptation: "", location: "a city street", motion: "he steps forward",
  keyMoment: "", anchorPhrase: "", anchorAtSec: null, anchorAbsSec: null, eventIds: [], objects: [], stateBefore: "", stateAfter: "",
  continuityGroup: null, continuityRequired: false, transition: "cut", shotType: "medium", frameSubject: "",
  camera: "Camera stands across the street at eye height; he walks past camera on the left",
  cameraAngle: "eye_level", composition: "center",
  suggestedDuration: 8, ...o,
});

const promptFor = (bible: StoryBible, b: StoryBeat, c: CharacterProfile = character) =>
  shotPrompt({ character: c, universe, bible, beats: [b], prev: null, mode: "text", aspectRatio: "9:16" });

// ─────────────────────────────── 1. новость

test("новость: наблюдательная постановка, реконструкция, роль героя исполняет персонаж канала", () => {
  // Обычного героя истории играет персонаж канала — это заявленная постановка,
  // и она помечена флагом reconstruction, а не выдаётся за запись события.
  const bible = bibleOf("news", { playedByGudini: "Каспер", supportingCharacters: [{ name: "Каспер", function: "partner", appearance: "a man in a jumpsuit" }] });
  assert.equal(bible.storyType, "news");
  assert.equal(bible.staging, "observational");
  assert.equal(bible.reconstruction, true);
  assert.equal(bible.playedByGudini, "Каспер", "роль героя истории исполняет персонаж канала");
  assert.deepEqual(bible.supportingCharacters, [], "исполняемый герой не заводится вторым человеком в кадре");

  const p = promptFor(bible, beat({ gudiniVisible: true, visualAction: "Gudini walks out of a courthouse and stops on the steps", keyMoment: "he stops and turns his head" }), withRefs);
  assert.match(p, /staged reconstruction of a real event/);
  assert.match(p, /must not look like archive footage/);
  assert.match(p, /no timecode/);
  // он в кадре и он тот же самый человек
  assert.match(p, /Main character GUDINI/);
  assert.match(p, /high-collar zip jacket/);
  assert.match(p, /People taking part in the action: exactly 1 — Gudini/);
  // и никакого случайного реквизита из чужих сцен
  assert.doesNotMatch(p, /torn pieces|hammered by the airflow|falling bodies accelerate/);

  // сцена без людей остаётся без него
  const noPeople = promptFor(bible, beat({ gudiniVisible: false, visualAction: "The torn orange canopy lies on wet grass" }));
  assert.doesNotMatch(noPeople, /Main character GUDINI/);
});

test("узнаваемого публичного человека собой не подменяют — правило стоит в промпте планировщика", () => {
  const prompt = storySystemPrompt(character, universe, { target: 0.45, max: 0.55 });
  assert.match(prompt, /главного героя истории ИГРАЕТ Gudini/);
  assert.match(prompt, /широко узнаваемый публичный человек/);
  assert.match(prompt, /Его показывают им самим/);
});

test("план ругается на длинные куски без сцен и на поздний старт", () => {
  const line = (start: number, end: number, mode: "author" | "full_ai") => ({ start, end, mode, beatIds: [] }) as any;
  // первая сцена на 20-й секунде и двадцать секунд говорящей головы перед ней
  const late = authorStretchWarnings([line(0, 20, "author"), line(20, 28, "full_ai"), line(28, 44, "author")], 44);
  assert.ok(late.some((w) => /Первая сцена появляется только на 20.0 с/.test(w)), late.join(" | "));
  assert.ok(late.some((w) => /0\.0–20\.0 с/.test(w) && /28\.0–44\.0 с/.test(w)), late.join(" | "));
  // равномерное распределение претензий не вызывает
  const even = authorStretchWarnings([line(0, 6, "full_ai"), line(6, 16, "author"), line(16, 24, "full_ai"), line(24, 34, "author"), line(34, 42, "full_ai"), line(42, 44, "author")], 44);
  assert.deepEqual(even, []);
});

// ─────────────────────────────── 2. история

test("исторический сюжет: реконструкция эпохи и прямой запрет современных предметов", () => {
  const bible = bibleOf("history");
  assert.equal(bible.staging, "period_reconstruction");
  assert.equal(bible.reconstruction, true);
  const p = promptFor(bible, beat({ visualAction: "A telegraph operator taps out a message in a wooden station office", location: "a railway station office in 1890" }));
  assert.match(p, /period reconstruction/);
  assert.match(p, /Nothing modern anywhere in frame/);
  assert.match(p, /no plastic, no printed graphics/);
  assert.doesNotMatch(p, /staged reconstruction of a real event/, "постановка новости в исторический кадр не попадает");
});

// ─────────────────────────────── 3. философия

test("философский сюжет: владелец узнаваем и в костюме, действие бытовое, без автоматических эффектов", () => {
  const bible = bibleOf("philosophy", { playedByGudini: "парень" });
  assert.equal(bible.staging, "everyday_life");
  assert.equal(bible.reconstruction, false);
  assert.equal(bible.playedByGudini, "парень", "в размышлении роль обобщённого героя исполнять можно");
  const p = promptFor(bible, beat({ gudiniVisible: true, visualAction: "Gudini sets a full mug down on a cluttered kitchen table and sits", keyMoment: "the mug touches the table" }), withRefs);
  assert.match(p, /Main character GUDINI/);
  assert.match(p, /photorealistic live-action/);
  assert.match(p, /high-collar zip jacket/);
  assert.match(p, /ordinary, recognisable moment from real life/);
  // ни дыма, ни свечения по умолчанию
  assert.match(p, /No symbolic effects, no glowing objects/);
  // рисовка встречается только как нежелательный признак, а не как указание стиля
  assert.doesNotMatch(p, /flat 2D cel animation|hand-drawn anime|drawn in this style/);
  assert.match(p, /no cel shading/, "аниме остаётся в списке запретов — это правильное употребление");
});

// ─────────────────────────────── 4. парашют: состояние реквизита

test("парашют: состояние купола согласовано по сценам, обрывки только там, где рвётся", () => {
  const bible = bibleOf("explainer", { continuityRules: ["the reserve canopy is bright red in every shot"] });
  const intact = beat({ id: "B1", visualAction: "Gudini clips a folded grey parachute pack onto his harness on the ground", stateBefore: "the grey canopy is packed and intact", stateAfter: "the pack is closed on his back, still intact", keyMoment: "the buckle clicks shut" });
  const tears = beat({ id: "B2", visualAction: "The grey canopy splits open along one seam above him", stateBefore: "the grey canopy is open and whole", stateAfter: "the grey canopy is torn along one seam, fabric streaming", keyMoment: "the seam tears open", motion: "the seam splits and torn fabric streams upward past the camera" });
  const reserve = beat({ id: "B3", visualAction: "A bright red reserve canopy opens above him", stateBefore: "the torn grey canopy trails behind him", stateAfter: "the bright red reserve canopy is fully open", keyMoment: "the red canopy snaps open" });

  const pIntact = promptFor(bible, intact);
  const pTears = promptFor(bible, tears);
  const pReserve = promptFor(bible, reserve);

  // разрыв описан только в сцене разрыва
  assert.doesNotMatch(pIntact, /torn|tears|streaming/i);
  assert.match(pTears, /torn fabric streams upward past the camera/);
  // до и после состояния попали в свои промпты
  assert.match(pIntact, /Before: the grey canopy is packed and intact/);
  assert.match(pTears, /After: the grey canopy is torn along one seam/);
  assert.match(pReserve, /Before: the torn grey canopy trails behind him/);
  // цвет запасного купола держится правилом непрерывности во всех сценах
  for (const p of [pIntact, pTears, pReserve]) assert.match(p, /reserve canopy is bright red in every shot/);
  // главное изменение названо и должно случиться рано, а не в хвосте клипа
  assert.match(pTears, /The one thing that must be visible: the seam tears open\. It happens early in the shot/);
});

test("якорь тайминга берётся из речи этого бита, выдуманный отбрасывается", () => {
  const words = [
    { word: "купол", start: 0, end: 0.5 }, { word: "порвался", start: 0.5, end: 1.2 },
    { word: "прямо", start: 1.2, end: 1.6 }, { word: "в", start: 1.6, end: 1.7 },
    { word: "воздухе.", start: 1.7, end: 2.4 }, { word: "Запасной", start: 2.6, end: 3.2 },
    { word: "раскрылся", start: 3.2, end: 4.0 }, { word: "сразу.", start: 4.0, end: 4.6 },
  ];
  const phrases = phrasesFromWords(words as any);
  const beats = beatsFromRaw(
    [
      { fromPhrase: 1, toPhrase: 1, displayMode: "full_ai", visualAction: "the canopy tears", anchorPhrase: "порвался" },
      { fromPhrase: 2, toPhrase: 2, displayMode: "full_ai", visualAction: "the reserve opens", anchorPhrase: "выдуманное слово" },
    ] as any,
    phrases,
    5,
  );
  assert.equal(beats[0].anchorPhrase, "порвался");
  assert.equal(beats[1].anchorPhrase, "", "слова нет в речи этого бита — якорь не сохраняется");
});

// ─────────────────────────────── 5. инвалидизация плана

test("текст профиля меняет ключ плана; те же входы переиспользуются", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-photoreal-"));
  const dir = path.join(base, "hero");
  fs.mkdirSync(dir);
  const profile = {
    id: "hero", name: "Gudini", description: "the owner himself", appearance: "bleached buzz cut, brown eyes",
    clothes: "orange and black jacket", signature: "steel forehead plate", styleLock: "photorealistic live-action footage",
    world: "places come from the story", negative: "no anime",
  };
  const write = (p: object) => fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify(p));
  write(profile);
  fs.writeFileSync(path.join(dir, "ref-1.png"), Buffer.from("png-1"));

  const words = [{ word: "раз", start: 0, end: 1 }, { word: "два", start: 1, end: 2 }] as any;
  const keyOf = () => planKey(words, "сценарий", loadCharacterProfile("hero", base), universe, 2);
  const before = keyOf();
  assert.equal(keyOf(), before, "одинаковые входы дают одинаковый ключ");

  write({ ...profile, appearance: "bleached buzz cut, grey eyes" });
  const afterText = keyOf();
  assert.notEqual(afterText, before, "правка описания лица обязана делать план устаревшим");

  fs.writeFileSync(path.join(dir, "ref-1.png"), Buffer.from("png-2"));
  assert.notEqual(keyOf(), afterText, "другая картинка — тоже другой план");

  const otherWorld = { ...universe, id: "other", hash: "0123456789ab" };
  assert.notEqual(planKey(words, "сценарий", loadCharacterProfile("hero", base), otherWorld, 2), keyOf(), "смена мира тоже инвалидирует");
  fs.rmSync(base, { recursive: true, force: true });
});

// ─────────────────────────────── 6. один дубль, без посценных картинок

test("на сцену остаётся один вызов Veo и один вариант; посценной генерации картинок нет", () => {
  const bible = bibleOf("explainer");
  const beats: StoryBeat[] = [
    beat({ id: "B1", start: 0, end: 8, visualAction: "a man opens a cardboard parcel" }),
    { ...beat({ id: "B2", visualAction: "" }), start: 8, end: 14, displayMode: "author", requiresGeneration: false },
    beat({ id: "B3", start: 14, end: 22, visualAction: "he lifts the packing foam out of the box" }),
  ];
  const cfg = { key: "k", universe, budgetUsd: 12, maxCoverage: coverageConfig().max, concurrency: veoConcurrency(), callMinutes: veoCallMinutes() };
  const built = buildShots(beats, withRefs, bible, cfg);
  assert.equal(built.groups.length, 2, "две независимые сцены");
  for (const g of built.groups) assert.equal(g.shotIds.length, 1, "одна сцена — один вызов Veo");
  assert.equal(built.shots.length, 2);

  // в теле запроса к Veo ровно один вариант и никакого звука
  const body: any = veoBody({
    model: built.shots[0].model, prompt: built.shots[0].prompt, durationSeconds: 8,
    storageUri: "gs://bucket/x/", aspectRatio: "9:16", resolution: "720p",
  });
  assert.equal(body.parameters.sampleCount, 1);
  assert.equal(body.parameters.generateAudio, false);

  // модуль AI-фильма не умеет генерировать изображения: их там просто нет
  const sources = fs.readdirSync(path.join(process.cwd(), "lib", "aiFilm"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => fs.readFileSync(path.join(process.cwd(), "lib", "aiFilm", f), "utf8"))
    .join("\n");
  for (const banned of ["coverProvider", "generateCoverImage", "modalities"]) {
    assert.ok(!sources.includes(banned), `в lib/aiFilm появился путь генерации картинок: ${banned}`);
  }
});

test("развязку не сдвигают встык: сцена с якорем или reveal остаётся на своих словах", async () => {
  const { closeTinyAuthorGaps } = await import("../lib/aiFilm/plan");
  const mk = (id: string, start: number, end: number, o: Partial<StoryBeat> = {}): StoryBeat =>
    ({ ...beat({ visualAction: id === "B2" ? "" : "x" }), id, start, end, suggestedDuration: end - start, ...o });

  // обычная сцена: короткий автор между двумя AI закрывается сдвигом
  const plain = closeTinyAuthorGaps([
    mk("B1", 0, 8), mk("B2", 8, 10, { displayMode: "author", requiresGeneration: false }), mk("B3", 10, 18), mk("B4", 18, 30, { displayMode: "author", requiresGeneration: false }),
  ]);
  assert.equal(plain.find((b) => b.id === "B3")?.start, 8, "обычную сцену сдвигаем");

  // reveal и сцена с якорем остаются на месте
  for (const o of [{ purpose: "reveal" as const }, { anchorPhrase: "порвался" }]) {
    const kept = closeTinyAuthorGaps([
      mk("B1", 0, 8), mk("B2", 8, 10, { displayMode: "author", requiresGeneration: false }), mk("B3", 10, 18, o), mk("B4", 18, 30, { displayMode: "author", requiresGeneration: false }),
    ]);
    assert.equal(kept.find((b) => b.id === "B3")?.start, 10, `сцену ${JSON.stringify(o)} сдвигать нельзя`);
  }
});

test("открывающая сцена: короткий хук дотягивается, а не выбрасывается", () => {
  const words = [
    { word: "Парень", start: 0, end: 0.5 }, { word: "заказал", start: 0.5, end: 1.1 },
    { word: "парашют", start: 1.1, end: 1.8 }, { word: "за", start: 1.8, end: 1.9 },
    { word: "пять", start: 1.9, end: 2.4 }, { word: "долларов.", start: 2.4, end: 3.0 },
    { word: "И", start: 3.2, end: 3.4 }, { word: "всё", start: 3.4, end: 3.8 },
    { word: "закончилось", start: 3.8, end: 4.6 }, { word: "ровно", start: 4.6, end: 5.2 },
    { word: "так,", start: 5.2, end: 5.6 }, { word: "как", start: 5.6, end: 5.9 },
    { word: "вы", start: 5.9, end: 6.2 }, { word: "думаете.", start: 6.2, end: 7.9 },
  ];
  const phrases = phrasesFromWords(words as any);
  const beats = beatsFromRaw(
    [
      { fromPhrase: 1, toPhrase: 1, displayMode: "full_ai", visualAction: "he taps order on a phone", purpose: "hook", priority: "high" },
      { fromPhrase: 2, toPhrase: 2, displayMode: "author" },
    ] as any,
    phrases, 7.9,
  );
  assert.equal(beats[0].displayMode, "full_ai", "трёхсекундный хук остаётся сценой");
  assert.ok(beats[0].end - beats[0].start >= 4 - 1e-6, `хук дотянут до ${beats[0].end - beats[0].start} с`);
  assert.equal(beats[1].start, beats[0].end, "биты остаются встык");
  assert.ok(beats[1].end - beats[1].start >= 1.0, "соседу осталось не меньше секунды");
});

test("редьюсер снимает открывающую сцену последней", async () => {
  const { reduceToBudget } = await import("../lib/aiFilm/plan");
  const bible = bibleOf("explainer");
  const mk = (id: string, start: number, end: number, mode: "full_ai" | "author", prio: "low" | "medium" | "high", purpose: any): StoryBeat =>
    ({ ...beat({ visualAction: mode === "author" ? "" : "x" }), id, start, end, displayMode: mode, requiresGeneration: mode !== "author", priority: prio, purpose, suggestedDuration: end - start });
  const beats = [
    mk("B1", 0, 6, "full_ai", "medium", "hook"),
    mk("B2", 6, 20, "author", "medium", "explain"),
    mk("B3", 20, 28, "full_ai", "medium", "example"),
    mk("B4", 28, 44, "author", "medium", "explain"),
  ];
  // бюджета хватает ровно на одну сцену — снять обязаны позднюю, а не первую
  const cfg = { key: "k", universe, budgetUsd: 0.7, maxCoverage: 0.55, concurrency: 1, callMinutes: 2 };
  const r = reduceToBudget(beats, withRefs, bible, 44, cfg);
  assert.equal(r.beats.find((b) => b.id === "B1")?.displayMode, "full_ai", "открывающая сцена остаётся");
  assert.equal(r.beats.find((b) => b.id === "B3")?.displayMode, "author", "снимается поздняя");
});

test("хук спасается, даже если следующий бит сам был коротким AI", () => {
  // ровно та форма ответа, на которой прошлая правка не сработала:
  // B1 три секунды AI, B2 тоже короткий AI, и только потом длинный автор
  const words = Array.from({ length: 30 }, (_, i) => ({ word: `сл${i}${i % 3 === 2 ? "." : ""}`, start: i * 0.9, end: i * 0.9 + 0.9 }));
  const phrases = phrasesFromWords(words as any);
  const beats = beatsFromRaw(
    [
      { fromPhrase: 1, toPhrase: 1, displayMode: "full_ai", visualAction: "he taps order on a phone", purpose: "hook", priority: "high" },
      { fromPhrase: 2, toPhrase: 2, displayMode: "full_ai", visualAction: "a box lands on the doormat" },
      { fromPhrase: 3, toPhrase: 10, displayMode: "author" },
    ] as any,
    phrases, 27,
  );
  assert.equal(beats[0].displayMode, "full_ai", "открывающая сцена остаётся сценой");
  assert.ok(beats[0].end - beats[0].start >= 4 - 1e-6);
  assert.equal(beats[1].displayMode, "author", "короткий второй AI-бит по-прежнему уходит автору");
  assert.equal(beats[1].start, beats[0].end, "биты остаются встык");
});

test("ракурс и композиция приходят из плана, а не одинаковые на все сцены", () => {
  const bible = bibleOf("explainer");
  // купол над головой: человек внизу кадра, сверху оставлено место
  const above = promptFor(bible, beat({
    visualAction: "he hangs under the bright orange nylon canopy",
    keyMoment: "the orange canopy is fully open above him",
    composition: "low_space_above", cameraAngle: "low_angle", shotType: "medium_wide",
  }));
  assert.match(above, /What this shot is about sits LOW in the frame/);
  assert.match(above, /the whole upper half stays clear/);
  assert.match(above, /never cropped by the top edge/);
  assert.match(above, /Camera angle: camera below the action, tilted up/);
  assert.match(above, /is unmistakable on screen/);
  // прежняя жёсткая строка про центр из промпта ушла
  assert.doesNotMatch(above, /subject near the vertical center/);

  // вид строго сверху на падение
  const down = promptFor(bible, beat({ visualAction: "he falls away from the camera", composition: "high_space_below", cameraAngle: "overhead" }));
  assert.match(down, /camera directly above the action, looking straight down at it/);
  assert.match(down, /What this shot is about sits HIGH in the frame/);

  // и обычный кадр остаётся обычным
  const plain = promptFor(bible, beat({ visualAction: "he sits at a table" }));
  assert.match(plain, /near the centre of the frame/);
  assert.match(plain, /Camera angle: camera level with the action, seeing it straight on/);
});

test("нормализатор принимает ракурс и композицию модели и чинит мусор", () => {
  const phrases = phrasesFromWords(Array.from({ length: 24 }, (_, i) => ({ word: `с${i}${i % 4 === 3 ? "." : ""}`, start: i * 0.6, end: i * 0.6 + 0.6 })) as any);
  const beats = beatsFromRaw(
    [
      { fromPhrase: 1, toPhrase: 3, displayMode: "full_ai", visualAction: "x", cameraAngle: "overhead", composition: "high_space_below" },
      { fromPhrase: 4, toPhrase: 6, displayMode: "full_ai", visualAction: "y", cameraAngle: "с вертолёта", composition: "по центру" },
    ] as any,
    phrases, 14.4,
  );
  assert.equal(beats[0].cameraAngle, "overhead");
  assert.equal(beats[0].composition, "high_space_below");
  assert.equal(beats[1].cameraAngle, "eye_level", "неизвестный ракурс — безопасное значение");
  assert.equal(beats[1].composition, "center");
});

test("фон эталонов не подменяет место действия", () => {
  const bible = bibleOf("explainer");
  const b = beat({ gudiniVisible: true, visualAction: "he crouches by a delivery box on a porch", location: "a wooden porch of a suburban house" });
  const withPack = promptFor(bible, b, withRefs);
  assert.match(withPack, /Ignore their plain studio background completely/);
  assert.match(withPack, /Location: a wooden porch/);
  // без эталонов лишней строки нет
  assert.doesNotMatch(promptFor(bible, b, character), /Ignore their plain studio background/);
});

test("план предупреждает, когда исполнителя назвали не его именем", async () => {
  const { buildFilmPlan } = await import("../lib/aiFilm/plan");
  const bible = bibleOf("news", { playedByGudini: "Каспер" });
  const cfg = { key: "k", universe, budgetUsd: 12, maxCoverage: 0.55, concurrency: 3, callMinutes: 2 };
  const wrong = buildFilmPlan({
    character: withRefs, bible, duration: 30, cfg,
    beats: [beat({ id: "B1", start: 0, end: 8, gudiniVisible: true, visualAction: "Casper pulls the reserve handle" }),
            { ...beat({ visualAction: "" }), id: "B2", start: 8, end: 30, displayMode: "author", requiresGeneration: false, gudiniVisible: false }],
  });
  assert.ok(wrong.warnings.some((w) => /назван иначе \(B1\)/.test(w)), wrong.warnings.join(" | "));
  const right = buildFilmPlan({
    character: withRefs, bible, duration: 30, cfg,
    beats: [beat({ id: "B1", start: 0, end: 8, gudiniVisible: true, visualAction: "Gudini pulls the reserve handle" }),
            { ...beat({ visualAction: "" }), id: "B2", start: 8, end: 30, displayMode: "author", requiresGeneration: false, gudiniVisible: false }],
  });
  assert.ok(!right.warnings.some((w) => /назван иначе/.test(w)), right.warnings.join(" | "));
});

test("нужное число сцен считается из длины речи", async () => {
  const { minScenes, MAX_AUTHOR_STRETCH_SEC } = await import("../lib/aiFilm/story");
  assert.equal(minScenes(44.5), 4, "на 45 секундах — четыре сцены");
  assert.equal(minScenes(10), 1, "короткая речь обходится одной");
  assert.ok(minScenes(120) >= 8, `на двух минутах ${minScenes(120)}`);
  // проверка смысла: сцены плюс разрывы покрывают всю длину
  for (const d of [30, 44.5, 60, 90, 120]) {
    const n = minScenes(d);
    assert.ok(n * 4 + n * MAX_AUTHOR_STRETCH_SEC >= d, `${d} с не покрывается ${n} сценами`);
  }
});

test("план замечает два соседних кадра с одного ракурса", async () => {
  const { buildFilmPlan } = await import("../lib/aiFilm/plan");
  const bible = bibleOf("explainer");
  const cfg = { key: "k", universe, budgetUsd: 12, maxCoverage: 0.55, concurrency: 3, callMinutes: 2 };
  const same = buildFilmPlan({
    character: withRefs, bible, duration: 40, cfg,
    beats: [
      beat({ id: "B1", start: 0, end: 8, cameraAngle: "overhead", visualAction: "x" }),
      { ...beat({ visualAction: "" }), id: "B2", start: 8, end: 14, displayMode: "author", requiresGeneration: false, gudiniVisible: false },
      beat({ id: "B3", start: 14, end: 22, cameraAngle: "overhead", visualAction: "y" }),
      { ...beat({ visualAction: "" }), id: "B4", start: 22, end: 40, displayMode: "author", requiresGeneration: false, gudiniVisible: false },
    ],
  });
  assert.ok(same.warnings.some((w) => /одного ракурса \(B3\)/.test(w)), same.warnings.join(" | "));
  const varied = buildFilmPlan({
    character: withRefs, bible, duration: 40, cfg,
    beats: [
      beat({ id: "B1", start: 0, end: 8, cameraAngle: "overhead", visualAction: "x" }),
      { ...beat({ visualAction: "" }), id: "B2", start: 8, end: 14, displayMode: "author", requiresGeneration: false, gudiniVisible: false },
      beat({ id: "B3", start: 14, end: 22, cameraAngle: "ground_level", visualAction: "y" }),
      { ...beat({ visualAction: "" }), id: "B4", start: 22, end: 40, displayMode: "author", requiresGeneration: false, gudiniVisible: false },
    ],
  });
  assert.ok(!varied.warnings.some((w) => /одного ракурса/.test(w)), varied.warnings.join(" | "));
});

test("сцена без события ловится планом", async () => {
  const { buildFilmPlan, EVENT_ACTION } = await import("../lib/aiFilm/plan");
  // проверяем отсутствие события, а не присутствие покоя
  assert.ok(!EVENT_ACTION.test("Gudini stands at the cliff edge and tightens a strap"));
  assert.ok(!EVENT_ACTION.test("Gudini checks his harness"));
  assert.ok(EVENT_ACTION.test("the orange canopy tears apart above him"));
  assert.ok(EVENT_ACTION.test("Gudini pulls the reserve handle and the canopy opens"));
  // сцена, начинающаяся со статичного глагола, но с настоящим действием, ложно не ловится
  assert.ok(EVENT_ACTION.test("Gudini sits at a desk, tears open a cardboard box and pulls out a canopy"));

  const bible = bibleOf("explainer");
  const cfg = { key: "k", universe, budgetUsd: 12, maxCoverage: 0.65, concurrency: 3, callMinutes: 2 };
  const author = { ...beat({ visualAction: "" }), id: "B2", start: 8, end: 40, displayMode: "author" as const, requiresGeneration: false, gudiniVisible: false };
  const idle = buildFilmPlan({
    character: withRefs, bible, duration: 40, cfg,
    beats: [beat({ id: "B1", start: 0, end: 8, visualAction: "Gudini stands at the cliff edge and tightens a strap", stateBefore: "geared up", stateAfter: "geared up" }), author],
  });
  assert.ok(idle.warnings.some((w) => /Сцены без события \(B1\)/.test(w)), idle.warnings.join(" | "));

  const event = buildFilmPlan({
    character: withRefs, bible, duration: 40, cfg,
    beats: [beat({ id: "B1", start: 0, end: 8, visualAction: "the orange canopy tears apart above Gudini", stateBefore: "canopy whole", stateAfter: "canopy shredded" }), author],
  });
  assert.ok(!event.warnings.some((w) => /Сцены без события/.test(w)), event.warnings.join(" | "));
});

test("существительное, похожее на глагол, за событие не считается", async () => {
  const { hasEvent } = await import("../lib/aiFilm/plan");
  // ровно тот случай, что проскочил: «смотрит вниз на обрыв» — это не событие
  assert.ok(!hasEvent("Gudini stands near the edge, looking down at the drop below"));
  assert.ok(!hasEvent("he waits at the landing field after his fall"));
  assert.ok(!hasEvent("he stands right at the edge with the rig on his back"));
  // а настоящие действия по-прежнему считаются
  assert.ok(hasEvent("he drops the rig on the grass"));
  assert.ok(hasEvent("the canopy tears open above him"));
  assert.ok(hasEvent("he steps off the edge and falls"));
});

test("камера и композиция сводятся к одному непротиворечивому описанию", async () => {
  const { reconcileFraming, angleFromCameraText } = await import("../lib/aiFilm/story");
  // ровно тот случай, который вывернул тело в кадре
  const broken = { camera: "Camera is below and slightly behind him looking up as he falls straight down past it", cameraAngle: "overhead" as const, composition: "low_space_above" as const };
  assert.equal(angleFromCameraText(broken.camera), "low_angle");
  assert.equal(reconcileFraming(broken), true);
  assert.equal(broken.cameraAngle, "low_angle", "правдой считается текстовое описание камеры");

  // камера сверху и место над головой — взаимоисключающие требования
  const above = { camera: "Camera watches him from the far side of the field", cameraAngle: "overhead" as const, composition: "low_space_above" as const };
  reconcileFraming(above);
  assert.equal(above.cameraAngle, "low_angle");

  // и обратная пара
  const below = { camera: "Camera watches from the far side", cameraAngle: "ground_level" as const, composition: "high_space_below" as const };
  reconcileFraming(below);
  assert.equal(below.cameraAngle, "high_angle");

  // согласованное описание не трогаем
  const fine = { camera: "Camera is directly above him looking straight down at the ground far below", cameraAngle: "overhead" as const, composition: "high_space_below" as const };
  assert.equal(reconcileFraming(fine), false);
  assert.equal(fine.cameraAngle, "overhead");
});

test("камера перед героем и из-за плеча — тоже противоречие", async () => {
  const { angleFromCameraText, reconcileFraming } = await import("../lib/aiFilm/story");
  // строка из настоящего плана: ракурс «из-за плеча», а камера стоит перед ним
  const real = "Camera is at desk height about one meter in front of him; he leans forward pressing the trackpad";
  assert.equal(angleFromCameraText(real), "eye_level");
  const b = { camera: real, cameraAngle: "over_shoulder" as const, composition: "center" as const };
  assert.equal(reconcileFraming(b), true);
  assert.equal(b.cameraAngle, "eye_level");
  // а настоящее «из-за плеча» распознаётся как есть
  assert.equal(angleFromCameraText("Camera is behind his shoulder as he reads the screen"), "over_shoulder");
});

test("склейка внутри одной сцены попадает в предупреждения", async () => {
  const { buildFilmPlan } = await import("../lib/aiFilm/plan");
  const bible = bibleOf("explainer");
  const cfg = { key: "k", universe, budgetUsd: 12, maxCoverage: 0.65, concurrency: 3, callMinutes: 2 };
  const author = { ...beat({ visualAction: "" }), id: "B2", start: 8, end: 40, displayMode: "author" as const, requiresGeneration: false, gudiniVisible: false };
  const withCut = buildFilmPlan({
    character: withRefs, bible, duration: 40, cfg,
    beats: [beat({ id: "B1", start: 0, end: 8, visualAction: "Gudini taps a checkout button, then cuts to him opening the box" }), author],
  });
  assert.ok(withCut.warnings.some((w) => /Склейка внутри одной сцены \(B1\)/.test(w)), withCut.warnings.join(" | "));
  const clean = buildFilmPlan({
    character: withRefs, bible, duration: 40, cfg,
    beats: [beat({ id: "B1", start: 0, end: 8, visualAction: "Gudini taps a checkout button on the laptop" }), author],
  });
  assert.ok(!clean.warnings.some((w) => /Склейка внутри/.test(w)), clean.warnings.join(" | "));
});

test("правдой остаётся текст камеры, подстраивается композиция", async () => {
  const { reconcileFraming } = await import("../lib/aiFilm/story");
  // ровно тот случай, который создала первая версия правила: текст «сверху вниз»,
  // а ракурс был перебит на «снизу вверх»
  const b = { camera: "Camera is above him looking straight down as he falls away from it", cameraAngle: "low_angle" as const, composition: "low_space_above" as const };
  reconcileFraming(b);
  assert.equal(b.cameraAngle, "overhead", "ракурс берётся из текста");
  assert.equal(b.composition, "high_space_below", "подстраивается композиция, а не ракурс");

  // и наоборот: камера снизу — место оставляем сверху
  const c = { camera: "Camera is below him looking up as the canopy opens", cameraAngle: "high_angle" as const, composition: "high_space_below" as const };
  reconcileFraming(c);
  assert.equal(c.cameraAngle, "low_angle");
  assert.equal(c.composition, "low_space_above");

  // текст ничего не говорит о позиции — тогда правит композиция
  const d = { camera: "Camera holds steady on the doorway", cameraAngle: "overhead" as const, composition: "low_space_above" as const };
  reconcileFraming(d);
  assert.equal(d.cameraAngle, "low_angle");
  assert.equal(d.composition, "low_space_above");
});

test("«at eye level» без притяжательного тоже распознаётся", async () => {
  const { angleFromCameraText } = await import("../lib/aiFilm/story");
  // строка из настоящего плана: ракурс стоял «сверху», а камера на уровне глаз
  assert.equal(angleFromCameraText("Camera is on the cliff behind him at eye level; Gudini walks away from camera"), "eye_level");
  assert.equal(angleFromCameraText("Camera is at eye level a meter in front of him, static"), "eye_level");
});

test("разбор плана находит противоречия и не шумит на здоровых сценах", async () => {
  const { auditPlan } = await import("../lib/aiFilm/audit");
  // контракт событий у здорового плана не пустой: пустой контракт — сам по себе дефект
  const bible = {
    ...bibleOf("explainer"),
    events: [{ id: "open", observable: "the box opens", required: false, fromPhrase: 0, toPhrase: 0, objects: [{ id: "box", before: "sealed", after: "open" }] }],
  };
  const hero = { name: "Gudini", referenceFiles: ["/tmp/r.png"] };
  const codes = (bs: StoryBeat[]) => auditPlan(bs, bible, hero).map((a) => a.code);

  // камера неподвижна и движется одновременно
  assert.ok(codes([beat({ visualAction: "Gudini opens the box", camera: "Camera is static and slowly pans across the room" })]).includes("camera-static-and-moving"));
  // движение человека камеру неподвижной быть не мешает
  assert.ok(!codes([beat({ visualAction: "Gudini opens the box", camera: "Camera is at eye level in front of him, static; his hands move toward the camera" })]).includes("camera-static-and-moving"));

  // пять действий в одной сцене
  assert.ok(codes([beat({ visualAction: "he runs, jumps, turns, pulls the handle and lands on the grass" })]).includes("too-many-actions"));
  // крупный план с местом под предмет
  assert.ok(codes([beat({ visualAction: "the canopy opens", shotType: "close", composition: "low_space_above" })]).includes("shot-vs-composition"));
  // просьба показать читаемый текст
  assert.ok(codes([beat({ visualAction: "he holds a receipt, the text on it says five dollars" })]).includes("readable-text"));
  // флаг героя расходится с действием
  assert.ok(codes([beat({ gudiniVisible: true, visualAction: "a man in a suit walks out" })]).includes("hero-flag-mismatch"));

  // порванное стало целым — проверяется по идентификатору предмета, а не по словам
  assert.ok(codes([
    beat({ id: "B1", visualAction: "the canopy tears", objects: [{ id: "main-canopy", before: "whole", after: "torn and shredded" }] }),
    beat({ id: "B2", visualAction: "he lands", objects: [{ id: "main-canopy", before: "whole and folded", after: "whole and folded" }] }),
  ]).includes("state-regression"));
  // порванный основной и упакованный запасной — разные предметы, ложной регрессии нет
  assert.ok(!codes([
    beat({ id: "B1", visualAction: "the canopy tears", objects: [{ id: "main-canopy", before: "whole", after: "torn and shredded" }] }),
    beat({ id: "B2", visualAction: "he pulls the reserve", objects: [{ id: "reserve-canopy", before: "packed and closed", after: "fully open" }] }),
  ]).includes("state-regression"));

  // место возвращается через сцену
  assert.ok(codes([
    beat({ id: "B1", visualAction: "x", location: "the cliff edge" }),
    beat({ id: "B2", visualAction: "y", location: "open sky" }),
    beat({ id: "B3", visualAction: "z", location: "the cliff edge" }),
  ]).includes("location-jump-back"));

  // здоровая сцена не даёт ни одной претензии
  assert.deepEqual(codes([beat({ gudiniVisible: true, visualAction: "Gudini tears open the box", camera: "Camera is at eye level in front of him", shotType: "medium", composition: "center" })]), []);
});

test("названный словами ракурс читается напрямую", async () => {
  const { angleFromCameraText, reconcileFraming } = await import("../lib/aiFilm/story");
  // строка из настоящего плана: поле говорило high_angle, текст — low angle
  const real = "Camera is behind him at the cliff edge, low angle looking down the drop";
  assert.equal(angleFromCameraText(real), "low_angle");
  const b = { camera: real, cameraAngle: "high_angle" as const, composition: "high_space_below" as const };
  reconcileFraming(b);
  assert.equal(b.cameraAngle, "low_angle");
  assert.equal(b.composition, "low_space_above", "под камеру снизу место оставляется сверху");
  assert.equal(angleFromCameraText("An overhead shot as he lies on the grass"), "overhead");
  assert.equal(angleFromCameraText("Camera at ground-level near his boots"), "ground_level");
});

test("камера сверху и предмет над головой — противоречие", async () => {
  const { auditPlan } = await import("../lib/aiFilm/audit");
  const bible = bibleOf("explainer");
  const hero = { name: "Gudini", referenceFiles: ["/tmp/r.png"] };
  const codes = (bs: StoryBeat[]) => auditPlan(bs, bible, hero).map((a) => a.code);
  // ровно тот случай из плана: камера строго сверху, а купол над ним
  assert.ok(codes([beat({
    visualAction: "Gudini falls as the canopy balloons open above him",
    cameraAngle: "overhead", composition: "high_space_below",
  })]).includes("camera-above-object-above"));
  // камера снизу с тем же действием противоречия не даёт
  assert.ok(!codes([beat({
    visualAction: "Gudini falls as the canopy balloons open above him",
    cameraAngle: "low_angle", composition: "low_space_above",
  })]).includes("camera-above-object-above"));
});

test("положение камеры «сбоку» и «на высоте стола» распознаётся", async () => {
  const { angleFromCameraText } = await import("../lib/aiFilm/story");
  assert.equal(angleFromCameraText("Camera is at desk height about one meter away, slightly to the side"), "eye_level");
  assert.equal(angleFromCameraText("Camera sits off to the side of the table"), "profile");
});

test("камера переставляется вниз, если важное над головой", async () => {
  const { reconcileFraming } = await import("../lib/aiFilm/story");
  const b = {
    camera: "Camera is directly above him looking straight down; he falls away from it",
    cameraAngle: "overhead" as const,
    composition: "high_space_below" as const,
    visualAction: "Gudini falls as the orange canopy balloons open above him",
    keyMoment: "the canopy opens above him",
  };
  assert.equal(reconcileFraming(b), true);
  assert.equal(b.cameraAngle, "low_angle");
  assert.equal(b.composition, "low_space_above");
  assert.match(b.camera, /below him looking up/);
  // прежний хвост «он падает ОТ неё» сохранялся как есть и противоречил новой камере:
  // направление движения пересчитывается вместе с точкой съёмки
  assert.match(b.camera, /he falls toward the camera/);
  assert.doesNotMatch(b.camera, /away from/);
  assert.doesNotMatch(b.camera, /directly above/);

  // если над головой ничего нет, съёмка сверху остаётся как была
  const ok = {
    camera: "Camera is directly above him looking straight down at the ground",
    cameraAngle: "overhead" as const,
    composition: "high_space_below" as const,
    visualAction: "Gudini lies on the grass after landing",
    keyMoment: "he stops moving",
  };
  reconcileFraming(ok);
  assert.equal(ok.cameraAngle, "overhead");
});
