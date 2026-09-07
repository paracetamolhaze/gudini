import test from "node:test";
import assert from "node:assert/strict";
import { canRedeliver } from "../lib/deliveryMarker";

const marker = { at: "2026-09-07T10:00:00Z", rawFingerprint: "abc", scriptHash: "s1", project: {} };

test("готовый ролик досылается, если исходник и сценарий те же", () => {
  assert.equal(canRedeliver(marker, { rawFingerprint: "abc", scriptHash: "s1" }), true);
});

test("новый исходник или сценарий — монтаж заново, а не досылка", () => {
  assert.equal(canRedeliver(marker, { rawFingerprint: "zzz", scriptHash: "s1" }), false);
  assert.equal(canRedeliver(marker, { rawFingerprint: "abc", scriptHash: "s2" }), false);
  assert.equal(canRedeliver(null, { rawFingerprint: "abc", scriptHash: "s1" }), false);
  assert.equal(canRedeliver({ ...marker, rawFingerprint: "" }, { rawFingerprint: "", scriptHash: "s1" }), false);
});
