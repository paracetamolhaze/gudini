import test from "node:test";
import assert from "node:assert/strict";
import { phrasesFromWords, beatsFromRaw, normalizeBible, renameHeroToCharacter, MIN_AI_BEAT_SEC, MAX_AI_BEAT_SEC } from "../lib/aiFilm/story";
import {
  buildFilmPlan, buildShots, groupBeats, shotKey, shotPrompt, estimateWallMinutes, reduceToBudget, planVersionError, enforceShotBudget, closeTinyAuthorGaps, PLAN_VERSION,
  type PlanConfig,
} from "../lib/aiFilm/plan";
import { normalizeVeoDuration, isThirdPartyContentError } from "../lib/aiFilm/veo";
import { debrandPrompt } from "../lib/aiFilm/plan";
import { openrouterRequestBody } from "../lib/mediaLlm";
import { loadUniverseProfile, universePromptBlock, universePlannerBlock } from "../lib/aiFilm/universe";
import { planKeyDiff } from "../lib/aiFilm/run";
import type { CharacterProfile, StoryBeat, StoryBible, DisplayMode, BeatPurpose, Priority } from "../lib/aiFilm/types";

const words = (text: string, secPerWord = 0.4) =>
  text.split(/\s+/).map((w, i) => ({ word: w, start: i * secPerWord, end: i * secPerWord + 0.3 }));

export const gudini: CharacterProfile = {
  id: "gudini",
  name: "Gudini",
  role: "main_protagonist",
  description: "Gudini, a young shinobi of a hidden village",
  appearance: "short spiky platinum-blond hair, brown eyes",
  clothes: "olive utility vest over a black long-sleeve shirt",
  signature: "platinum spiky hair, forehead plate",
  styleLock: "stylized cinematic anime, cel shading",
  world: "an original hidden ninja village",
  negative: "no hair color change",
  referenceImages: ["ref-1.png", "ref-2.png"],
  referenceFiles: [],
  refHash: "refs-a",
  dir: "/tmp/gudini",
};
const withRefs: CharacterProfile = { ...gudini, referenceFiles: ["/tmp/gudini/ref-1.png", "/tmp/gudini/ref-2.png"] };
export const universe = loadUniverseProfile();

const bible: StoryBible = normalizeBible({ bible: { mood: "tense", visualStyle: "photorealism (must be ignored)" }, storyArc: { gudiniRole: "a scout on a mission" } } as any, gudini, universe);

export const beat = (
  id: string, start: number, end: number, mode: DisplayMode,
  o: Partial<Pick<StoryBeat, "purpose" | "priority" | "continuityGroup" | "gudiniVisible" | "visualAction" | "keyMoment" | "anchorPhrase">> = {},
): StoryBeat => ({
  id, start, end,
  meaning: `смысл ${id}`, storyBeat: `бит ${id}`,
  universeAdaptation: mode === "author" ? "" : `adapted ${id} into the village`,
  displayMode: mode,
  purpose: (o.purpose ?? "explain") as BeatPurpose,
  priority: (o.priority ?? "medium") as Priority,
  requiresGeneration: mode !== "author",
  gudiniVisible: mode !== "author" && (o.gudiniVisible ?? true),
  visualAction: mode === "author" ? "" : o.visualAction ?? `Gudini does action ${id}`,
  keyMoment: mode === "author" ? "" : o.keyMoment ?? `something changes in ${id}`,
  anchorPhrase: mode === "author" ? "" : o.anchorPhrase ?? "",
  anchorAtSec: null,
  anchorAbsSec: null,
  eventIds: [],
  objects: [],
  location: mode === "author" ? "" : "village rooftop",
  motion: mode === "author" ? "" : "0-3s: he steps forward. 3-6s: camera pushes in. 6-8s: he stops.",
  stateBefore: "he stands", stateAfter: `state after ${id}`,
  continuityGroup: o.continuityGroup ?? null,
  continuityRequired: Boolean(o.continuityGroup),
  transition: "cut", shotType: "medium", frameSubject: "", camera: "slow push-in", cameraAngle: "eye_level", composition: "center",
  suggestedDuration: end - start,
});

const cfg = (over: Partial<PlanConfig> = {}): PlanConfig => ({ key: "k", universe, budgetUsd: 12, maxCoverage: 0.55, concurrency: 3, callMinutes: 2, overheadMinutes: 1, ...over });

