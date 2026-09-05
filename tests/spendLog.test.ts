import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { appendSpendRuns, readSpendLog, runFromLedgerFile, sanitizeRun, setManualBalance, readManualBalances, summarizeEntries } from "../lib/spendLog";
import type { CostEntry } from "../lib/costLedger";

const entry = (over: Partial<CostEntry>): CostEntry => ({
  stage: "Creative Director",
  provider: "anthropic",
  model: "claude-sonnet-5",
  requests: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  estimatedCost: 0,
  estimated: true,
  ...over,
});

test("SpendLog: сводка по провайдерам берёт цену провайдера, а не тариф, и не считает нули", () => {
  const s = summarizeEntries([
    entry({ estimatedCost: 0.1 }),
    entry({ estimatedCost: 0.2, providerReportedCost: 0.25, provider: "openrouter", stage: "Cover Generation" }),
    entry({ estimatedCost: 0, provider: "brave", stage: "Media Research" }),
  ]);
  assert.equal(s.total, 0.35);
  assert.deepEqual(s.byProvider, { anthropic: 0.1, openrouter: 0.25 });
});

test("SpendLog: прогоны не дублируются по runId, файл сортируется по времени", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-spend-"));
  const file = path.join(dir, "spend-log.json");
  const a = { runId: "p1:a", projectId: "p1", at: "2026-09-05T10:00:00.000Z", status: "done" as const, label: "Монтаж", total: 0.3, byProvider: { anthropic: 0.3 } };
  const b = { ...a, runId: "p1:b", at: "2026-09-05T09:00:00.000Z", total: 0.1 };
  assert.deepEqual(appendSpendRuns([a], file), { added: 1, total: 1 });
  assert.deepEqual(appendSpendRuns([a, b], file), { added: 1, total: 2 });
  assert.deepEqual(
    readSpendLog(file).map((r) => r.runId),
    ["p1:b", "p1:a"],
  );
  // ручной остаток: момент ввода — точка отсчёта
  const manual = path.join(dir, "manual.json");
  const m = setManualBalance("anthropic", 0.84, manual);
  assert.equal(m.anthropic?.balance, 0.84);
  assert.ok(m.anthropic?.at && !Number.isNaN(Date.parse(m.anthropic.at)));
  assert.deepEqual(setManualBalance("anthropic", null, manual), {});
  assert.deepEqual(readManualBalances(manual), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("SpendLog: чужой прогон проверяется по полям, файл леджера даёт время из метки имени", () => {
  assert.equal(sanitizeRun({ runId: "x", at: "не дата", status: "done" }), null);
  assert.equal(sanitizeRun({ runId: "x", at: "2026-09-05T10:00:00Z", status: "weird" }), null);
  const ok = sanitizeRun({ runId: "p:1", projectId: "p", at: "2026-09-05T10:00:00Z", status: "done", total: "0.5", byProvider: { anthropic: 0.4, hacker: 9, brave: "0.1" } });
  assert.deepEqual(ok, {
    runId: "p:1",
    projectId: "p",
    topic: undefined,
    at: "2026-09-05T10:00:00.000Z",
    status: "done",
    label: "Монтаж",
    total: 0.5,
    byProvider: { anthropic: 0.4, brave: 0.1 },
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-ledger-"));
  const file = path.join(dir, "2026-09-03T21-07-34-656Z-done.json");
  fs.writeFileSync(file, JSON.stringify({ entries: [entry({ estimatedCost: 0.12 })] }), "utf8");
  const run = runFromLedgerFile(file, "proj", "done", "тема");
  assert.equal(run.at, "2026-09-03T21:07:34.656Z");
  assert.equal(run.runId, "proj:2026-09-03T21-07-34-656Z-done.json");
  assert.equal(run.total, 0.12);
  assert.equal(run.topic, "тема");
  fs.rmSync(dir, { recursive: true, force: true });
});
