import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { selectTakes, splitSentences } from "../lib/takeSelection";
import { planCleanupCuts } from "../lib/speechCleanupRun";
import { segmentsFromCuts, remapWords } from "../lib/speechCleanupPlan";
import type { Word } from "../lib/transcribe";

function speak(chunks: string[], gap = 0.4): Word[] {
  const out: Word[] = [];
  let t = 0.5;
  for (const chunk of chunks) {
    for (const w of chunk.split(/\s+/).filter(Boolean)) {
      out.push({ word: w, start: t, end: t + 0.3 });
      t += 0.4;
    }
    t += gap;
  }
  return out;
}

test("TakeSelection: из нескольких прочтений предложения остаётся лучшее, остальные — в вырезку", () => {
  const script = "Это первый футболист в мире, который сломал руку. Чемпионат мира, Англия играет с Мексикой. В запасе сидит Джордан Хендерсон.";
  const words = speak([
    "это первый футболист в ми-- э-э-э", // обрыв первого предложения
    "это первый футболист в мире который сломал руку", // нормальное прочтение
    "чемпионат мира англия играет с мексикой",
    "в запасе сидит джордан", // недочитал
    "в запасе сидит джордан хендерсон", // нормальное
    "и на этом всё", // импровизация — не трогаем
  ]);
  const sel = selectTakes(script, words);
  assert.equal(sel.sentences.length, 3);
  assert.equal(sel.coverage, 1, "у каждого предложения найдено прочтение");
  assert.equal(sel.dropped.length, 2, `отброшено два неудачных прочтения: ${JSON.stringify(sel.dropped)}`);
  const droppedText = sel.dropped.map((d) => words.slice(d.from, d.to + 1).map((w) => w.word).join(" "));
  assert.ok(droppedText[0].startsWith("это первый футболист в ми--"), droppedText[0]);
  assert.ok(droppedText[1].startsWith("в запасе сидит джордан") && !droppedText[1].includes("хендерсон"), droppedText[1]);
  // выбранные прочтения — полные
  for (const k of sel.kept) assert.ok(k && k.coverage >= 0.8, "оставлено полное прочтение");
  // импровизация в конце не попала ни в одно отброшенное прочтение
  const lastIdx = words.length - 1;
  assert.ok(!sel.dropped.some((d) => d.to >= lastIdx - 3), "импровизация не вырезана");
  assert.equal(sel.actions.length, 2);
  assert.equal(sel.actions[0].reason, "RETAKE");
});

test("TakeSelection: без сценария ничего не режется", () => {
  const sel = selectTakes(null, speak(["раз два три"]));
  assert.equal(sel.dropped.length, 0);
  assert.equal(sel.actions.length, 0);
});

test("TakeSelection: запись Хендерсона — три известных дубля найдены, остальное цело", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "henderson-takes.json"), "utf8"));
  const words: Word[] = fx.words;
  const sel = selectTakes(fx.script, words);
  assert.ok(sel.sentences.length >= 12, `предложений ${sel.sentences.length}`);
  assert.ok(sel.coverage >= 0.85, `покрытие ${(sel.coverage * 100).toFixed(0)}%`);
  const spans = sel.dropped.map((d) => [words[d.from].start, words[d.to].end] as const);
  const has = (a: number, b: number) => spans.some(([s, e]) => s <= a + 1 && e >= b - 1);
  assert.ok(has(34.8, 37.7), `дубль «Хендерсон на радостях … эк-- э-э-э» (34.8–37.7): ${JSON.stringify(spans)}`);
  assert.ok(has(50.4, 53.6), `дубль «Тренер подтвердил, что всё серьёзно» (50.4–53.6): ${JSON.stringify(spans)}`);
  assert.ok(has(58.0, 62.6), `дубль «Человек ни разу не коснулся мяча…» (58.0–62.6): ${JSON.stringify(spans)}`);
  const droppedSec = sel.dropped.reduce((n, d) => n + (words[d.to].end - words[d.from].start), 0);
  assert.ok(droppedSec < 16, `вырезано ${droppedSec.toFixed(1)}с — больше похоже на ложные дубли`);
  const drop = new Set<number>();
  for (const d of sel.dropped) for (let i = d.from; i <= d.to; i++) drop.add(i);
  const text = words.filter((_, i) => !drop.has(i)).map((w) => w.word.toLowerCase()).join(" ");
  assert.ok(text.includes("с болельщиками"), "короткая импровизация «с болельщиками» осталась");
  assert.ok(text.includes("достаточно опытный футболист"), "импровизация «достаточно опытный футболист» осталась");
});

test("TakeSelection: предложения сценария режутся по знакам и абзацам", () => {
  const s = splitSentences("Раз два три. Четыре пять!\n\nШесть семь восемь? Девять.");
  assert.deepEqual(s, ["Раз два три.", "Четыре пять!", "Шесть семь восемь?"]);
});