/** условный 120-секундный ролик: 5 AI-сцен, остальное автор */
const beats120 = () => [
  beat("B1", 0, 6, "full_ai", { purpose: "hook", priority: "high" }),
  beat("B2", 6, 17, "author"),
  beat("B3", 17, 24, "hybrid", { purpose: "example", priority: "medium" }),
  beat("B4", 24, 38, "author"),
  beat("B5", 38, 46, "full_ai", { purpose: "reveal", priority: "high" }),
  beat("B6", 46, 70, "author"),
  beat("B7", 70, 78, "full_ai", { purpose: "example", priority: "low" }),
  beat("B8", 78, 100, "author"),
  beat("B9", 100, 108, "full_ai", { purpose: "climax", priority: "high" }),
  beat("B10", 108, 120, "author"),
];

test("фразы для модели не длиннее 5 с и 14 слов даже без знаков препинания", () => {
  const w = words(Array.from({ length: 80 }, (_, i) => `слово${i}`).join(" "), 0.4);
  const s = phrasesFromWords(w);
  assert.ok(s.length >= 6);
  for (const x of s) {
    assert.ok(x.end - x.start <= 5.5);
    assert.ok(x.text.split(" ").length <= 14);
  }
});

test("биты из ответа модели: встык от 0 до конца, AI короче 4 с → автор, AI длиннее 15 с режется", () => {
  const w = words(Array.from({ length: 100 }, (_, i) => `w${i}${i % 5 === 4 ? "." : ""}`).join(" ")); // 20 фраз по 2 с
  const phrases = phrasesFromWords(w);
  assert.equal(phrases.length, 20);
  const raw = [
    { fromPhrase: 1, toPhrase: 1, displayMode: "full_ai", visualAction: "Gudini opens a door", priority: "high", purpose: "hook" }, // 1.9 с → автор
    { fromPhrase: 2, toPhrase: 4, displayMode: "author" },
    { fromPhrase: 5, toPhrase: 14, displayMode: "full_ai", visualAction: "Gudini walks the rooftops" }, // ~19.9 с → режется
    { fromPhrase: 15, toPhrase: 20, displayMode: "author" },
  ];
  const beats = beatsFromRaw(raw as any, phrases, 42);
  assert.equal(beats[0].start, 0);
  assert.equal(beats[beats.length - 1].end, 42);
  for (let i = 1; i < beats.length; i++) assert.equal(beats[i].start, beats[i - 1].end);
  // открывающая сцена короче минимума теперь дотягивается за счёт соседа, а не выбрасывается
  assert.equal(beats[0].displayMode, "full_ai");
  assert.ok(beats[0].end - beats[0].start >= MIN_AI_BEAT_SEC - 1e-6);
  const ai = beats.filter((b) => b.displayMode !== "author");
  assert.equal(ai.length, 2, "открывающая сцена и одна разрезанная");
  assert.ok(beats.some((b) => b.displayMode === "author" && /продолжение AI-бита/.test(b.reduced ?? "")), "хвост длинного AI-бита стал автором");
  for (const b of ai) {
    assert.ok(b.end - b.start <= MAX_AI_BEAT_SEC + 0.5, `${b.id}: ${(b.end - b.start).toFixed(1)} с`);
    assert.ok(b.end - b.start >= MIN_AI_BEAT_SEC - 1e-6);
  }
});

test("Story Bible: стиль и мир берутся из профиля персонажа, модель их не переопределяет", () => {
  assert.equal(bible.visualStyle, gudini.styleLock);
  assert.equal(bible.world, `${universe.name}: ${universe.architecture}`, "мир — из Universe Lock, не из ответа модели");
  assert.equal(bible.universeId, universe.id);
  assert.equal(bible.characterId, "gudini");
  assert.equal(bible.storyArc.gudiniRole, "a scout on a mission");
});

test("A/B/C: 120 с речи не превращаются в 120 с AI; author-биты — 0 вызовов; full_ai — shots", () => {
  const plan = buildFilmPlan({ character: withRefs, bible, beats: beats120(), duration: 120, cfg: cfg() });
  assert.equal(plan.version, PLAN_VERSION);
  assert.equal(plan.stats.speechSeconds, 120);
  assert.equal(plan.stats.aiSeconds, 37);
  assert.ok(plan.stats.generatedSeconds <= 60, `Veo-секунд ${plan.stats.generatedSeconds}`);
  assert.ok(plan.stats.coverage < 0.55);
  const authorOnly = buildFilmPlan({ character: withRefs, bible, beats: [beat("B1", 0, 60, "author"), beat("B2", 60, 120, "author")], duration: 120, cfg: cfg() });
  assert.equal(authorOnly.shots.length, 0);
  assert.equal(authorOnly.stats.calls, 0);
  assert.equal(authorOnly.stats.estimatedCost, 0);
  assert.equal(plan.shots.filter((s) => s.displayMode === "full_ai").length, 4);
  assert.equal(plan.shots.filter((s) => s.displayMode === "hybrid").length, 1);
  assert.ok(plan.shots.every((s) => s.mode === "text"), "независимые сцены — text-to-video");
  assert.deepEqual(plan.timeline.map((t) => t.mode), ["full_ai", "author", "hybrid", "author", "full_ai", "author", "full_ai", "author", "full_ai", "author"]);
});

