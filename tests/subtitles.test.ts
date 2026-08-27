import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAss, dropDuplicateCallouts, displayWord } from "../lib/subtitles";
import { Word } from "../lib/transcribe";
import type { EditEvent } from "../lib/editPlan";

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

test("Test 1: одно слово на экране, события никогда не пересекаются", () => {
  // слова впритык друг к другу — худший случай для наложений
  const words: Word[] = Array.from({ length: 60 }, (_, i) => ({
    word: `слово${i}`,
    start: i * 0.3,
    end: i * 0.3 + 0.29,
  }));
  const events = parseDialogues(buildAss(words));
  assert.equal(events.length, words.length, "каждое слово — отдельное событие");
  for (const e of events) {
    assert.equal(e.text.split(/\s+/).length, 1, `на экране больше одного слова: «${e.text}»`);
  }
  for (let i = 1; i < events.length; i++) {
    assert.ok(
      events[i - 1].end <= events[i].start + 0.001,
      `пересечение: ${events[i - 1].end} > ${events[i].start}`,
    );
  }
});

test("Test 1b: субтитры только белые — никаких жёлтых акцентов", () => {
  const words = makeWords([
    ["рука", 0, 0.4],
    ["в", 0.45, 0.6],
    ["гипсе", 0.65, 1.2],
    ["5000", 1.3, 1.8],
  ]);
  const ass = buildAss(words);
  assert.ok(!ass.includes("\\c&H00D7FF&"), "жёлтый остался только для обложек");
  assert.ok(!ass.includes("\\c&H"), "цветовых переопределений в субтитрах быть не должно");
});

test("Test 2: смысловая пунктуация сохраняется — 1/8 не превращается в 18", () => {
  const words = makeWords([
    ["мира", 0, 0.4],
    ["1/8", 0.45, 0.9],
    ["финала,", 0.95, 1.4],
  ]);
  const events = parseDialogues(buildAss(words));
  assert.deepEqual(events.map((e) => e.text), ["МИРА", "1/8", "ФИНАЛА"]);
  // остальные смысловые записи тоже целы, а висячая пунктуация убрана
  assert.equal(displayWord("$5000"), "$5000");
  assert.equal(displayWord("50%"), "50%");
  assert.equal(displayWord("2:0"), "2:0");
  assert.equal(displayWord("2025/26."), "2025/26");
  assert.equal(displayWord("привет,"), "ПРИВЕТ");
  assert.equal(displayWord("кто-то!"), "КТО-ТО");
});

test("Test 3: каллаут, повторяющий речь, не рендерится", () => {
  const words = makeWords([
    ["рука", 53.9, 54.3],
    ["в", 54.35, 54.5],
    ["гипсе", 54.55, 55.1],
  ]);
  const events: EditEvent[] = [
    { type: "TEXT_CALLOUT", start: 53.8, end: 54.8, text: "РУКА В ГИПСЕ" },
    { type: "TEXT_CALLOUT", start: 53.8, end: 54.8, text: "$5000" },
  ];
  const kept = dropDuplicateCallouts(events, words);
  assert.equal(kept.length, 1, "дубликат речи убран, полезная цифра осталась");
  assert.equal(kept[0].text, "$5000");
});
