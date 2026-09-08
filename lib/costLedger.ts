import fs from "fs";
import path from "path";
import { assertProvider } from "./providerPolicy";

/**
 * Учёт денег по одному ролику: каждый платный вызов записывается отдельной строкой.
 *
 * Счётчики вида «сколько раз вызвали» отвечают на вопрос «что происходило», но не
 * на вопрос «сколько это стоило»: один и тот же вызов у разных моделей отличается
 * на порядок. Поэтому здесь фиксируется реальный расход токенов и запросов, а цена
 * берётся у провайдера, когда он её сообщает, и считается по тарифу, когда нет.
 */

export type CostStage =
  | "Story Research"
  | "Script Generation"
  | "Script Beats"
  | "Media Research"
  | "Source Verification"
  | "Vision Verification"
  | "Beat Matching"
  | "Creative Director"
  | "Speech Cleanup"
  | "Metadata"
  | "Transcription"
  | "Cover Concept"
  | "Cover Generation"
  | "Cover QC"
  | "AI Film Story"
  | "AI Film Generation";

export type CostProvider = "anthropic" | "openrouter" | "brave" | "elevenlabs" | "openai" | "google" | "local";

export type CostEntry = {
  stage: CostStage;
  provider: CostProvider;
  /** модель или endpoint — то, по чему провайдер выставляет счёт */
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** цена, названная самим провайдером; заполняется только если он её вернул */
  providerReportedCost?: number;
  estimatedCost: number;
  /** true — цена посчитана по тарифу, а не получена от провайдера */
  estimated: boolean;
  /** запрос завершился ошибкой; провайдер мог его всё равно оттарифицировать */
  failed?: boolean;
  /** повтор после неудачи */
  retry?: boolean;
};

/** Тариф за миллион токенов. Правится здесь, а не по коду. */
export type ModelPrice = {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok?: number;
  cacheReadPerMTok?: number;
};

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
  // те же модели через OpenRouter (MEDIA_LLM_TRANSPORT=openrouter): тарифы Anthropic без наценки
  "anthropic/claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  "anthropic/claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  "anthropic/claude-sonnet-4.5": { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  "anthropic/claude-haiku-4.5": { inputPerMTok: 1, outputPerMTok: 5 },
  "google/gemini-3.1-flash-image": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
};

/** Цена одного запроса к платным не-токенным API. */
export const REQUEST_PRICES: Record<string, number> = {
  "brave/news/search": 0.005,
  "brave/videos/search": 0.005,
  "brave/images/search": 0.005,
  "brave/web/search": 0.005,
};

/** Цена за минуту аудио. */
export const AUDIO_PRICES: Record<string, number> = {
  "elevenlabs/scribe": 0.006,
  "openai/whisper-1": 0.006,
};

/** Фиксированная цена за одну сгенерированную картинку. */
export const IMAGE_PRICES: Record<string, number> = {
  "google/gemini-3.1-flash-image": 0.068,
};

let entries: CostEntry[] = [];
/** Запросы, которые уже отправлены, но ещё не учтены: их оценка держит место в бюджете. */
const reservations = new Map<number, { stage: CostStage; cost: number }>();
let reservationSeq = 0;
/** Общие стадии и Veo имеют независимые накопительные бюджеты проекта. */
let priorCost = 0;
let priorFilmCost = 0;

export function resetLedger(): void {
  entries = [];
  reservations.clear();
  runLimitOverride = null;
}

/**
 * Подтверждённый предел запуска Veo. Общие стадии сохраняют обычные ограничения;
 * прошлые генерации Veo также учитываются в MEDIA_FILM_MAX_COST_USD.
 * Сбрасывается resetLedger.
 */
let runLimitOverride: number | null = null;
export function setRunCostLimit(usd: number | null): void {
  runLimitOverride = usd != null && Number.isFinite(usd) && usd > 0 ? usd : null;
}

export type ProjectCostBreakdown = { total: number; aiFilmGeneration: number };
const positiveCost = (v: unknown): number => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0;

export function setPriorProjectCost(usd: number | ProjectCostBreakdown): void {
  const total = positiveCost(typeof usd === "number" ? usd : usd.total);
  priorFilmCost = typeof usd === "number" ? 0 : Math.min(total, positiveCost(usd.aiFilmGeneration));
  priorCost = Number(Math.max(0, total - priorFilmCost).toFixed(6));
}