test("D: главный герой всегда Gudini — в каждом shot с героем его identity из профиля", () => {
  const plan = buildFilmPlan({ character: withRefs, bible, beats: beats120(), duration: 120, cfg: cfg() });
  assert.equal(plan.character.id, "gudini");
  assert.equal(plan.character.refHash, "refs-a");
  for (const s of plan.shots.filter((s) => s.gudiniVisible)) {
    assert.match(s.prompt, /Main character GUDINI/);
    assert.match(s.prompt, /platinum-blond hair/);
    assert.match(s.prompt, /olive utility vest/);
    assert.ok(s.useReferences, `${s.id} использует эталоны`);
    assert.equal(s.veoSeconds, 8, "с референсами Veo принимает только 8 с");
    assert.equal(s.generationProfile, "character");
  }
  const env = buildShots([beat("B1", 0, 6, "full_ai", { gudiniVisible: false, visualAction: "an empty training ground at dawn" }), beat("B2", 6, 30, "author")], withRefs, bible, cfg());
  assert.equal(env.shots[0].useReferences, false);
  assert.equal(env.shots[0].generationProfile, "environment");
  assert.equal(env.shots[0].veoSeconds, 6);
  assert.doesNotMatch(env.shots[0].prompt, /Main character/);
});

test("E: смена хэша эталонов меняет ключ кэша сцен с героем и не трогает сцены без него", () => {
  const plan = buildFilmPlan({ character: withRefs, bible, beats: beats120(), duration: 120, cfg: cfg() });
  const hero = plan.shots[0];
  assert.notEqual(shotKey(hero, "refs-a", null), shotKey(hero, "refs-b", null));
  const env = buildShots([beat("B1", 0, 6, "full_ai", { gudiniVisible: false }), beat("B2", 6, 30, "author")], withRefs, bible, cfg()).shots[0];
  assert.equal(shotKey(env, "refs-a", null), shotKey(env, "refs-b", null));
});

test("F/G: независимые группы без зависимостей; цепочка сохраняет dependsOn и extension", () => {
  const plan = buildFilmPlan({ character: withRefs, bible, beats: beats120(), duration: 120, cfg: cfg() });
  assert.ok(plan.groups.every((g) => !g.chain));
  assert.ok(plan.shots.every((s) => s.dependsOn === null));
  assert.equal(plan.stats.independentGroups, 5);
  const chainBeats = [
    beat("B1", 0, 10, "author"),
    beat("B2", 10, 18, "full_ai", { continuityGroup: "walk" }),
    beat("B3", 18, 25, "full_ai", { continuityGroup: "walk" }),
    beat("B4", 25, 60, "author"),
  ];
  assert.equal(groupBeats(chainBeats).length, 1);
  const chained = buildFilmPlan({ character: withRefs, bible, beats: chainBeats, duration: 60, cfg: cfg() });
  assert.equal(chained.groups.length, 1);
  assert.ok(chained.groups[0].chain);
  assert.equal(chained.shots.length, 2);
  assert.equal(chained.shots[0].mode, "text");
  assert.equal(chained.shots[1].mode, "extend");
  assert.equal(chained.shots[1].dependsOn, chained.shots[0].id);
  assert.equal(chained.shots[1].veoSeconds, 7);
  assert.equal(chained.shots[1].useReferences, false, "extension без референсов — API их не сочетает");
  assert.match(chained.shots[1].prompt, /Continue the same shot without a cut/);
  assert.equal(chained.stats.chains, 1);
  assert.equal(chained.stats.longestChainCalls, 2);
  // ключ второго shot зависит от ключа первого
  const k1 = shotKey(chained.shots[0], "refs-a", null);
  assert.notEqual(shotKey(chained.shots[1], "refs-a", k1), shotKey(chained.shots[1], "refs-a", "other"));
  // соседние AI-биты без общей метки — две независимые группы
  const separate = buildFilmPlan({ character: withRefs, bible, beats: [beat("B1", 0, 8, "full_ai"), beat("B2", 8, 16, "full_ai"), beat("B3", 16, 60, "author")], duration: 60, cfg: cfg() });
  assert.equal(separate.groups.length, 2);
  assert.ok(separate.shots.every((s) => s.dependsOn === null));
});

