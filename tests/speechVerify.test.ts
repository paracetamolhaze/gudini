import test from "node:test";
import assert from "node:assert/strict";
import { snapCutsToWords, leftoverLongGaps, leftoverRepeats, verifyCleanSpeech } from "../lib/speechVerify";
import { validateCleanupActions } from "../lib/speechCleanupPlan";
import type { Word } from "../lib/transcribe";

const w = (text: string, start: number, gap = 0.08, len = 0.32): Word[] => {
  const out: Word[] = [];
  let t = start;
  for (const word of text.split(/\s+/)) { out.push({ word, start: t, end: t + len }); t += len + gap; }
  return out;
};

test("граница вырезки внутри слова сдвигается к краю слова", () => {
  const words = w("привет это тест записи речи", 1);
  const inside = (words[2].start + words[2].end) / 2;
  const r = snapCutsToWords([{ start: inside, end: inside + 1.0 }], words);
  assert.equal(r.snapped, 1);
  assert.ok(r.cuts[0].start >= words[2].end - 1e-9, "начало вырезки ушло к концу слова");
});

test("длинная пауза, которую план не тронул, укорачивается", () => {
  const a = w("первая фраза целиком", 0);
  const b = w("вторая фраза после паузы", a[a.length - 1].end + 2.4);
  const extra = leftoverLongGaps([...a, ...b], []);
  assert.equal(extra.length, 1);
  assert.ok(extra[0].start > a[a.length - 1].end && extra[0].end < b[0].start);
  assert.ok(extra[0].end - extra[0].start > 1.5, "убирается больше секунды");
});

test("повтор фразы из четырёх слов: первое произнесение вырезается, последнее остаётся", () => {
  const first = w("ты сто раз слышал что", 0);
  const second = w("ты сто раз слышал что сатива бодрит", first[first.length - 1].end + 0.7);
  const words = [...first, ...second];
  const reps = leftoverRepeats(words, []);
  assert.equal(reps.length, 1);
  assert.ok(reps[0].start <= first[0].start && reps[0].end < second[0].start);
});

test("после склейки остаток проверяется: провал 2.5 с — ошибка, 1 с — норма", () => {
  const ok = [...w("раз два три четыре", 0), ...w("пять шесть семь восемь", 3)];
  assert.deepEqual(verifyCleanSpeech(ok), []);
  const bad = [...w("раз два три четыре", 0), ...w("пять шесть семь восемь", 4.2)];
  assert.match(verifyCleanSpeech(bad)[0], /пауза 2\./);
});

test("хук: неудачный первый старт фразы вырезается, если это дубль по сценарию", () => {
  // «Ты сто раз… Ты сто раз слышал: сатива бодрит» — первые три слова в первые 2 секунды
  const words = [...w("ты сто раз", 0.2), ...w("ты сто раз слышал сатива бодрит", 1.6)];
  const duration = words[words.length - 1].end + 1;
  // как в planCleanupCuts: дубли по сценарию идут без лимита на суммарную вырезку
  const retake = validateCleanupActions([{ type: "REMOVE_FRAGMENT", fromWord: 0, toWord: 2, reason: "RETAKE", confidence: 0.95 }], words, [], duration, { removedCap: Infinity });
  assert.equal(retake.cuts.length, 1, "дубль в зоне хука вырезан");
  const guess = validateCleanupActions([{ type: "REMOVE_FRAGMENT", fromWord: 0, toWord: 2, reason: "FALSE_START", confidence: 0.8 }], words, [], duration);
  assert.equal(guess.cuts.length, 0, "догадка модели в зоне хука по-прежнему не режет");
});
