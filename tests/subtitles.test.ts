import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAss } from "../lib/subtitles";
import { Word } from "../lib/transcribe";

function parseDialogues(ass: string): { start: number; end: number; text: string }[] {
  const toSec = (t: string) => {
    const [h, m, s] = t.split(":");
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  };
  return ass
    .split("\n")
    .filter((l) => l.startsWith("Dialogue:"))
    .map((l) => {
      const parts = l.split(",");
      return { start: toSec(parts[1]), end: toSec(parts[2]), text: parts.slice(9).join(",").trim() };
    });
}

function makeWords(list: [string, number, number][]): Word[] {
  return list.map(([word, start, end]) => ({ word, start, end }));
}

test("Captions: события НИКОГДА не пересекаются (prev.end <= next.start)", () => {
  // слова с почти нулевыми зазорами — худший случай для наложений
  const words: Word[] = Array.from({ length: 60 }, (_, i) => ({
    word: `слово${i}`,
    start: i * 0.3,
    end: i * 0.3 + 0.29,
  }));
  const events = parseDialogues(buildAss(words));
  assert.ok(events.length > 5);
  for (let i = 1; i < events.length; i++) {
    assert.ok(
      events[i - 1].end <= events[i].start + 0.001,
      `пересечение: ${events[i - 1].end} > ${events[i].start}`,
    );
  }
});

test("Captions: группировка не больше maxWords слов во фразе", () => {
  const words: Word[] = Array.from({ length: 30 }, (_, i) => ({
    word: `ог${i}`,
    start: i * 0.4,
    end: i * 0.4 + 0.3,
  }));
  const events = parseDialogues(buildAss(words, { maxWords: 3 }));
  for (const e of events) {
    assert.ok(e.text.split(/\s+/).length <= 3, `слишком длинная фраза: "${e.text}"`);
  }
});

test("Captions: пауза > 0.6с разрывает фразу", () => {
  const words = makeWords([
    ["раз", 0, 0.3],
    ["два", 0.35, 0.6],
    ["пауза", 2.0, 2.4], // разрыв 1.4с
  ]);
  const events = parseDialogues(buildAss(words));
  assert.equal(events.length, 2);
});

test("Captions: конец предложения (точка/!/?) закрывает фразу", () => {
  const words = makeWords([
    ["Это", 0, 0.3],
    ["конец.", 0.35, 0.7],
    ["Новая", 0.8, 1.1],
    ["мысль", 1.15, 1.5],
  ]);
  const events = parseDialogues(buildAss(words));
  assert.equal(events.length, 2);
});

test("Highlight: подсвечиваются только слова из captionHighlights (цифры и т.п.)", () => {
  const words = makeWords([
    ["Я", 0, 0.2],
    ["потратил", 0.25, 0.7],
    ["5000", 0.75, 1.2],
    ["долларов", 1.25, 1.8],
  ]);
  const ass = buildAss(words, { maxWords: 4 }, [2]); // индекс «5000»
  const line = ass.split("\n").find((l) => l.startsWith("Dialogue:"))!;
  assert.ok(line.includes("{\\c&H00D7FF&}5000"), "должна подсветиться именно цифра");
  assert.ok(!line.includes("{\\c&H00D7FF&}ПОТРАТИЛ"), "длинное слово подсвечиваться не должно");
});

test("Highlight: без списка highlights все фразы полностью белые", () => {
  const words = makeWords([
    ["очень", 0, 0.3],
    ["длинноесловоздесь", 0.35, 1.0],
  ]);
  const ass = buildAss(words);
  assert.ok(!ass.includes("\\c&H00D7FF&"), "никаких акцентов без решения планировщика");
});

test("Captions: знаки препинания вычищены, капс, дефис внутри слова сохранён", () => {
  const words = makeWords([
    ["привет,", 0, 0.4],
    ["кто-то!", 0.5, 0.9],
  ]);
  const [e] = parseDialogues(buildAss(words));
  assert.equal(e.text, "ПРИВЕТ КТО-ТО");
});
