import test from "node:test";
import assert from "node:assert/strict";
import { captureHealth, FRAME_STALL_MS } from "../lib/portraitCapture";

test("холст рисует, а кадров камеры нет — это зависание, а не исправность", () => {
  const now = 10_000;
  const h = captureHealth(now, { lastCameraFrameAt: now - FRAME_STALL_MS - 1, lastTickAt: now - 16, useVideoFrames: false });
  assert.equal(h.stalled, true);
  assert.equal(h.switchToRaf, false);
});

test("кадры камеры идут — зависания нет", () => {
  const now = 10_000;
  const h = captureHealth(now, { lastCameraFrameAt: now - 40, lastTickAt: now - 16, useVideoFrames: true });
  assert.equal(h.stalled, false);
  assert.equal(h.switchToRaf, false);
});

test("rVFC замолчал, но до порога зависания далеко — цикл переводится на requestAnimationFrame", () => {
  const now = 10_000;
  const h = captureHealth(now, { lastCameraFrameAt: now - 300, lastTickAt: now - 300, useVideoFrames: true });
  assert.equal(h.switchToRaf, true);
  assert.equal(h.stalled, false);
  assert.equal(captureHealth(now, { lastCameraFrameAt: now - 300, lastTickAt: now - 300, useVideoFrames: false }).switchToRaf, false);
});