test("H: оценка времени учитывает параллельность, а не сумму вызовов", () => {
  const six = new Array(6).fill(0).map((_, i) => ({ shotIds: [`S${i}`] }));
  assert.equal(estimateWallMinutes(six, 3, 2, 1), 5); // 2 волны по 2 мин + накладные, не 13
  assert.equal(estimateWallMinutes(six, 1, 2, 1), 13);
  const mixed = [{ shotIds: ["a", "b", "c"] }, ...new Array(5).fill(0).map((_, i) => ({ shotIds: [`s${i}`] }))];
  assert.equal(estimateWallMinutes(mixed, 3, 2, 1), 7); // цепочка 6 мин задаёт нижнюю границу
  assert.equal(estimateWallMinutes([], 3, 2, 1), 0);
});

test("I: цена считается только по Veo-секундам сгенерированных shots, author — $0", () => {
  const prev = process.env.AI_FILM_PRICE_PER_SEC;
  delete process.env.AI_FILM_PRICE_PER_SEC;
  try {
    const plan = buildFilmPlan({ character: withRefs, bible, beats: beats120(), duration: 120, cfg: cfg() });
    const expected = Math.round(plan.stats.generatedSeconds * 0.08 * 100) / 100;
    assert.equal(plan.stats.estimatedCost, expected);
    assert.equal(plan.pricing.pricePerSec, 0.08);
    assert.equal(plan.pricing.source, "policy");
    assert.ok(plan.stats.estimatedCost < 120 * 0.08, "не цена всего ролика");
    assert.equal(plan.stats.generatedSeconds, 5 * 8);
  } finally {
    if (prev !== undefined) process.env.AI_FILM_PRICE_PER_SEC = prev;
  }
});

test("J: редьюсер снимает low, потом medium; hook/reveal/climax с high не трогает", () => {
  const beats = [
    beat("B1", 0, 8, "full_ai", { purpose: "hook", priority: "high" }),
    beat("B2", 8, 16, "full_ai", { priority: "low" }),
    beat("B3", 16, 24, "full_ai", { priority: "medium" }),
    beat("B4", 24, 32, "full_ai", { priority: "low" }),
    beat("B5", 32, 60, "author"),
  ];
  const r = reduceToBudget(beats, withRefs, bible, 60, cfg({ maxCoverage: 0.3 }));
  const byId = Object.fromEntries(r.beats.map((b) => [b.id, b]));
  assert.equal(byId.B2.displayMode, "author");
  assert.equal(byId.B4.displayMode, "author");
  assert.match(byId.B4.reduced ?? "", /покрытию/);
  assert.equal(byId.B3.displayMode, "full_ai", "medium остаётся, пока хватает low");
  assert.equal(byId.B1.displayMode, "full_ai");
  assert.ok(r.stats.coverage <= 0.3);
  // бюджет: $1 хватает только на одну сцену по $0.64 — остаётся hook
  const b = reduceToBudget(beats, withRefs, bible, 60, cfg({ budgetUsd: 1 }));
  assert.equal(b.beats.filter((x) => x.displayMode !== "author").length, 1);
  assert.equal(b.beats.find((x) => x.displayMode !== "author")!.id, "B1");
  assert.match(b.beats.find((x) => x.id === "B3")!.reduced ?? "", /бюджету/);
  // защищённая сцена не влезает — честная ошибка, а не тихое удаление hook
  assert.throws(() => reduceToBudget(beats, withRefs, bible, 60, cfg({ budgetUsd: 0.1 })), /не помещается в бюджет/);
});

test("нормализация длительностей Veo: 4/6/8, с референсами 8, extension 7", () => {
  assert.equal(normalizeVeoDuration(5.3, "text"), 6);
  assert.equal(normalizeVeoDuration(3, "text"), 4);
  assert.equal(normalizeVeoDuration(8.5, "text"), 8);
  assert.equal(normalizeVeoDuration(4, "text", { references: true }), 8);
  assert.equal(normalizeVeoDuration(3, "extend"), 7);
});

test("промпт shot: WHO/WHAT/WHERE/WHAT CHANGES, вертикальный кадр, запреты", () => {
  const b = beat("B1", 0, 8, "full_ai", { visualAction: "Gudini enters an empty training ground and picks up the last scroll" });
  const p = shotPrompt({ character: gudini, universe, bible, beats: [b], prev: null, mode: "text", aspectRatio: "9:16" });
  assert.match(p, /Action: Gudini enters/);
  assert.match(p, /Location: village rooftop/);
  assert.match(p, /After: state after B1/);
  assert.match(p, /vertical 9:16 portrait composition/);
  // текст запрещён один раз отдельной строкой, старый дублирующий хвост убран
  assert.match(p, /Nothing readable in frame/);
  assert.doesNotMatch(p, /No text, no captions, no subtitles/);
  assert.match(p, /No split screen, no talking to camera\.$/);
  assert.match(p, /no hair color change/);
  const h = shotPrompt({ character: gudini, universe, bible, beats: [{ ...b, displayMode: "hybrid" }], prev: null, mode: "text", aspectRatio: "16:9" });
  assert.match(h, /horizontal 16:9/);
});

