import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { coverSpeechCuts, validatePlan } from "../lib/editPlan";
import type { EditEvent } from "../lib/editPlan";
import { remapWordsWithIndex } from "../lib/speechCleanupPlan";
import { Word } from "../lib/transcribe";

const words: Word[] = Array.from({ length: 200 }, (_, i) => ({
  word: `слово${i}`,
  start: i * 0.4,
  end: i * 0.4 + 0.33,
}));

test("1: звук перебивок никогда не попадает в ролик", () => {
  const pipeline = fs.readFileSync("lib/pipeline.ts", "utf8");
  const render = pipeline.slice(pipeline.indexOf("async function renderPlan"), pipeline.indexOf("async function selfCheck"));

  // блок подключения перебивок: только видеопоток, ни одной аудиодорожки
  const brollBlock = render.slice(render.indexOf("brolls.forEach"), render.indexOf("const audioChain"));
  assert.ok(brollBlock.includes(":v]"), "перебивка подключается как видео");
  assert.ok(!brollBlock.includes(":a]"), "звук перебивки не подключается вообще");

  // голос — из исходника; вторая аудиодорожка допустима только для фоновой музыки
  assert.ok(render.includes("[0:a]loudnorm"), "голос автора берётся из исходника");
  const audio = render.slice(render.indexOf("const audioChain"), render.indexOf("await runFfmpeg"));
  const audioRefs = [...audio.matchAll(/\[(\d+):a\]/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(audioRefs)].sort(), ["0", "1"], "только голос и музыка");
  assert.ok(audio.includes("[1:a]volume"), "вторая дорожка — это музыка");

  // внешнее видео перекодируется без звука ещё до попадания в монтаж
  const entity = fs.readFileSync("lib/brollEntity.ts", "utf8");
  assert.ok(entity.includes('"-an"'), "внешнее видео перекодируется без аудио");
});

test("2: перебивка растягивается, чтобы закрыть склейку речи", () => {
  const events: EditEvent[] = [
    { type: "B_ROLL", start: 10.6, end: 13.0 }, // начинается вскоре ПОСЛЕ склейки
    { type: "B_ROLL", start: 24.0, end: 26.5 }, // заканчивается ДО склейки
  ];
  const covered = coverSpeechCuts(events, [10.0, 27.4], 60);
  assert.ok(covered[0].start <= 9.7 + 0.01, `начало не сдвинулось: ${covered[0].start}`);
  assert.ok(covered[0].start < 10.0, "перебивка стартует раньше склейки");
  assert.ok(covered[1].end >= 27.7 - 0.01, `конец не сдвинулся: ${covered[1].end}`);

  // уже закрытую склейку не трогаем, далёкую — тоже
  const untouched: EditEvent[] = [{ type: "B_ROLL", start: 5, end: 9 }];
  const same = coverSpeechCuts(untouched, [7, 40], 60);
  assert.equal(same[0].start, 5);
  assert.equal(same[0].end, 9);
});

test("3: второй проход чистки видит уже почищенную речь и знает исходные индексы", () => {
  // вырезали слова 10–14 из исходника
  const segments = [
    { start: 0, end: 4.0 },
    { start: 6.0, end: 20.0 },
  ];
  const { words: clean, srcIndex } = remapWordsWithIndex(words, segments);
  assert.ok(clean.length < words.length, "часть слов удалена");
  // таймкоды пересчитаны на чистый таймлайн
  assert.ok(clean[clean.length - 1].end <= 18.1, "таймлайн стал короче");
  // индексы позволяют вернуться к исходным словам для второй вырезки
  const i = Math.floor(clean.length / 2);
  assert.equal(clean[i].word, words[srcIndex[i]].word, "слово соответствует исходному индексу");
  assert.ok(srcIndex.every((v, k) => k === 0 || v > srcIndex[k - 1]), "индексы монотонны");
});

test("4: единственный переход — hard cut, никаких эффектов", () => {
  const pipeline = fs.readFileSync("lib/pipeline.ts", "utf8");
  const chain = pipeline.slice(pipeline.indexOf("async function renderPlan"), pipeline.indexOf("async function selfCheck"));
  for (const effect of ["xfade", "fade=", "dissolve", "wipe", "zoompan", "smartblur"]) {
    assert.ok(!chain.includes(effect), `в видеоцепочке найден эффект: ${effect}`);
  }
  assert.ok(/overlay=[^;]*eof_action=pass/.test(chain), "вставка просто перекрывает часть кадра, без перехода");
  assert.ok(chain.includes("insetScaleFilter"), "вставка вписывается в верхнюю область, а не растягивается");
  // аудио-микрофейды на склейках речи остаются — это только звук
  const source = pipeline.slice(pipeline.indexOf("async function buildCleanSource"));
  assert.ok(source.includes("afade=t=in:d=0.015"), "микрофейд 15мс на стыках аудио");
});

test("5: длительности вставок укладываются в 1.5–5.0 сек, лимит 18", () => {
  const raw = Array.from({ length: 20 }, (_, i) => ({
    type: "B_ROLL",
    from: 10 + i * 8,
    to: 10 + i * 8 + 2,
    query: `q${i}`,
    sourceIntent: "GENERIC_STOCK",
  }));
  const events = validatePlan(raw as any, words, 80);
  assert.ok(events.length > 8, `слишком мало вставок: ${events.length}`);
  assert.ok(events.length <= 18, `превышен лимит: ${events.length}`);
  for (const e of events) {
    const d = e.end - e.start;
    assert.ok(d >= 1.4 && d <= 5.05, `длительность вне диапазона: ${d.toFixed(2)}с`);
  }
});
