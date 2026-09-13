import fs from "fs";
import path from "path";
import type { CarouselCost } from "./types";
import { budgetLimits } from "./config";
import { CarouselError, carouselsRoot, newId, withFileLock, writeFileAtomic } from "./store";
import { monthKey } from "./timezone";

/**
 * Журнал расходов раздела «Карусели»: data/carousels/spend.json. Отдельный от журнала
 * роликов (data/spend-log.json) — тот файл раздел не пишет; в страницу «Расходы» записи
 * подмешиваются при чтении отдельной категорией «carousel».
 *
 * Каждый платный запрос сначала резервируется по оценке (это и есть проверка бюджета:
 * параллельные запросы не проходят её по одному остатку), затем закрывается фактической
 * ценой из usage.cost OpenRouter. Неизвестный исход (тайм-аут после отправки) остаётся в
 * журнале по оценке с пометкой — деньги могли уйти, и делать вид, что нет, нельзя.
 */

export type SpendKind = "text" | "image";
export type SpendStatus = "pending" | "done" | "failed" | "uncertain";

export type SpendEntry = {
  id: string;
  carouselId: string;
  title: string;
  kind: SpendKind;
  /** «План карусели», «Иллюстрация слайда 3» */
  label: string;
  /** подпись строки в журнале «Расходы»: «Карусель: генерация» */
  runLabel: string;
  model: string;
  estimate: number;
  cost: number;
  /** цена посчитана по оценке, а не получена от OpenRouter */
  estimated: boolean;
  status: SpendStatus;
  jobId?: string;
  slideId?: string;
  at: string;
  settledAt?: string;
  note?: string;
};

export type BudgetStatus = {
  monthlyLimitUsd: number;
  perCarouselLimitUsd: number;
  monthSpentUsd: number;
  monthPendingUsd: number;
  monthRemainingUsd: number;
  month: string;
  disabled: boolean;
};

const MAX_ENTRIES = 5000;
const round = (v: number) => Math.round(v * 1e6) / 1e6;
const spendFile = () => path.join(carouselsRoot(), "spend.json");

export function readSpend(): SpendEntry[] {
  try {
    const j = JSON.parse(fs.readFileSync(spendFile(), "utf8"));
    return Array.isArray(j?.entries) ? j.entries.filter((e: any) => e && typeof e.id === "string") : [];
  } catch {
    return [];
  }
}

function writeSpend(entries: SpendEntry[]) {
  fs.mkdirSync(carouselsRoot(), { recursive: true });
  writeFileAtomic(spendFile(), JSON.stringify({ entries: entries.slice(-MAX_ENTRIES) }, null, 1), true);
}

function withSpend<T>(fn: (entries: SpendEntry[]) => T): T {
  fs.mkdirSync(carouselsRoot(), { recursive: true });
  return withFileLock(spendFile(), () => {
    const entries = readSpend();
    const result = fn(entries);
    writeSpend(entries);
    return result;
  });
}

/** Что уже стоит против бюджета: закрытые по факту, неизвестные по оценке, идущие по резерву. */
const charged = (e: SpendEntry) => (e.status === "pending" ? e.estimate : e.cost);

export function budgetStatus(now = Date.now(), entries = readSpend()): BudgetStatus {
  const { monthlyUsd, perCarouselUsd } = budgetLimits();
  const month = monthKey(now);
  let spent = 0;
  let pending = 0;
  for (const e of entries) {
    if (monthKey(Date.parse(e.at)) !== month) continue;
    if (e.status === "pending") pending += e.estimate;
    else spent += e.cost;
  }
  return {
    monthlyLimitUsd: monthlyUsd,
    perCarouselLimitUsd: perCarouselUsd,
    monthSpentUsd: round(spent),
    monthPendingUsd: round(pending),
    monthRemainingUsd: round(Math.max(0, monthlyUsd - spent - pending)),
    month,
    disabled: monthlyUsd <= 0 || perCarouselUsd <= 0,
  };
}

export function carouselSpend(carouselId: string, entries = readSpend()): CarouselCost {
  const c: CarouselCost = { usd: 0, calls: 0, text: 0, images: 0, uncertain: 0 };
  for (const e of entries) {
    if (e.carouselId !== carouselId || e.status === "pending") continue;
    const cost = e.cost;
    c.usd += cost;
    c.calls += 1;
    if (e.kind === "text") c.text! += cost;
    else c.images! += cost;
    if (e.status === "uncertain") c.uncertain! += 1;
  }
  c.usd = round(c.usd);
  c.text = round(c.text!);
  c.images = round(c.images!);
  return c;
}

/**
 * Проверка бюджета перед платным запросом: месяц раздела и одна карусель, с учётом резервов.
 * Отказ — ошибка 402 с понятной фразой; ничего не отправлялось.
 */
