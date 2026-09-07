import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-cache-"));
process.env.ANALYSIS_CACHE_FILE = path.join(dir, "analysis.json");

const entry = (d: string): any => ({ description: d, objects: [], environment: "", action: "", updatedAt: "now" });

test("параллельные разборы кадров не затирают записи друг друга", async () => {
  const { mergeAnalysisCache, readAnalysisCache } = await import("../lib/brollRelevance");
  // оба «прочитали» пустой кэш до запроса к зрению, дописывают в разное время
  await Promise.all([
    mergeAnalysisCache({ "seg:a:0": entry("a0"), "seg:a:1": entry("a1") }),
    new Promise<void>((r) => setTimeout(r, 5)).then(() => mergeAnalysisCache({ "seg:b:0": entry("b0") })),
  ]);
  const cache = readAnalysisCache();
  assert.deepEqual(Object.keys(cache).sort(), ["seg:a:0", "seg:a:1", "seg:b:0"]);
  // третья запись видит актуальное состояние, а не свою старую копию
  await mergeAnalysisCache({ "seg:c:0": entry("c0") });
  assert.equal(Object.keys(readAnalysisCache()).length, 4);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")));
  fs.rmSync(dir, { recursive: true, force: true });
});
