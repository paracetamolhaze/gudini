import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { directorPlanKey, loadDirectorPlan, saveDirectorPlan } from "../lib/montageV3Pipeline";

const research: any = { storyId: "s1", canonicalEvent: "событие", facts: [{ id: "f1" }, { id: "f2" }] };
const beats: any = [{ id: "b1", text: "первый блок", visualNeed: "CONTEXT" }, { id: "b2", text: "второй", visualNeed: "NONE" }];
const pack: any = { fingerprint: "fp1", createdAt: "2026-09-07T00:00:00Z", assets: [{ id: "a1", compatibleBeatIds: ["b1"], role: "CONTEXT" }] };
const words = [{ word: "раз", start: 0.1, end: 0.4 }, { word: "два", start: 0.5, end: 0.9 }];
const base = { research, beats, pack, words, duration: 12.34, speechCuts: [3.2] };

test("ключ плана стабилен для тех же входных данных", () => {
  assert.equal(directorPlanKey(base), directorPlanKey({ ...base, words: words.map((w) => ({ ...w })) }));
});

test("ключ меняется от слов, длительности, медиатеки и блоков", () => {
  const k = directorPlanKey(base);
  assert.notEqual(k, directorPlanKey({ ...base, words: [...words, { word: "три", start: 1, end: 1.3 }] }));
  assert.notEqual(k, directorPlanKey({ ...base, duration: 12.9 }));
  assert.notEqual(k, directorPlanKey({ ...base, pack: { ...pack, fingerprint: "fp2" } }));
  assert.notEqual(k, directorPlanKey({ ...base, beats: [beats[0]] }));
});

test("план переиспользуется только по совпавшему ключу", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-plan-"));
  const plan: any = { events: [{ assetId: "a1", start: 1, end: 3, quote: "x" }], stats: { externalCoverage: 0.3 } };
  const key = directorPlanKey(base);
  assert.equal(loadDirectorPlan(dir, key), null);
  saveDirectorPlan(dir, key, plan);
  assert.deepEqual(loadDirectorPlan(dir, key), plan);
  assert.equal(loadDirectorPlan(dir, directorPlanKey({ ...base, duration: 20 })), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
