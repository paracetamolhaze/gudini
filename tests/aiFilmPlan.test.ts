import test from "node:test";
import assert from "node:assert/strict";
import { sentencesFromWords, episodesFromRaw } from "../lib/aiFilm/story";
import { buildFilmPlan, groupSequences, scenePrompt, sceneKey, contiguousEpisodes } from "../lib/aiFilm/plan";
import type { FilmEpisode, StoryBible } from "../lib/aiFilm/types";

const words = (text: string, secPerWord = 0.4) =>
  text.split(/\s+/).map((w, i) => ({ word: w, start: i * secPerWord, end: i * secPerWord + 0.3 }));

const bible: StoryBible = {
  visualStyle: "cinematic 35mm",
  mainCharacter: { description: "a young courier", appearance: "short dark hair", clothes: "red jacket", signature: "red jacket, silver ring" },
  locations: ["night city"],
  importantObjects: ["bicycle"],
  mood: "tense",
  cameraLanguage: "handheld",
  storyArc: "courier races through the city",
  continuityRules: ["same red jacket", "always night"],
};

const ep = (id: string, start: number, end: number, transition: FilmEpisode["transition"] = "continue"): FilmEpisode => ({
  id, start, end, meaning: `смысл ${id}`, visualAction: `action ${id}`, location: "city", stateAfter: `state ${id}`, transition,
});

test("предложения режутся по знакам конца и длинным паузам", () => {
  const w = words("Первое предложение здесь. Второе идёт дальше и дальше. Третье");
  const s = sentencesFromWords(w);
  assert.equal(s.length, 3);
  assert.equal(s[0].text, "Первое предложение здесь.");
  assert.equal(s[2].start, w[8].start);
});

test("эпизоды из ответа модели: пропуски и пересечения чинятся, длинные режутся, короткие сливаются", () => {
  const w = words(Array.from({ length: 60 }, (_, i) => `w${i}${i % 6 === 5 ? "." : ""}`).join(" ")); // 10 предложений по 2.4 с
  const s = sentencesFromWords(w);
  assert.equal(s.length, 10);
  const raw = [
    { fromSentence: 1, toSentence: 1, meaning: "a", visualAction: "A", location: "", stateAfter: "", transition: "continue" }, // короткий
    { fromSentence: 3, toSentence: 4, meaning: "b", visualAction: "B", location: "", stateAfter: "", transition: "match_cut" }, // пропуск 2 → растянется
    { fromSentence: 4, toSentence: 10, meaning: "c", visualAction: "C", location: "", stateAfter: "", transition: "new_sequence" }, // пересечение и длинный
  ];
  const eps = episodesFromRaw(raw as any, s);
  assert.ok(eps.length >= 3);
  assert.equal(eps[0].start, s[0].start);
  assert.equal(eps[eps.length - 1].end, s[9].end);
  for (let i = 1; i < eps.length; i++) assert.ok(eps[i].start >= eps[i - 1].end - 1e-6, "эпизоды идут без пересечений");
  for (const e of eps) assert.ok(e.end - e.start <= 12.5, `эпизод ${e.id} не длиннее 12 с: ${(e.end - e.start).toFixed(1)}`);
  assert.ok(eps.every((e) => e.end - e.start >= 2), "коротких эпизодов нет");
});

test("последовательности: разрыв на new_sequence и по пределу длины", () => {
  const eps = [ep("E1", 0, 8), ep("E2", 8, 16, "new_sequence"), ep("E3", 16, 24), ep("E4", 24, 40)];
  const g = groupSequences(eps, 148);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].episodes.map((e) => e.id), ["E1", "E2"]);
  assert.equal(g[1].byLimit, false);
  const tight = groupSequences([ep("E1", 0, 8), ep("E2", 8, 20), ep("E3", 20, 30)], 15);
  assert.equal(tight.length, 3);
  assert.equal(tight[1].byLimit, true);
});

