import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { appendSpendRuns, dedupeSpendRuns, sameSpendRun, SpendRun } from "../lib/spendLog";

const run = (over: Partial<SpendRun>): SpendRun => ({
  runId: "p1:2026-09-07T12-43-00-100Z-done.json",
  projectId: "p1",
  topic: "тема",
  at: "2026-09-07T12:43:00.100Z",
  status: "done",
  label: "Монтаж",
  total: 0.58,
  byProvider: { anthropic: 0.32, openrouter: 0.07, brave: 0.18 },
  ...over,
});

test("копия леджера и pipeline-cost.json с разницей в миллисекунды — один прогон", () => {
  const a = run({});
  const b = run({ runId: "p1:pipeline-cost@2026-09-07T12:43:00.087Z", at: "2026-09-07T12:43:00.087Z" });
  assert.equal(sameSpendRun(a, b), true);
  assert.equal(dedupeSpendRuns([a, b]).length, 1);
});

test("разные прогоны (другая сумма, другой статус, другое время) не сливаются", () => {
  const a = run({});
  assert.equal(sameSpendRun(a, run({ runId: "x", total: 0.39 })), false);
  assert.equal(sameSpendRun(a, run({ runId: "x", status: "failed" })), false);
  assert.equal(sameSpendRun(a, run({ runId: "x", at: "2026-09-07T12:45:00.000Z" })), false);
});

test("журнал чистится от старых дублей при следующей записи", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-spend-"));
  const file = path.join(dir, "spend-log.json");
  const a = run({});
  const dup = run({ runId: "p1:pipeline-cost@2026-09-07T12:43:00.087Z", at: "2026-09-07T12:43:00.087Z" });
  fs.writeFileSync(file, JSON.stringify({ runs: [a, dup] }), "utf8");
  const r = appendSpendRuns([run({ runId: "p2", projectId: "p2", at: "2026-09-07T13:00:00.000Z" })], file);
  assert.equal(r.added, 1);
  assert.equal(r.total, 2);
  const stored = JSON.parse(fs.readFileSync(file, "utf8")).runs;
  assert.equal(stored.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
