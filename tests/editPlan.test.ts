import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlan } from "../lib/editPlan";
import { Word } from "../lib/transcribe";

function makeWords(n: number, wordDur = 0.4): Word[] {
  return Array.from({ length: n }, (_, i) => ({
    word: `слово${i}`,
    start: i * wordDur,
    end: i * wordDur + wordDur * 0.85,
  }));
}

const words = makeWords(150); // ~60 сек
const duration = 60;

test("EditPlan: валидный B_ROLL проходит, длительность клампится в [2,7]", () => {
  const events = validatePlan(
    [{ type: "B_ROLL", from: 10, to: 11, query: "tiger city" }],
    words,
    duration,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "B_ROLL");
  assert.ok(events[0].end - events[0].start >= 2.0 - 0.01);
  const long = validatePlan([{ type: "B_ROLL", from: 10, to: 60, query: "x" }], words, duration);
  assert.ok(long[0].end - long[0].start <= 7.0 + 0.01);
});

test("EditPlan: неизвестный тип события отбрасывается (fallback A-roll)", () => {
  const events = validatePlan([{ type: "HOLOGRAM", from: 10, to: 12 } as any], words, duration);
  assert.equal(events.length, 0);
});

test("EditPlan: B_ROLL в зоне хука (start < 1.2с) отбрасывается", () => {
  const events = validatePlan([{ type: "B_ROLL", from: 0, to: 3, query: "x" }], words, duration);
  assert.equal(events.length, 0);
});

test("EditPlan: пересекающиеся события одной дорожки не проходят", () => {
  const events = validatePlan(
    [
      { type: "B_ROLL", from: 10, to: 16, query: "a" },
      { type: "B_ROLL", from: 14, to: 20, query: "b" },
    ],
    words,
    duration,
  );
  assert.equal(events.length, 1);
});

test("EditPlan: PUNCH_IN scale клампится в [1.03, 1.1], дефолт 1.06", () => {
  const events = validatePlan(
    [
      { type: "PUNCH_IN", from: 10, to: 16, scale: 1.5 },
      { type: "PUNCH_IN", from: 30, to: 36 },
    ],
    words,
    duration,
  );
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.scale! >= 1.03 && e.scale! <= 1.1));
});

test("EditPlan: PUNCH_IN поверх B_ROLL отбрасывается (лицо всё равно закрыто)", () => {
  const events = validatePlan(
    [
      { type: "B_ROLL", from: 10, to: 18, query: "a" },
      { type: "PUNCH_IN", from: 12, to: 16 },
    ],
    words,
    duration,
  );
  assert.equal(events.filter((e) => e.type === "PUNCH_IN").length, 0);
});

test("EditPlan: лимиты количества (B_ROLL<=8, CALLOUT<=4)", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({
    type: "B_ROLL",
    from: 5 + i * 9,
    to: 8 + i * 9,
    query: `q${i}`,
  }));
  const events = validatePlan(many as any, makeWords(300), 120);
  assert.ok(events.filter((e) => e.type === "B_ROLL").length <= 8);
});

test("EditPlan: битые данные (NaN, отрицательные, пустой query) не роняют и отбрасываются", () => {
  const events = validatePlan(
    [
      { type: "B_ROLL", from: NaN as any, to: 5, query: "x" },
      { type: "B_ROLL", from: 10, to: 12, query: "" },
      { type: "TEXT_CALLOUT", from: 20, to: 22, text: "" },
      {} as any,
    ],
    words,
    duration,
  );
  assert.equal(events.length, 0);
});