test("старый план не интерпретируется: просьба пересобрать", () => {
  assert.match(planVersionError({ version: 2 })!, /устарел/);
  assert.equal(planVersionError({ version: PLAN_VERSION }), null);
  assert.equal(planVersionError(null), null);
});

test("Герой истории и постоянный персонаж — один человек в кадре", () => {
  const bs = [beat("B1", 0, 8, "full_ai", { visualAction: "Kasper checks Kasper's parachute" })];
  bs[0].motion = "0-3s: Kasper falls.";
  const n = renameHeroToCharacter(bs, "Kasper", "Gudini");
  assert.equal(n, 3);
  assert.equal(bs[0].visualAction, "Gudini checks Gudini's parachute");
  assert.equal(bs[0].motion, "0-3s: Gudini falls.");
  assert.equal(renameHeroToCharacter(bs, "", "Gudini"), 0);
  assert.equal(renameHeroToCharacter(bs, "Gudini", "Gudini"), 0);
});

test("Промпт шота: действие впереди, состав кадра назван, лишних людей нет", () => {
  const b = beat("B1", 0, 8, "full_ai", { visualAction: "Gudini opens a cardboard parcel with a shipping label" });
  const p = shotPrompt({ character: withRefs, universe, bible, beats: [b], prev: null, mode: "text", aspectRatio: "9:16" });
  const action = p.indexOf("Action:");
  assert.ok(action >= 0 && action < 200, `действие должно быть в начале промпта, а оно на ${action}`);
  assert.ok(action < p.indexOf("Style:"), "стиль должен идти после действия");
  assert.match(p, /Motion in order: 0-3s/);
  assert.match(p, /People taking part in the action: exactly 1 — Gudini/);
  // участников не добавляем, но естественный фон в общественном месте больше не запрещён
  assert.match(p, /No other participants/);
  assert.match(p, /Incidental passers-by are allowed only where the place would naturally have them/);
  assert.match(p, /nothing hovers or drifts in place/);
  // Единственная цель кадра идёт сразу за действием, до стиля и запретов
  const key = p.indexOf("The one thing that must be visible");
  assert.ok(key > action && key < p.indexOf("Style:"), "keyMoment должен стоять между действием и стилем");
  // Физика в общем блоке — только общая. Падение, поток воздуха и летящие обрывки были
  // инструкциями одной сцены и приписывались ко всем подряд
  assert.doesNotMatch(p, /falling bodies accelerate/);
  assert.doesNotMatch(p, /hammered by the airflow/);
  assert.doesNotMatch(p, /torn pieces/);
  assert.match(p, /Nothing readable in frame/);
  const alone = beat("B2", 0, 8, "full_ai", { gudiniVisible: false });
  assert.match(shotPrompt({ character: withRefs, universe, bible, beats: [alone], prev: null, mode: "text", aspectRatio: "9:16" }), /People taking part in the action: exactly as described above/);
});

test("Устаревший план называет, что именно разошлось", () => {
  const a = "spee:scri:3.3:veo/env:gudini@refs1:world@hash1";
  assert.deepEqual(planKeyDiff(a, a), ["ключ целиком"]);
  assert.deepEqual(planKeyDiff(a, "OTHER:scri:3.3:veo/env:gudini@refs1:world@hash1"), ["речь"]);
  assert.deepEqual(planKeyDiff(a, "spee:scri:3.3:veo/env:gudini@refs2:world@hash2"), ["профиль персонажа (описание или эталоны)", "профиль мира"]);
});