test("TakeSelection: в общем пути чистки дубли режутся без предела в 15 секунд, даже без модели", async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "henderson-takes.json"), "utf8"));
  const words: Word[] = fx.words;
  const duration = words[words.length - 1].end + 1;
  const run = await planCleanupCuts({
    script: fx.script,
    words,
    silences: [],
    edges: { start: 0, end: duration },
    duration,
    planner: async () => null, // модели нет — работают только детерминированные шаги
  });
  assert.equal(run.llmUsed, false);
  assert.ok(run.takes.dropped >= 3, `дублей вырезано ${run.takes.dropped}`);
  assert.ok(run.takes.seconds > 8 && run.takes.seconds < 16, `вырезано ${run.takes.seconds.toFixed(1)}с`);
  const kept = remapWords(words, segmentsFromCuts({ start: 0, end: duration }, run.cuts));
  const text = kept.map((w) => w.word.toLowerCase()).join(" ");
  assert.ok(!text.includes("эк--") && !text.includes("под--"), "обрывы вырезаны без модели");
  assert.ok(text.includes("человек ни разу не коснулся мяча"), "оставленное прочтение цело");
  assert.equal((text.match(/тренер подтвердил/g) ?? []).length, 1, "«тренер подтвердил» звучит один раз");
});

test("TakeSelection: запись «Мстителей» (3:41, многократные перечитывания) собирается по сценарию", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "avengers-takes.json"), "utf8"));
  const words: Word[] = fx.words;
  const sel = selectTakes(fx.script, words);
  assert.equal(sel.sentences.length, 25);
  assert.equal(sel.coverage, 1, "все 25 предложений найдены");
  const spans = sel.dropped.map((d) => [words[d.from].start, words[d.to].end] as const);
  const covers = (a: number, b: number) => spans.some(([s, e]) => s <= a + 0.6 && e >= b - 0.6);
  assert.ok(covers(14.7, 17.3), "первая попытка «Последний раз… фини--»");
  assert.ok(covers(38.4, 44.2), "первая попытка «Наташа пожертвовала…»");
  assert.ok(covers(59.4, 73.0), "перечитанный абзац и разговор с монтажёром («Заново… Сорри, нарежешь»)");
  assert.ok(covers(114.2, 121.8), "«Первый — основная вселенная» дважды плюс «мурашки идут»");
  assert.ok(covers(151.7, 159.0), "первая попытка «Судя по трейлеру…»");
  assert.ok(covers(189.0, 199.5), "перечитывания середины «которым придётся сражаться…»");
  const droppedSec = sel.dropped.reduce((n, d) => n + (words[d.to].end - words[d.from].start), 0);
  const left = words[words.length - 1].end - droppedSec;
  assert.ok(left < 150, `после сборки остаётся ${left.toFixed(1)}с речи с паузами`);
  // что остаётся
  const drop = new Set<number>();
  for (const d of sel.dropped) for (let i = d.from; i <= d.to; i++) drop.add(i);
  const text = words.filter((_, i) => !drop.has(i)).map((w) => w.word.toLowerCase()).join(" ");
  assert.ok(!/заново|сорри|нарежешь|блядь/.test(text), "разговор с монтажёром вырезан");
  assert.ok(!text.includes("натали портман") && !text.includes("мурашки идут. как хочу"), "болтовня между дублями вырезана");
  assert.ok(text.includes("после щелчка таноса"), "импровизация рядом с болтовнёй осталась");
  assert.ok(text.includes("если честно"), "заключительная импровизация для зрителя осталась");
  assert.equal((text.match(/новыми мстителями/g) ?? []).length, 1, "«Новыми Мстителями» звучит один раз");
  assert.equal((text.match(/спасавшего эту вселенную/g) ?? []).length, 1, "конец длинного предложения звучит один раз");
  assert.equal((text.match(/пришла из мультивселенной/g) ?? []).length, 1, "«пришла из мультивселенной» один раз");
});

test("TakeSelection: «сначала»/«ладно» вырезают только короткую реплику, а не длинную импровизацию", () => {
  const script = "Сначала герой работал врачом. Потом он потерял всё в аварии.";
  // фраза из сценария начинается со слова-маркера — остаётся
  const a = selectTakes(script, speak(["сначала герой работал врачом", "потом он потерял всё в аварии"]));
  assert.equal(a.coverage, 1);
  assert.deepEqual(a.dropped, []);
  // короткая реплика оператору перед сценарием — вырезается
  const b = selectTakes(script, speak(["ладно сначала", "сначала герой работал врачом", "потом он потерял всё в аварии"]));
  assert.equal(b.dropped.length, 1, JSON.stringify(b.dropped));
  assert.equal(b.dropped[0].reason, "CHATTER");
  assert.equal(b.dropped[0].from, 0, "реплика «ладно» вырезана с первого слова");
  assert.ok(b.kept[0] && b.kept[0].to === 5, "прочтение первого предложения дочитано до «врачом»");
  // длинная импровизация со словом «ок» внутри — не болтовня, остаётся
  const c = selectTakes(
    script,
    speak(["сначала герой работал врачом", "потом он потерял всё в аварии", "и вот тут ок самое интересное начинается потому что дальше он встречает древнего мага"]),
  );
  assert.deepEqual(c.dropped, [], JSON.stringify(c.dropped));
  // слово монтажёру («заново») режет и длинный кусок
  const d = selectTakes(
    script,
    speak(["сначала герой работал врачом", "так давай это всё заново потому что я запнулся и не то сказал в середине фразы", "сначала герой работал врачом", "потом он потерял всё в аварии"]),
  );
  // болтовня сливается с вырезкой первого прочтения в один участок — важно, что слова 4..19 вырезаны
  const dWords = speak(["сначала герой работал врачом", "так давай это всё заново потому что я запнулся и не то сказал в середине фразы"]);
  const chatterFrom = 4;
  const chatterTo = dWords.length - 1;
  assert.ok(d.dropped.some((x) => x.from <= chatterFrom && x.to >= chatterTo), JSON.stringify(d.dropped));
});
