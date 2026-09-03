import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "../lib/concurrency";
import { planWindows, SEGMENT_WINDOW } from "../lib/storyAssetPack";

test("mapLimit: не больше limit одновременно, результаты в порядке входа", async () => {
  let active = 0;
  let peak = 0;
  const items = [30, 5, 20, 1, 15, 10];
  const out = await mapLimit(items, 3, async (ms, i) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, ms));
    active--;
    return `${i}:${ms}`;
  });
  assert.deepEqual(out, items.map((ms, i) => `${i}:${ms}`));
  assert.ok(peak <= 3 && peak >= 2, `одновременно ${peak}`);
});

test("planWindows: та же формула, что была у cutSegments — индексы кэша зрения не сдвигаются", () => {
  // раньше: samples = min(wanted, max(3, floor(duration/8))); at = ((i+0.5)/samples)*(duration-WINDOW)
  for (const [duration, wanted] of [
    [75, 8],
    [49, 8],
    [249, 4],
    [598, 4],
    [20, 8],
  ]) {
    const { samples, windows } = planWindows(duration, wanted);
    assert.equal(samples, Math.min(wanted, Math.max(3, Math.floor(duration / 8))));
    windows.forEach((w, i) => {
      assert.equal(w.index, i);
      assert.ok(Math.abs(w.at - ((i + 0.5) / samples) * Math.max(0, duration - SEGMENT_WINDOW)) < 1e-9);
      assert.ok(w.at + SEGMENT_WINDOW <= duration, "окно не выходит за конец ролика");
    });
  }
});