test("Universe Lock: мир из профиля попадает в сценариста, в план и в каждый промпт; без названия франшизы в промпте", () => {
  assert.equal(universe.id, "gudini-photoreal");
  const planner = universePlannerBlock(universe);
  assert.match(planner, /СТИЛЬ ЗАФИКСИРОВАН/);
  assert.match(planner, /СОДЕРЖАНИЕ БУКВАЛЬНОЕ/);
  assert.match(planner, /CONTENT IS LITERAL/);
  assert.match(planner, /universeAdaptation/);
  // Формулировки стиля приходят из профиля: в коде блока не должно остаться рисовки
  assert.doesNotMatch(planner, /нарисован/i, "слово «нарисованы» было вшито в код блока");
  const block = universePromptBlock(universe);
  assert.doesNotMatch(block, /drawn in this style/, "«drawn» было вшито в код production-блока");
  // Запреты стиля в запрос кадра больше не дублируются: они уже стоят строкой в конце
  // промпта, а планировщику список запретов по-прежнему выдаётся целиком.
  assert.doesNotMatch(block, /Never drift into/, "список запретов дублировался в каждом запросе");
  assert.match(planner, /Запрещено: anime/);
  assert.doesNotMatch(block, /a street, a flat, an office/, "перечисление чужих мест подмешивалось к локации кадра");
  assert.doesNotMatch(block, /Naruto/i, "в production-промпте нет названия франшизы");
  const plan = buildFilmPlan({ character: withRefs, bible, beats: beats120(), duration: 120, cfg: cfg() });
  assert.equal(plan.universeId, "gudini-photoreal");
  assert.equal(plan.universe.hash, universe.hash);
  assert.equal(plan.bible.universeId, "gudini-photoreal");
  for (const s of plan.shots) {
    assert.match(s.prompt, /World \(the same in every shot\)/);
    assert.match(s.prompt, /No split screen, no talking to camera/);
    assert.doesNotMatch(s.prompt, /Naruto/i);
  }
  const ai = plan.beats.filter((b) => b.displayMode !== "author");
  assert.ok(ai.every((b) => b.universeAdaptation.length > 0));
});

test("Universe Lock: биты из ответа модели сохраняют universeAdaptation только для AI-битов", () => {
  const w = words(Array.from({ length: 40 }, (_, i) => `w${i}${i % 5 === 4 ? "." : ""}`).join(" "));
  const phrases = phrasesFromWords(w);
  const raw = [
    { fromPhrase: 1, toPhrase: 3, displayMode: "full_ai", visualAction: "Gudini opens the clan ledger", universeAdaptation: "the company report becomes the clan ledger" },
    { fromPhrase: 4, toPhrase: 8, displayMode: "author", universeAdaptation: "ignored for author" },
  ];
  const beats = beatsFromRaw(raw as any, phrases, 16);
  assert.equal(beats[0].universeAdaptation, "the company report becomes the clan ledger");
  assert.equal(beats[1].universeAdaptation, "");
});

test("правило одного клипа: AI-бит 9.6 с без continuityRequired → 8 с AI + остаток автору, без extension", () => {
  const beats = [beat("B1", 0, 10.8, "author"), beat("B2", 10.8, 20.4, "full_ai", { purpose: "reveal", priority: "high" }), beat("B3", 20.4, 62, "author")];
  const fixed = enforceShotBudget(beats);
  assert.deepEqual(fixed.map((b) => [b.id, b.displayMode, Math.round(b.start * 10) / 10, Math.round(b.end * 10) / 10]), [
    ["B1", "author", 0, 10.8],
    ["B2", "full_ai", 10.8, 18.8],
    ["B3", "author", 18.8, 62],
  ]);
  const plan = buildFilmPlan({ character: withRefs, bible, beats, duration: 62, cfg: cfg() });
  assert.equal(plan.shots.length, 1, "один клип, без extension");
  assert.equal(plan.shots[0].veoSeconds, 8);
  assert.equal(plan.stats.aiSeconds, 8);
  assert.equal(plan.stats.generatedSeconds, 8);
  assert.equal(plan.stats.overheadSeconds, 0);
  assert.equal(plan.stats.generationEfficiency, 1);
  assert.equal(plan.stats.chains, 0);
  assert.deepEqual(plan.timeline.map((t) => `${t.start}-${t.end} ${t.mode}`), ["0-10.8 author", "10.8-18.8 full_ai", "18.8-62 author"]);
});

test("extension только при continuityRequired: бит 12 с с непрерывным действием → 8 + 7", () => {
  const cont = { ...beat("B2", 10, 22, "full_ai", { continuityGroup: "walk" }), continuityRequired: true };
  const plan = buildFilmPlan({ character: withRefs, bible, beats: [beat("B1", 0, 10, "author"), cont, beat("B3", 22, 60, "author")], duration: 60, cfg: cfg() });
  assert.equal(plan.shots.length, 2);
  assert.equal(plan.shots[1].mode, "extend");
  assert.equal(plan.stats.aiSeconds, 12);
  assert.equal(plan.stats.generatedSeconds, 15);
  assert.equal(plan.stats.overheadSeconds, 3);
  assert.equal(plan.stats.generationEfficiency, 0.8);
});

test("эффективность генерации: короткие AI-биты дают предупреждение ниже 65%", () => {
  const beats = [beat("B1", 0, 4, "full_ai", { purpose: "hook", priority: "high" }), beat("B2", 4, 30, "author"), beat("B3", 30, 34.5, "full_ai"), beat("B4", 34.5, 60, "author")];
  const plan = buildFilmPlan({ character: withRefs, bible, beats, duration: 60, cfg: cfg() });
  assert.equal(plan.stats.generatedSeconds, 16);
  assert.equal(plan.stats.aiSeconds, 8.5);
  assert.ok(plan.stats.generationEfficiency < 0.65);
  assert.ok(plan.warnings.some((w) => /эффективность/.test(w)), plan.warnings.join(" | "));
  const good = buildFilmPlan({ character: withRefs, bible, beats: beats120(), duration: 120, cfg: cfg() });
  assert.ok(good.stats.generationEfficiency >= 0.75, String(good.stats.generationEfficiency));
  assert.ok(!good.warnings.some((w) => /эффективность/.test(w)));
});

