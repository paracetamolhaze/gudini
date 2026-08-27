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

test("EditPlan: валидный B_ROLL проходит, длительность клампится в [1.8, 5]", () => {
  const events = validatePlan(
    [{ type: "B_ROLL", from: 10, to: 11, query: "tiger city" }],
    words,
    duration,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "B_ROLL");
  assert.ok(events[0].end - events[0].start >= 1.8 - 0.01);
  const long = validatePlan([{ type: "B_ROLL", from: 10, to: 60, query: "x" }], words, duration);
  assert.ok(long[0].end - long[0].start <= 5.0 + 0.01);
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

test("EditPlan: лимит количества перебивок (<=14)", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({
    type: "B_ROLL",
    from: 5 + i * 9,
    to: 8 + i * 9,
    query: `q${i}`,
  }));
  const events = validatePlan(many as any, makeWords(300), 120);
  assert.ok(events.filter((e) => e.type === "B_ROLL").length <= 14);
});

test("EditPlan: visualIntent парсится и клампится", () => {
  const events = validatePlan(
    [
      {
        type: "B_ROLL",
        from: 10,
        to: 14,
        query: "tiger",
        intent: { subject: "tiger", action: "walking", environment: "city", mood: "tense", mustHave: ["tiger"], avoid: ["zoo"] },
      },
    ],
    words,
    duration,
  );
  assert.equal(events[0].visualIntent?.subject, "tiger");
  assert.deepEqual(events[0].visualIntent?.avoid, ["zoo"]);
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
