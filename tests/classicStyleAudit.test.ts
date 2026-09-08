import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  assertBudget, checkGuard, CostLimitError, ProjectCostLimitError, priorProjectCost,
  priorProjectCostBreakdown, recordFlat, releaseBudget, reserveBudget,
  resetLedger, setPriorProjectCost, setRunCostLimit, summarize,
} from "../lib/costLedger";

const envKeys = ["MEDIA_JOB_HARD_LIMIT", "MEDIA_JOB_MAX_COST_USD", "MEDIA_PROJECT_MAX_COST_USD", "MEDIA_FILM_MAX_COST_USD"] as const;
function budgets(run: () => void) {
  const saved = envKeys.map((key) => process.env[key]);
  process.env.MEDIA_JOB_HARD_LIMIT = "1";
  process.env.MEDIA_JOB_MAX_COST_USD = "2";
  process.env.MEDIA_PROJECT_MAX_COST_USD = "6";
  process.env.MEDIA_FILM_MAX_COST_USD = "12";
  resetLedger();
  setPriorProjectCost(0);
  try { run(); } finally {
    resetLedger();
    setPriorProjectCost(0);
    envKeys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]);
  }
}

test("после Veo за $7.20 карточки и общая подготовка запускаются с прежним бюджетом", () => budgets(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-classic-budget-"));
  try {
    fs.mkdirSync(path.join(dir, "cost-runs"));
    const history = { summary: { totals: { variableApiCost: 8.2 } }, entries: [
      { stage: "AI Film Generation", estimatedCost: 7.2 },
      { stage: "Speech Cleanup", estimatedCost: 1 },
    ] };
    fs.writeFileSync(path.join(dir, "cost-runs", "film.json"), JSON.stringify(history));
    fs.writeFileSync(path.join(dir, "pipeline-cost.json"), JSON.stringify(history));
    assert.equal(priorProjectCost(dir), 8.2, "полный расход сохранён и последний прогон не продублирован");
    const prior = priorProjectCostBreakdown(dir);
    assert.deepEqual(prior, { total: 8.2, aiFilmGeneration: 7.2 });
    setPriorProjectCost(prior);
    assert.doesNotThrow(() => assertBudget("Media Research", 0));
    assert.doesNotThrow(() => assertBudget("Speech Cleanup", 0.5));
    setRunCostLimit(12);
    assert.doesNotThrow(() => assertBudget("AI Film Generation", 4));
    assert.throws(() => assertBudget("AI Film Generation", 5), ProjectCostLimitError, "расход Veo прошлых прогонов не теряется");
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test("генерация Veo и общие стадии не занимают бюджет друг друга", () => budgets(() => {
  setRunCostLimit(12);
  recordFlat({ stage: "AI Film Generation", provider: "google", model: "veo", cost: 7.2 });
  const film = reserveBudget("AI Film Generation", 1.6);
  assert.doesNotThrow(() => assertBudget("Cover Generation", 0.1));
  recordFlat({ stage: "Speech Cleanup", provider: "anthropic", model: "claude-sonnet-5", cost: 1.5 });
  assert.throws(() => assertBudget("Media Research", 0.6), CostLimitError, "лимит карточек по-прежнему $2");
  const shared = reserveBudget("Cover QC", 0.4);
  assert.throws(() => assertBudget("Cover Generation", 0.2), CostLimitError, "параллельные общие запросы учитываются");
  assert.doesNotThrow(() => assertBudget("AI Film Generation", 3));
  assert.throws(() => assertBudget("AI Film Generation", 4), CostLimitError, "параллельные Veo запросы учитываются");
  assert.equal(summarize().totals.variableApiCost, 8.7, "отчёт по-прежнему включает обе группы расходов");
  releaseBudget(film);
  releaseBudget(shared);
}));

test("бюджет фильма не снимает накопительный предел общих стадий", () => budgets(() => {
  setPriorProjectCost({ total: 13.1, aiFilmGeneration: 7.2 });
  setRunCostLimit(12);
  assert.throws(() => assertBudget("Speech Cleanup", 0.2), ProjectCostLimitError);
  assert.doesNotThrow(() => assertBudget("AI Film Generation", 1));
  resetLedger();
  setPriorProjectCost(0);
  assert.throws(() => assertBudget("AI Film Generation", 3), CostLimitError, "разрешение на большой запуск Veo сбрасывается");
}));

test("история без распределения по стадиям остаётся в обычном накопительном бюджете", () => budgets(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-classic-legacy-"));
  try {
    fs.writeFileSync(path.join(dir, "pipeline-cost.json"), JSON.stringify({ summary: { totals: { variableApiCost: 6.5 } } }));
    const prior = priorProjectCostBreakdown(dir);
    assert.deepEqual(prior, { total: 6.5, aiFilmGeneration: 0 });
    setPriorProjectCost(prior);
    assert.throws(() => assertBudget("Media Research", 0), ProjectCostLimitError);
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test("отчёт не объявляет допустимую генерацию Veo за $7.20 превышением бюджета карточек", () => budgets(() => {
  setRunCostLimit(12);
  recordFlat({ stage: "AI Film Generation", provider: "google", model: "veo", cost: 7.2 });
  assert.deepEqual(checkGuard(), { level: "ok", cost: 7.2 });
  recordFlat({ stage: "Speech Cleanup", provider: "anthropic", model: "claude-sonnet-5", cost: 2.1 });
  assert.equal(checkGuard().level, "over");
  assert.equal(checkGuard().topStage, "Speech Cleanup");
  assert.equal(checkGuard().cost, 9.3, "полная сумма отчёта не скрывает Veo");
  resetLedger();
  setRunCostLimit(12);
  recordFlat({ stage: "AI Film Generation", provider: "google", model: "veo", cost: 12.1 });
  assert.equal(checkGuard().level, "over");
  assert.equal(checkGuard().topStage, "AI Film Generation");
}));