test("разбор истории идёт без скрытых размышлений модели: тело запроса OpenRouter несёт reasoning.enabled=false", () => {
  const off = openrouterRequestBody("anthropic/claude-sonnet-5", 16000, "sys", "user", "off") as any;
  assert.deepEqual(off.reasoning, { enabled: false });
  assert.equal(off.max_tokens, 16000);
  assert.deepEqual(off.usage, { include: true });
  const auto = openrouterRequestBody("anthropic/claude-sonnet-5", 8000, "sys", "user") as any;
  assert.equal("reasoning" in auto, false, "остальные стадии не трогаем");
});

test("длинный AI-бит из ответа модели: AI только первая часть, остальное автор — без дубля одной сцены", () => {
  const w = words(Array.from({ length: 100 }, (_, i) => `w${i}${i % 5 === 4 ? "." : ""}`).join(" ")); // 20 фраз по 2 с
  const phrases = phrasesFromWords(w);
  const raw = [
    { fromPhrase: 1, toPhrase: 2, displayMode: "author" },
    { fromPhrase: 3, toPhrase: 11, displayMode: "full_ai", visualAction: "Gudini raises the banner", priority: "high", purpose: "example" }, // ~17.9 с
    { fromPhrase: 12, toPhrase: 20, displayMode: "author" },
  ];
  const beats = beatsFromRaw(raw as any, phrases, 42);
  const ai = beats.filter((b) => b.displayMode !== "author");
  assert.equal(ai.length, 1, "одна AI-сцена, а не две одинаковые");
  assert.ok(ai[0].end - ai[0].start <= MAX_AI_BEAT_SEC + 0.5);
  const tail = beats.find((b) => b.reduced && /продолжение AI-бита/.test(b.reduced));
  assert.ok(tail && tail.displayMode === "author");
  const plan = buildFilmPlan({ character: withRefs, bible, beats, duration: 42, cfg: cfg() });
  assert.equal(plan.shots.length, 1);
  assert.equal(new Set(plan.shots.map((s) => s.prompt)).size, plan.shots.length, "промпты не повторяются");
});

test("крошечный author между двумя AI-сценами: следующая сцена сдвигается встык, хвост уходит автору", () => {
  const beats = [beat("B1", 0, 8, "full_ai", { purpose: "hook", priority: "high" }), beat("B1a", 8, 9.7, "author"), beat("B2", 9.7, 17.7, "full_ai", { purpose: "example" }), beat("B3", 17.7, 40, "author")];
  const fixed = closeTinyAuthorGaps(beats);
  assert.deepEqual(fixed.map((b) => [b.id, b.displayMode, Math.round(b.start * 10) / 10, Math.round(b.end * 10) / 10]), [
    ["B1", "full_ai", 0, 8],
    ["B2", "full_ai", 8, 16],
    ["B3", "author", 16, 40],
  ]);
  const plan = buildFilmPlan({ character: withRefs, bible, beats, duration: 40, cfg: cfg() });
  assert.deepEqual(plan.timeline.map((t) => `${t.start}-${t.end} ${t.mode}`), ["0-8 full_ai", "8-16 full_ai", "16-40 author"]);
  // автор на 3 с и больше остаётся
  const keep = closeTinyAuthorGaps([beat("B1", 0, 8, "full_ai"), beat("B1a", 8, 11.2, "author"), beat("B2", 11.2, 19.2, "full_ai"), beat("B3", 19.2, 40, "author")]);
  assert.equal(keep.length, 4);
  // между двумя AI без author-бита после — хвост становится новым author-битом
  const tail = closeTinyAuthorGaps([beat("B1", 0, 8, "full_ai"), beat("B1a", 8, 9, "author"), beat("B2", 9, 17, "full_ai")]);
  assert.deepEqual(tail.map((b) => [b.displayMode, Math.round(b.start * 10) / 10, Math.round(b.end * 10) / 10]), [["full_ai", 0, 8], ["full_ai", 8, 16], ["author", 16, 17]]);
  // а развязку сдвигать нельзя: она показалась бы раньше, чем автор о ней сказал
  const climax = closeTinyAuthorGaps([beat("B1", 0, 8, "full_ai"), beat("B1a", 8, 9.7, "author"), beat("B2", 9.7, 17.7, "full_ai", { purpose: "climax", priority: "high" }), beat("B3", 17.7, 40, "author")]);
  assert.equal(climax.length, 4);
  assert.equal(climax.find((b) => b.id === "B2")?.start, 9.7);
});

