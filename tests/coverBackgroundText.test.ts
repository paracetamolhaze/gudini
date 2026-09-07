import test from "node:test";
import assert from "node:assert/strict";
import { evaluateQc } from "../lib/coverQc";

const HEADLINE = "БИЛЕТЫ РАСКУПИЛИ";
const base = { readableText: ["БИЛЕТЫ", "РАСКУПИЛИ"], headlineMatch: true, extraText: [], textReadable: true, identityOk: true, anatomyOk: true, visualArtifacts: [], confidence: 0.9 };

test("мелкие осмысленные надписи на фоне — PASS без замечания об ошибке", () => {
  const r = evaluateQc({ ...base, backgroundText: [{ text: "CINEMA", sensible: true }, { text: "IMAX", sensible: true }] }, HEADLINE);
  assert.equal(r.status, "PASS");
  assert.deepEqual(r.backgroundText, ["CINEMA", "IMAX"]);
  assert.match(String(r.warnings?.[0]), /допустимо/);
});

test("бессмысленные буквы на далёкой вывеске — PASS с замечанием, не отказ", () => {
  const r = evaluateQc({ ...base, backgroundText: [{ text: "OOR REATTLET", sensible: false }] }, HEADLINE);
  assert.equal(r.status, "PASS");
  assert.match(String(r.warnings?.[0]), /бессмысленные буквы/);
});

test("фоновые слова, попавшие и в readableText, не считаются лишним текстом", () => {
  const r = evaluateQc({ ...base, readableText: ["CINEMA", "БИЛЕТЫ", "РАСКУПИЛИ"], backgroundText: [{ text: "CINEMA", sensible: true }] }, HEADLINE);
  assert.equal(r.status, "PASS");
});

test("заметный лишний текст по-прежнему отклоняется", () => {
  const r = evaluateQc({ ...base, extraText: ["SOLD OUT"] }, HEADLINE);
  assert.equal(r.status, "EXTRA_TEXT");
  assert.match(r.reasons[0], /лишний текст/); // слова нормализуются в кириллические двойники (SОLD ОUТ)
});