export function inFlightCost(): number {
  let sum = 0;
  for (const v of reservations.values()) sum += v.cost;
  return sum;
}

/** Сумма переменных расходов прошлых прогонов проекта по сохранённым леджерам. */
export function priorProjectCost(dir: string): number {
  return priorProjectCostBreakdown(dir).total;
}

/** Старые леджеры без стадий консервативно относятся к общему бюджету. */
export function priorProjectCostBreakdown(dir: string): ProjectCostBreakdown {
  const runs = path.join(dir, "cost-runs");
  const files: string[] = [];
  try {
    files.push(...fs.readdirSync(runs).filter((f) => f.endsWith(".json")).map((f) => path.join(runs, f)));
  } catch {}
  if (!files.length) {
    const single = path.join(dir, "pipeline-cost.json");
    if (fs.existsSync(single)) files.push(single);
  }
  let total = 0;
  let aiFilmGeneration = 0;
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      const rows = Array.isArray(j?.entries) ? j.entries : null;
      const runTotal = positiveCost(j?.summary?.totals?.variableApiCost ?? rows?.reduce((sum: number, e: any) => sum + positiveCost(e.estimatedCost), 0));
      const stages = Array.isArray(j?.summary?.stages) ? j.summary.stages : [];
      const film = rows
        ? rows.filter((e: any) => e.stage === "AI Film Generation").reduce((sum: number, e: any) => sum + positiveCost(e.estimatedCost), 0)
        : stages.filter((e: any) => e.stage === "AI Film Generation").reduce((sum: number, e: any) => sum + positiveCost(e.cost), 0);
      total += runTotal;
      aiFilmGeneration += Math.min(runTotal, film);
    } catch {}
  }
  return { total, aiFilmGeneration };
}

export function record(e: CostEntry): void {
  // Проверка стоит именно здесь: любой платный вызов обязан пройти через учёт,
  // поэтому здесь же его видит и политика провайдеров. Обойти одно, не обойдя
  // другое, невозможно.
  assertProvider(e.stage, e.provider);
  entries.push(e);
}

/** Стоимость последнего записанного вызова: считать её второй раз незачем. */
export function lastRecordedCost(): number {
  return entries.length ? entries[entries.length - 1].estimatedCost : 0;
}

export function ledger(): CostEntry[] {
  return entries.map((e) => ({ ...e }));
}

/** Цена по тарифу для токенного вызова. */
export function priceTokens(
  model: string,
  t: { inputTokens?: number; outputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number },
): { cost: number; known: boolean } {
  const p = MODEL_PRICES[model];
  if (!p) return { cost: 0, known: false };
  const m = 1_000_000;
  const cost =
    ((t.inputTokens ?? 0) * p.inputPerMTok +
      (t.outputTokens ?? 0) * p.outputPerMTok +
      (t.cacheCreationTokens ?? 0) * (p.cacheWritePerMTok ?? p.inputPerMTok) +
      (t.cacheReadTokens ?? 0) * (p.cacheReadPerMTok ?? p.inputPerMTok)) /
    m;
  return { cost, known: true };
}

/**
 * Записать токенный вызов. Названная провайдером сумма имеет приоритет над тарифом:
 * если он сказал, сколько списал, выдумывать свою цифру нельзя.
 */
export function recordTokens(args: {
  stage: CostStage;
  provider: CostProvider;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  providerReportedCost?: number;
  failed?: boolean;
  retry?: boolean;
}): void {
  const priced = priceTokens(args.model, args);
  const reported = typeof args.providerReportedCost === "number" ? args.providerReportedCost : undefined;
  record({
    stage: args.stage,
    provider: args.provider,
    model: args.model,
    requests: 1,
    inputTokens: args.inputTokens ?? 0,
    outputTokens: args.outputTokens ?? 0,
    cacheCreationTokens: args.cacheCreationTokens ?? 0,
    cacheReadTokens: args.cacheReadTokens ?? 0,
    providerReportedCost: reported,
    estimatedCost: reported ?? priced.cost,
    estimated: reported === undefined,
    failed: args.failed,
    retry: args.retry,
  });
}

