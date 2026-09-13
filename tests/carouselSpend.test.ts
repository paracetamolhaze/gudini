import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { assertBudget, budgetStatus, carouselSpend, readSpend, reserveSpend, settleOrphans, settleSpend, spendRuns } from "../lib/carousel/spend";
import { CarouselError } from "../lib/carousel/store";

/** Журнал расходов раздела: резерв по оценке, факт от провайдера, неизвестный исход, бюджеты. */

function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-carousel-spend-"));
  process.env.CAROUSEL_DATA_DIR = dir;
  process.env.CAROUSEL_MONTHLY_BUDGET_USD = "1";
  process.env.CAROUSEL_MAX_COST_PER_CAROUSEL_USD = "0.5";
  return dir;
}

const base = { carouselId: "c000000000000a", title: "Тест", runLabel: "Карусель: генерация", model: "google/gemini-3.1-flash-image" } as const;
const NOW = Date.parse("2026-09-13T10:00:00Z");

test("резерв → факт: цена провайдера важнее оценки; ошибка — ноль; неизвестный исход — оценка с пометкой", () => {
  freshRoot();
  const a = reserveSpend({ ...base, kind: "image", label: "Иллюстрация слайда 1", estimate: 0.1, jobId: "j1" }, NOW);
  assert.equal(a.status, "pending");
  assert.equal(budgetStatus(NOW).monthPendingUsd, 0.1);
  settleSpend(a.id, { status: "done", cost: 0.0972 }, NOW);
  const b = reserveSpend({ ...base, kind: "image", label: "Иллюстрация слайда 2", estimate: 0.1, jobId: "j1" }, NOW);
  settleSpend(b.id, { status: "failed", cost: 0 }, NOW);
  const c = reserveSpend({ ...base, kind: "text", label: "План", estimate: 0.05, jobId: "j1" }, NOW);
  settleSpend(c.id, { status: "uncertain" }, NOW);
  const entries = readSpend();
  assert.deepEqual(
    entries.map((e) => [e.status, e.cost, e.estimated]),
    [
      ["done", 0.0972, false],
      ["failed", 0, false],
      ["uncertain", 0.05, true],
    ],
  );
  const total = carouselSpend(base.carouselId);
  assert.equal(total.usd, 0.1472);
  assert.equal(total.calls, 3);
  assert.equal(total.images, 0.0972);
  assert.equal(total.text, 0.05);
  assert.equal(total.uncertain, 1);
  assert.equal(budgetStatus(NOW).monthSpentUsd, 0.1472);
  assert.equal(budgetStatus(NOW).monthPendingUsd, 0);
  // закрыть дважды нельзя
  assert.equal(settleSpend(a.id, { status: "done", cost: 5 }), null);
});

test("бюджет: предел одной карусели и месяца считаются вместе с резервами", () => {
  freshRoot();
  const r1 = reserveSpend({ ...base, kind: "image", label: "1", estimate: 0.3 }, NOW);
  assert.throws(() => reserveSpend({ ...base, kind: "image", label: "2", estimate: 0.3 }, NOW), (e: CarouselError) => e.status === 402 && /одну карусель/.test(e.message));
  settleSpend(r1.id, { status: "done", cost: 0.3 }, NOW);
  // другая карусель проходит по своему пределу, но месячный лимит общий
  reserveSpend({ ...base, carouselId: "c000000000000b", kind: "image", label: "1", estimate: 0.4 }, NOW);
  assert.throws(() => reserveSpend({ ...base, carouselId: "c000000000000c", kind: "image", label: "1", estimate: 0.4 }, NOW), (e: CarouselError) => e.status === 402 && /Месячный бюджет/.test(e.message));
  // следующий месяц — новый бюджет
  const nextMonth = Date.parse("2026-10-02T10:00:00Z");
  assert.doesNotThrow(() => assertBudget("c000000000000c", 0.4, nextMonth));
  process.env.CAROUSEL_MONTHLY_BUDGET_USD = "0";
  assert.throws(() => assertBudget("c000000000000c", 0.01, NOW), (e: CarouselError) => /выключены/.test(e.message));
});

test("резервы умершего обработчика закрываются как неизвестный исход", () => {
  freshRoot();
  reserveSpend({ ...base, kind: "image", label: "1", estimate: 0.1 }, NOW);
  reserveSpend({ ...base, kind: "text", label: "2", estimate: 0.02 }, NOW);
  assert.equal(settleOrphans("перезапуск", NOW + 1000), 2);
  assert.ok(readSpend().every((e) => e.status === "uncertain" && e.estimated && e.note === "перезапуск"));
  assert.equal(settleOrphans("перезапуск"), 0);
});

test("строки для страницы «Расходы»: одна на задание, категория carousel, неизвестный исход помечен", () => {
  freshRoot();
  const a = reserveSpend({ ...base, kind: "text", label: "План", estimate: 0.05, jobId: "j1" }, NOW);
  settleSpend(a.id, { status: "done", cost: 0.04 }, NOW + 1000);
  const b = reserveSpend({ ...base, kind: "image", label: "Иллюстрация 1", estimate: 0.1, jobId: "j1" }, NOW + 2000);
  settleSpend(b.id, { status: "uncertain" }, NOW + 3000);
  const c = reserveSpend({ ...base, kind: "image", label: "Иллюстрация 2", estimate: 0.1, jobId: "j2", runLabel: "Карусель: иллюстрации" }, NOW + 4000);
  settleSpend(c.id, { status: "failed", cost: 0 }, NOW + 5000);
  const pending = reserveSpend({ ...base, kind: "image", label: "в работе", estimate: 0.1, jobId: "j3" }, NOW + 6000);
  const runs = spendRuns(0);
  assert.equal(runs.length, 2, "незакрытый резерв в журнал не попадает");
  assert.equal(runs[0].runId, `carousel:${base.carouselId}:j1`);
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].total, 0.14);
  assert.deepEqual(runs[0].byProvider, { carousel: 0.14 });
  assert.match(runs[0].label, /исход 1 запросов неизвестен/);
  assert.equal(runs[1].status, "failed");
  assert.deepEqual(runs[1].byProvider, {});
  assert.equal(spendRuns(NOW + 4500).length, 1, "окно по времени");
  settleSpend(pending.id, { status: "done", cost: 0.09 });
  assert.equal(spendRuns(0).length, 3);
});