export function assertBudget(carouselId: string, projected: number, now = Date.now(), entries = readSpend()): void {
  const b = budgetStatus(now, entries);
  if (b.disabled) throw new CarouselError("Платные действия каруселей выключены: бюджет раздела равен нулю (CAROUSEL_MONTHLY_BUDGET_USD / CAROUSEL_MAX_COST_PER_CAROUSEL_USD).", 402, "budget");
  if (b.monthSpentUsd + b.monthPendingUsd + projected > b.monthlyLimitUsd) {
    throw new CarouselError(
      `Месячный бюджет каруселей исчерпан: потрачено $${b.monthSpentUsd.toFixed(2)}${b.monthPendingUsd ? ` + $${b.monthPendingUsd.toFixed(2)} в работе` : ""} из $${b.monthlyLimitUsd.toFixed(2)}, запрос стоит ≈ $${projected.toFixed(2)}. Поднимите CAROUSEL_MONTHLY_BUDGET_USD или дождитесь следующего месяца.`,
      402,
      "budget",
    );
  }
  const own = entries.filter((e) => e.carouselId === carouselId).reduce((s, e) => s + charged(e), 0);
  if (own + projected > b.perCarouselLimitUsd) {
    throw new CarouselError(
      `Предел расходов на одну карусель достигнут: $${own.toFixed(2)} из $${b.perCarouselLimitUsd.toFixed(2)}, запрос стоит ≈ $${projected.toFixed(2)}. Поднимите CAROUSEL_MAX_COST_PER_CAROUSEL_USD или создайте новую карусель.`,
      402,
      "budget",
    );
  }
}

export type ReserveArgs = Pick<SpendEntry, "carouselId" | "title" | "kind" | "label" | "runLabel" | "model" | "estimate"> & { jobId?: string; slideId?: string };

/** Резерв по оценке. Бросает 402, если запрос не помещается в бюджет. */
export function reserveSpend(args: ReserveArgs, now = Date.now()): SpendEntry {
  return withSpend((entries) => {
    assertBudget(args.carouselId, args.estimate, now, entries);
    const entry: SpendEntry = { ...args, id: newId("sp"), estimate: round(args.estimate), cost: 0, estimated: true, status: "pending", at: new Date(now).toISOString() };
    entries.push(entry);
    return entry;
  });
}

export type SettleOutcome = { status: "done" | "failed" | "uncertain"; cost?: number | null; note?: string };

/**
 * Закрытие резерва. done — фактическая цена (нет цены от провайдера → оценка с пометкой);
 * failed — только цена, которую провайдер всё же назвал (обычно 0); uncertain — оценка.
 */
export function settleSpend(id: string, outcome: SettleOutcome, now = Date.now()): SpendEntry | null {
  return withSpend((entries) => {
    const e = entries.find((x) => x.id === id);
    if (!e || e.status !== "pending") return null;
    const actual = typeof outcome.cost === "number" && Number.isFinite(outcome.cost) && outcome.cost >= 0 ? outcome.cost : null;
    e.status = outcome.status;
    if (outcome.status === "done") {
      e.cost = round(actual ?? e.estimate);
      e.estimated = actual === null;
    } else if (outcome.status === "failed") {
      e.cost = round(actual ?? 0);
      e.estimated = actual === null && e.cost > 0;
    } else {
      e.cost = round(actual ?? e.estimate);
      e.estimated = actual === null;
    }
    e.settledAt = new Date(now).toISOString();
    if (outcome.note) e.note = outcome.note.slice(0, 300);
    return e;
  });
}

/** Резервы, оставшиеся от умершего обработчика: исход их запросов неизвестен. */
export function settleOrphans(note: string, now = Date.now()): number {
  return withSpend((entries) => {
    let n = 0;
    for (const e of entries) {
      if (e.status !== "pending") continue;
      e.status = "uncertain";
      e.cost = e.estimate;
      e.estimated = true;
      e.settledAt = new Date(now).toISOString();
      e.note = note;
      n++;
    }
    return n;
  });
}

export type SpendRunLike = {
  runId: string;
  projectId: null;
  topic?: string;
  at: string;
  status: "done" | "failed";
  label: string;
  total: number;
  byProvider: Record<string, number>;
};

/** Записи журнала раздела для страницы «Расходы»: одна строка на задание, категория carousel. */
export function spendRuns(since: number, entries = readSpend()): SpendRunLike[] {
  const groups = new Map<string, SpendEntry[]>();
  for (const e of entries) {
    if (e.status === "pending" || Date.parse(e.settledAt ?? e.at) < since) continue;
    const key = `${e.carouselId}:${e.jobId ?? e.id}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const runs: SpendRunLike[] = [];
  for (const [key, list] of groups) {
    const total = round(list.reduce((s, e) => s + e.cost, 0));
    const uncertain = list.filter((e) => e.status === "uncertain").length;
    const failed = list.every((e) => e.status === "failed");
    const at = list.map((e) => e.settledAt ?? e.at).sort().at(-1)!;
    runs.push({
      runId: `carousel:${key}`,
      projectId: null,
      topic: list[0].title,
      at,
      status: failed ? "failed" : "done",
      label: `${list[0].runLabel}${uncertain ? ` (исход ${uncertain} запросов неизвестен, по оценке)` : ""}`,
      total,
      byProvider: total > 0 ? { carousel: total } : {},
    });
  }
  return runs.sort((a, b) => a.at.localeCompare(b.at));
}