test("в промпт сцены попадают только персонажи, упомянутые в её действии", () => {
  const cast: StoryBible = {
    ...bible,
    supportingCharacters: [
      { name: "Tony Stark", function: "background", appearance: "red-and-gold armor" },
      { name: "Thanos", function: "opponent", appearance: "giant purple titan with a golden gauntlet" },
      { name: "Steve Rogers / Captain America", function: "guide", appearance: "star-spangled shield" },
    ],
  };
  const b = beat("B1", 0, 8, "full_ai", { visualAction: "Tony Stark kneels on the battlefield; Gudini kneels beside him" });
  const p = shotPrompt({ character: gudini, universe, bible: cast, beats: [b], prev: null, mode: "text", aspectRatio: "9:16" });
  assert.match(p, /Characters in this shot: Tony Stark: red-and-gold armor\./);
  assert.doesNotMatch(p, /Thanos/);
  assert.doesNotMatch(p, /Captain America/);
  const porch = beat("B2", 8, 16, "full_ai", { visualAction: "An elderly Steve Rogers hands his shield to Sam Wilson" });
  const p2 = shotPrompt({ character: gudini, universe, bible: cast, beats: [porch], prev: null, mode: "text", aspectRatio: "9:16" });
  assert.match(p2, /Steve Rogers \/ Captain America/);
  assert.doesNotMatch(p2, /Thanos/);
  const none = beat("B3", 16, 24, "full_ai", { visualAction: "Gudini watches two glowing worlds collide" });
  assert.doesNotMatch(shotPrompt({ character: gudini, universe, bible: cast, beats: [none], prev: null, mode: "text", aspectRatio: "9:16" }), /Characters in this shot/);
});

test("отказ Veo по правам третьих лиц распознаётся, промпт без имён сохраняет узнаваемость", () => {
  assert.ok(isThirdPartyContentError(new Error("Vertex 400: The prompt could not be submitted due to the interests of third-party content providers. Support codes: 35561575")));
  assert.ok(!isThirdPartyContentError(new Error("Vertex 429: quota")));
  const cast = {
    supportingCharacters: [
      { name: "Tony Stark", function: "background" as const, appearance: "red-and-gold powered armor with a glowing chest reactor; faceplate up" },
      { name: "Doctor Doom / Victor von Doom", function: "opponent" as const, appearance: "tall armored figure in a green cloak and iron mask" },
    ],
  };
  const prompt = "Tony Stark kneels as Thanos crumbles. Doctor Doom watches. Characters in this shot: Tony Stark: red-and-gold armor. The Avengers and the X-Men arrive in Endgame style.";
  const out = debrandPrompt(prompt, cast);
  for (const banned of ["Tony Stark", "Thanos", "Doctor Doom", "Avengers", "X-Men", "Endgame"]) assert.ok(!out.includes(banned), `${banned} остался: ${out}`);
  assert.match(out, /red-and-gold powered armor with a glowing chest reactor/);
  assert.match(out, /giant purple titan with a golden gauntlet/);
  assert.match(out, /green cloak and iron mask/);
  assert.match(out, /the hero team/);
  assert.equal(debrandPrompt("Gudini stands on a cliff at dusk.", { supportingCharacters: [] }), "Gudini stands on a cliff at dusk.");
  const rules = debrandPrompt("his true face is only implied; wearing the golden Infinity Gauntlet", { supportingCharacters: [] });
  assert.ok(!/Infinity/.test(rules), rules);
  // Обычные английские слова замене не подлежат: раньше «stark contrast» превращался
  // в «the armored hero contrast», а «ghost» и «doom» — в чужих персонажей
  const plain = debrandPrompt("a stark concrete yard at dawn; a ghost of steam over the doom-grey roof", { supportingCharacters: [] });
  assert.equal(plain, "a stark concrete yard at dawn; a ghost of steam over the doom-grey roof");
  // Имя постоянного персонажа не обезличивается: оно связано с эталонами
  const owner = debrandPrompt("Gudini kneels beside Tony Stark", {
    supportingCharacters: [{ name: "Gudini", function: "partner", appearance: "lean man in an orange jacket" }],
  }, "Gudini");
  assert.match(owner, /Gudini kneels/);
  // Реконструкция реального события имена участников не теряет
  const news = debrandPrompt("Tony Stark speaks at the hearing", { supportingCharacters: [], reconstruction: true });
  assert.equal(news, "Tony Stark speaks at the hearing");
});