test("план: первая сцена 8 с, продолжения по 7 с, фильм не короче речи, цена по секундам", () => {
  const eps = [ep("E1", 0, 9), ep("E2", 9, 20), ep("E3", 20, 31, "new_sequence"), ep("E4", 31, 44)];
  const plan = buildFilmPlan(bible, eps, 45, { key: "k", pricePerSec: 0.15, model: "veo-test" });
  assert.equal(plan.sequences.length, 2);
  const s1 = plan.sequences[0];
  assert.equal(s1.scenes[0].seconds, 8);
  assert.equal(s1.scenes[0].mode, "text");
  assert.ok(s1.scenes.slice(1).every((s) => s.seconds === 7 && s.mode === "extend"));
  assert.ok(s1.seconds >= s1.end - s1.start, "последовательность покрывает свой отрезок");
  const s2 = plan.sequences[1];
  assert.equal(s2.end, 45, "последняя тянется до конца ролика");
  assert.ok(s2.seconds >= 45 - 31);
  assert.equal(plan.totalSeconds, s1.seconds + s2.seconds);
  assert.equal(plan.estimatedCost, Math.round(plan.totalSeconds * 0.15 * 100) / 100);
  assert.equal(plan.calls, s1.scenes.length + s2.scenes.length);
  assert.equal(plan.model, "veo-test");
  // сцена получает эпизод по времени: вторая сцена первой последовательности (8–15 с) — это E2
  assert.equal(s1.scenes[1].episodeId, "E2");
});

test("разрыв только по пределу — следующая последовательность стартует с кадра (image)", () => {
  const eps = [ep("E1", 0, 10), ep("E2", 10, 20), ep("E3", 20, 30)];
  const plan = buildFilmPlan(bible, eps, 30, { key: "k", maxSequenceSeconds: 15 });
  assert.ok(plan.sequences.length >= 2);
  assert.equal(plan.sequences[1].scenes[0].mode, "image");
});

test("промпт сцены несёт стиль, героя, действие, непрерывность и запрет текста", () => {
  const p = scenePrompt(bible, ep("E2", 8, 16), ep("E1", 0, 8), "extend");
  assert.match(p, /cinematic 35mm/);
  assert.match(p, /red jacket, silver ring/);
  assert.match(p, /Continue the same shot without a cut/);
  assert.match(p, /Previous state: state E1/);
  assert.match(p, /Action: action E2/);
  assert.match(p, /No text, no captions/);
});

test("ключ сцены включает источник: правка сцены не трогает предыдущие, но пересобирает следующие", () => {
  const eps = [ep("E1", 0, 9), ep("E2", 9, 20)];
  const plan = buildFilmPlan(bible, eps, 20, { key: "k" });
  const [a, b] = plan.sequences[0].scenes;
  const ka = sceneKey(a, plan.model, null);
  const kb1 = sceneKey(b, plan.model, ka);
  const kb2 = sceneKey(b, plan.model, "other-source");
  assert.notEqual(ka, kb1);
  assert.notEqual(kb1, kb2);
  assert.equal(sceneKey(a, plan.model, null), ka);
});

test("эпизоды и последовательности встык: с нуля, без пауз между ними, до конца ролика", () => {
  const eps = [ep("E1", 0.7, 4.4), ep("E2", 4.6, 14.5, "new_sequence"), ep("E3", 15.0, 31.7), ep("E4", 31.9, 56.0)];
  const c = contiguousEpisodes(eps, 60);
  assert.equal(c[0].start, 0);
  assert.equal(c[1].start, c[0].end);
  assert.equal(c[3].end, 60);
  const plan = buildFilmPlan(bible, eps, 60, { key: "k" });
  assert.equal(plan.sequences[0].start, 0);
  for (let i = 1; i < plan.sequences.length; i++) assert.equal(plan.sequences[i].start, plan.sequences[i - 1].end);
  assert.equal(plan.sequences[plan.sequences.length - 1].end, 60);
  const covered = plan.sequences.reduce((a, s) => a + (s.end - s.start), 0);
  assert.ok(Math.abs(covered - 60) < 1e-6, "фильм покрывает ролик целиком");
});

test("фразы для модели не длиннее 5 с и 14 слов даже без знаков препинания", () => {
  const w = words(Array.from({ length: 80 }, (_, i) => `слово${i}`).join(" "), 0.4); // 32 с без единого знака
  const s = sentencesFromWords(w);
  assert.ok(s.length >= 6, `фраз ${s.length}`);
  for (const x of s) {
    assert.ok(x.end - x.start <= 5.5, `фраза ${x.index} длиной ${(x.end - x.start).toFixed(1)} с`);
    assert.ok(x.text.split(" ").length <= 14);
  }
});
