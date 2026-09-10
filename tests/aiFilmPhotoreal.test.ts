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
  keyMoment: "", anchorPhrase: "", stateBefore: "", stateAfter: "",
  continuityGroup: null, continuityRequired: false, transition: "cut", shotType: "medium",
  camera: "Camera stands across the street at eye height; he walks past camera on the left",
  cameraAngle: "eye_level", composition: "center",
  suggestedDuration: 8, ...o,
});

const promptFor = (bible: StoryBible, b: StoryBeat, c: CharacterProfile = character) =>
  shotPrompt({ character: c, universe, bible, beat: b, prev: null, mode: "text", aspectRatio: "9:16" });

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
  assert.match(p, /People in frame: exactly 1 — Gudini/);
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
  assert.match(above, /The subject sits LOW in the frame/);
  assert.match(above, /upper half of the frame is kept clear/);
  assert.match(above, /never cropped by the top edge/);
  assert.match(above, /Camera angle: camera below the subject, tilted up/);
  assert.match(above, /fully inside the frame, not cropped at any edge/);
  // прежняя жёсткая строка про центр из промпта ушла
  assert.doesNotMatch(above, /subject near the vertical center/);

  // вид строго сверху на падение
  const down = promptFor(bible, beat({ visualAction: "he falls away from the camera", composition: "high_space_below", cameraAngle: "overhead" }));
  assert.match(down, /camera directly above the subject looking straight down/);
  assert.match(down, /The subject sits HIGH in the frame/);

  // и обычный кадр остаётся обычным
  const plain = promptFor(bible, beat({ visualAction: "he sits at a table" }));
  assert.match(plain, /near the centre of the frame/);
  assert.match(plain, /Camera angle: camera at the subject's own eye level/);
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
