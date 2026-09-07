import test from "node:test";
import assert from "node:assert/strict";
import { trackMismatchError } from "../lib/ingestGate";

test("видео 10 с при звуке 87 с (Safari перестал отдавать кадры) — стоп с цифрами", () => {
  const err = trackMismatchError(10, 87.05);
  assert.ok(err);
  assert.match(err!, /обрывается на 10 с, а звук идёт 87 с/);
  assert.match(err!, /Платные стадии не запускались/);
});

test("обычная разница дорожек (звук на полсекунды длиннее) проходит", () => {
  assert.equal(trackMismatchError(74.9, 75.4), null);
  assert.equal(trackMismatchError(75, 75), null);
  assert.equal(trackMismatchError(76, 75), null);
});

test("без данных о дорожках проверка молчит", () => {
  assert.equal(trackMismatchError(0, 75), null);
  assert.equal(trackMismatchError(75, 0), null);
  assert.equal(trackMismatchError(NaN, 75), null);
});