/** Записать запрос к API с поштучной тарификацией (поиск). */
export function recordRequest(args: {
  stage: CostStage;
  provider: CostProvider;
  endpoint: string;
  failed?: boolean;
}): void {
  const unit = REQUEST_PRICES[args.endpoint] ?? 0;
  record({
    stage: args.stage,
    provider: args.provider,
    model: args.endpoint,
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    estimatedCost: unit,
    estimated: true,
    failed: args.failed,
  });
}

/** Записать операцию с фиксированной ценой (картинка, минута аудио). */
export function recordFlat(args: {
  stage: CostStage;
  provider: CostProvider;
  model: string;
  cost: number;
  estimated?: boolean;
  failed?: boolean;
}): void {
  record({
    stage: args.stage,
    provider: args.provider,
    model: args.model,
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    estimatedCost: args.cost,
    estimated: args.estimated ?? true,
    failed: args.failed,
  });
}

export type StageTotal = {
  stage: CostStage;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
  /** хотя бы одна строка стадии посчитана по тарифу, а не названа провайдером */
  hasEstimates: boolean;
};

export type CostSummary = {
  stages: StageTotal[];
  totals: {
    variableApiCost: number;
    requests: number;
    llmCalls: number;
    visionCalls: number;
    searchRequests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    failedOrRetryCalls: number;
    failedOrRetryCost: number;
  };
  /** вызовы, тариф которых неизвестен: значит, итог занижен */
  unpricedModels: string[];
};

export function summarize(): CostSummary {
  const byStage = new Map<CostStage, StageTotal>();
  const unpriced = new Set<string>();
  const t = {
    variableApiCost: 0,
    requests: 0,
    llmCalls: 0,
    visionCalls: 0,
    searchRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    failedOrRetryCalls: 0,
    failedOrRetryCost: 0,
  };

  for (const e of entries) {
    const s = byStage.get(e.stage) ?? {
      stage: e.stage,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cost: 0,
      hasEstimates: false,
    };
    s.requests += e.requests;
    s.inputTokens += e.inputTokens;
    s.outputTokens += e.outputTokens;
    s.cacheReadTokens += e.cacheReadTokens;
    s.cost += e.estimatedCost;
    s.hasEstimates = s.hasEstimates || e.estimated;
    byStage.set(e.stage, s);

    t.variableApiCost += e.estimatedCost;
    t.requests += e.requests;
    t.inputTokens += e.inputTokens;
    t.outputTokens += e.outputTokens;
    t.cacheReadTokens += e.cacheReadTokens;
    if (e.provider === "brave") t.searchRequests += e.requests;
    else if (e.stage === "Vision Verification") t.visionCalls += e.requests;
    else if (e.inputTokens || e.outputTokens) t.llmCalls += e.requests;
    if (e.failed || e.retry) {
      t.failedOrRetryCalls += e.requests;
      t.failedOrRetryCost += e.estimatedCost;
    }
    if (e.inputTokens && !MODEL_PRICES[e.model] && e.providerReportedCost === undefined) unpriced.add(e.model);
  }

  t.variableApiCost = Number(t.variableApiCost.toFixed(6));
  t.failedOrRetryCost = Number(t.failedOrRetryCost.toFixed(6));
  return { stages: [...byStage.values()], totals: t, unpricedModels: [...unpriced] };
}

/**
 * Порог предупреждения и предел расходов задачи.
 *
 * Предупреждение само по себе production не ломает. Жёсткий предел включается
 * явно (MEDIA_JOB_HARD_LIMIT=1) и останавливает НОВЫЕ платные запросы до того,
 * как они отправлены: узнать о перерасходе постфактум — значит уже заплатить.
 */
export function costGuard(): { warn: number; max: number; hardLimit: boolean } {
  return {
    warn: Number(process.env.MEDIA_JOB_WARN_COST_USD ?? 1.0),
    max: Number(process.env.MEDIA_JOB_MAX_COST_USD ?? 2.0),
    hardLimit: process.env.MEDIA_JOB_HARD_LIMIT === "1",
  };
}

/** Задача остановлена лимитом расходов. */
export class CostLimitError extends Error {
  constructor(
    readonly spent: number,
    readonly limit: number,
    readonly stage: CostStage,
    readonly projected = 0,
    readonly reserved = 0,
  ) {
    super(
      `Лимит расходов задачи исчерпан: потрачено ${spent.toFixed(4)}$` +
        (reserved ? ` плюс ${reserved.toFixed(4)}$ за запросы, которые ещё выполняются` : "") +
        (projected ? `, следующий запрос оценён в ${projected.toFixed(4)}$` : "") +
        ` при пределе ${limit}$. Стадия «${stage}» остановлена ДО отправки платного запроса. ` +
        (stage === "AI Film Generation"
          ? "Проверьте бюджет фильма MEDIA_FILM_MAX_COST_USD."
          : "Поднимите MEDIA_JOB_MAX_COST_USD или снимите MEDIA_JOB_HARD_LIMIT."),
    );
    this.name = "CostLimitError";
  }
}

