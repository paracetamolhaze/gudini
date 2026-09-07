import test from "node:test";
import assert from "node:assert/strict";
import {
  resetLedger, reserveBudget, releaseBudget, withBudget, setPriorProjectCost, assertBudget,
  CostLimitError, ProjectCostLimitError, inFlightCost,
} from "../lib/costLedger";

function env(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

test("резерв: параллельные запросы не делят один и тот же остаток", () => {
  env({ MEDIA_JOB_HARD_LIMIT: "1", MEDIA_JOB_MAX_COST_USD: "1", MEDIA_PROJECT_MAX_COST_USD: "0" });
  resetLedger();
  setPriorProjectCost(0);
  const a = reserveBudget("Vision Verification", 0.6);
  assert.equal(inFlightCost(), 0.6);
  assert.throws(() => reserveBudget("Vision Verification", 0.6), CostLimitError);
  releaseBudget(a);
  assert.equal(inFlightCost(), 0);
  const b = reserveBudget("Vision Verification", 0.6);
  releaseBudget(b);
});

test("withBudget снимает резерв и при ошибке запроса", async () => {
  env({ MEDIA_JOB_HARD_LIMIT: "1", MEDIA_JOB_MAX_COST_USD: "1", MEDIA_PROJECT_MAX_COST_USD: "0" });
  resetLedger();
  await assert.rejects(withBudget("Speech Cleanup", 0.9, async () => { throw new Error("сеть"); }), /сеть/);
  assert.equal(inFlightCost(), 0);
  const ok = await withBudget("Speech Cleanup", 0.9, async () => "ответ");
  assert.equal(ok, "ответ");
});

test("предел проекта учитывает прошлые прогоны, а предел запуска — нет", () => {
  env({ MEDIA_JOB_HARD_LIMIT: "1", MEDIA_JOB_MAX_COST_USD: "2", MEDIA_PROJECT_MAX_COST_USD: "2" });
  resetLedger();
  setPriorProjectCost(1.9);
  assert.throws(() => assertBudget("Media Research", 0.2), ProjectCostLimitError);
  assert.throws(() => assertBudget("Media Research", 0.2), /прошлые прогоны 1\.90\$/);
  setPriorProjectCost(0);
  assertBudget("Media Research", 0.2);
});

test("MEDIA_PROJECT_MAX_COST_USD=0 выключает предел проекта, лимит запуска остаётся", () => {
  env({ MEDIA_JOB_HARD_LIMIT: "1", MEDIA_JOB_MAX_COST_USD: "1", MEDIA_PROJECT_MAX_COST_USD: "0" });
  resetLedger();
  setPriorProjectCost(50);
  assertBudget("Media Research", 0.5);
  assert.throws(() => assertBudget("Media Research", 1.5), CostLimitError);
  setPriorProjectCost(0);
});