/** Суммарные расходы проекта (все прогоны) упёрлись в предел. */
export class ProjectCostLimitError extends Error {
  constructor(
    readonly prior: number,
    readonly spent: number,
    readonly limit: number,
    readonly stage: CostStage,
    readonly projected = 0,
    readonly limitSetting = "MEDIA_PROJECT_MAX_COST_USD",
  ) {
    super(
      `Суммарные расходы проекта ${(prior + spent + projected).toFixed(2)}$ (прошлые прогоны ${prior.toFixed(2)}$, ` +
        `этот ${spent.toFixed(2)}$` + (projected ? `, следующий запрос ${projected.toFixed(2)}$` : "") + ") " +
        `превысили предел проекта ${limitSetting}=${limit}$. Стадия «${stage}» остановлена ДО платного запроса. ` +
        "Поднимите предел, если монтаж этого проекта действительно нужен.",
    );
    this.name = "ProjectCostLimitError";
  }
}

/** Предел на проект целиком: сумма всех прогонов. 0 — выключен. */
export function projectGuard(): number {
  const v = Number(process.env.MEDIA_PROJECT_MAX_COST_USD ?? 6);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Верхняя разумная оценка стоимости ЕЩЁ НЕ отправленного запроса.
 *
 * Точно предсказать длину ответа нельзя, поэтому оценка сознательно
 * пессимистична: выход считается по max_tokens. Лучше зарезервировать больше
 * и не отправить запрос, чем недооценить и перескочить предел последней тратой.
 * После ответа провайдера учёт заменит оценку фактическим расходом.
 */
export function projectRequestCost(args: {
  model: string;
  /** длина промпта в символах: система плюс запрос */
  promptChars: number;
  /** сколько изображений уходит в запрос */
  images?: number;
  /**
   * токенов на одно изображение. По умолчанию — кадр 1080p (~1600), но кадр
   * контроля качества 384px стоит ~110: считать его по 1600 значит завышать
   * оценку в разы и останавливать запросы, которые укладываются в лимит.
   */
  imageTokensEach?: number;
  maxTokens: number;
}): number {
  const p = MODEL_PRICES[args.model];
  // тариф неизвестен — берём заведомо крупную оценку, а не ноль
  if (!p) return 0.5;
  // ~3 символа на токен для кириллицы: намеренно меньше обычных 4, чтобы не занизить
  const textTokens = Math.ceil(args.promptChars / 3);
  // кадр 1080×1920 в base64 обходится примерно в полторы тысячи токенов
  const imageTokens = (args.images ?? 0) * (args.imageTokensEach ?? 1600);
  const { cost } = priceTokens(args.model, {
    inputTokens: textTokens + imageTokens,
    outputTokens: args.maxTokens,
  });
  return cost;
}

/**
 * Разрешение на новый платный запрос. Вызывается ПЕРЕД обращением к провайдеру:
 * лимит имеет смысл, только если он останавливает трату, а не фиксирует её.
 *
 * Проверяется не только потраченное, но и стоимость самого запроса: иначе
 * при остатке в пять центов можно отправить запрос на двадцать и узнать
 * о превышении уже по счёту.
 *
 * Историческая стоимость (например, уже сделанная обложка) в лимит не входит:
 * она относится к прошлым запускам и повторно не тратится.
 */
export function assertBudget(stage: CostStage, projectedCost = 0): void {
  const guard = costGuard();
  const film = stage === "AI Film Generation";
  const max = film ? runLimitOverride ?? guard.max : guard.max;
  const hardLimit = film && runLimitOverride != null ? true : guard.hardLimit;
  const filmLimit = positiveCost(process.env.MEDIA_FILM_MAX_COST_USD ?? 12) || 12;
  const projectMax = film ? filmLimit : projectGuard();
  if (!hardLimit && !projectMax) return;
  const sameBudget = (s: CostStage) => (s === "AI Film Generation") === film;
  const spent = Number(entries.filter((e) => sameBudget(e.stage)).reduce((sum, e) => sum + e.estimatedCost, 0).toFixed(6));
  const reserved = [...reservations.values()].filter((r) => sameBudget(r.stage)).reduce((sum, r) => sum + r.cost, 0);
  const prior = film ? priorFilmCost : priorCost;
  // предел одного запуска: потрачено + запросы в полёте + этот запрос
  if (hardLimit && Number.isFinite(max) && max > 0 && spent + reserved + projectedCost > max) {
    throw new CostLimitError(spent, max, stage, projectedCost, reserved);
  }
  // предел проекта: то же плюс прошлые прогоны (три неудачи подряд на одном проекте стоили $1.71)
  if (projectMax && prior + spent + reserved + projectedCost > projectMax) {
    throw new ProjectCostLimitError(prior, spent + reserved, projectMax, stage, projectedCost, film ? "MEDIA_FILM_MAX_COST_USD" : "MEDIA_PROJECT_MAX_COST_USD");
  }
}

/**
 * Резерв на время запроса. Раньше проверка смотрела только на учтённые вызовы:
 * три параллельных запроса зрения проходили её по одному и тому же остатку и
 * вместе перескакивали предел. Резерв снимается, когда запрос учтён или упал.
 */
export function reserveBudget(stage: CostStage, projectedCost = 0): number {
  assertBudget(stage, projectedCost);
  const id = ++reservationSeq;
  reservations.set(id, { stage, cost: projectedCost });
  return id;
}

export function releaseBudget(id: number): void {
  reservations.delete(id);
}

export async function withBudget<T>(stage: CostStage, projectedCost: number, fn: () => Promise<T>): Promise<T> {
  const id = reserveBudget(stage, projectedCost);
  try {
    return await fn();
  } finally {
    releaseBudget(id);
  }
}

/** Проверяет накопленную сумму и называет стадию-виновника. Решение принимает вызывающий. */
export function checkGuard(): { level: "ok" | "warn" | "over"; cost: number; topStage?: CostStage; message?: string } {
  const s = summarize();
  const { warn, max } = costGuard();
  const cost = s.totals.variableApiCost;
  const filmCost = s.stages.find((row) => row.stage === "AI Film Generation")?.cost ?? 0;
  const commonCost = Number(Math.max(0, cost - filmCost).toFixed(6));
  const filmMax = Math.min(runLimitOverride ?? Infinity, positiveCost(process.env.MEDIA_FILM_MAX_COST_USD ?? 12) || 12);
  if (filmCost >= filmMax) {
    return { level: "over", cost, topStage: "AI Film Generation", message: `Стоимость генерации Veo ${filmCost.toFixed(4)}$ достигла предела ${filmMax}$.` };
  }
  const top = s.stages.filter((row) => row.stage !== "AI Film Generation").sort((a, b) => b.cost - a.cost)[0];
  const blame = top ? `Больше всего съела стадия «${top.stage}» (${top.cost.toFixed(4)}$).` : "";
  if (commonCost >= max) {
    return { level: "over", cost, topStage: top?.stage, message: `Стоимость общих стадий ${commonCost.toFixed(4)}$ достигла предела ${max}$. ${blame}` };
  }
  if (commonCost >= warn) {
    return { level: "warn", cost, topStage: top?.stage, message: `Стоимость общих стадий ${commonCost.toFixed(4)}$ выше порога ${warn}$. ${blame}` };
  }
  return { level: "ok", cost };
}

/** Инфраструктура считается отдельно от переменной стоимости API и только по фактическим данным. */
export function infrastructurePerVideo(): { cost: number | null; note: string } {
  const monthly = Number(process.env.INFRA_MONTHLY_USD ?? 0);
  const videos = Number(process.env.INFRA_VIDEOS_PER_MONTH ?? 0);
  if (!monthly || !videos) {
    return { cost: null, note: "нет данных: задайте INFRA_MONTHLY_USD и INFRA_VIDEOS_PER_MONTH" };
  }
  return { cost: monthly / videos, note: `приблизительно: ${monthly}$ в месяц / ${videos} роликов` };
}

export function writeLedger(dir: string): CostSummary {
  const summary = summarize();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "pipeline-cost.json"),
      JSON.stringify({ summary, entries: ledger(), createdAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
  } catch {}
  return summary;
}
