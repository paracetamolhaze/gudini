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
  | "Cover QC";

export type CostProvider = "anthropic" | "openrouter" | "brave" | "elevenlabs" | "openai" | "local";

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

export function resetLedger(): void {
  entries = [];
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
  ) {
    super(
      `Лимит расходов задачи исчерпан: потрачено ${spent.toFixed(4)}$` +
        (projected ? `, следующий запрос оценён в ${projected.toFixed(4)}$` : "") +
        ` при пределе ${limit}$. Стадия «${stage}» остановлена ДО отправки платного запроса. ` +
        "Поднимите MEDIA_JOB_MAX_COST_USD или снимите MEDIA_JOB_HARD_LIMIT.",
    );
    this.name = "CostLimitError";
  }
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
  const { max, hardLimit } = costGuard();
  if (!hardLimit || !Number.isFinite(max) || max <= 0) return;
  const spent = summarize().totals.variableApiCost;
  if (spent + projectedCost > max) throw new CostLimitError(spent, max, stage, projectedCost);
}

/** Проверяет накопленную сумму и называет стадию-виновника. Решение принимает вызывающий. */
export function checkGuard(): { level: "ok" | "warn" | "over"; cost: number; topStage?: CostStage; message?: string } {
  const s = summarize();
  const { warn, max } = costGuard();
  const cost = s.totals.variableApiCost;
  const top = [...s.stages].sort((a, b) => b.cost - a.cost)[0];
  const blame = top ? `Больше всего съела стадия «${top.stage}» (${top.cost.toFixed(4)}$).` : "";
  if (cost >= max) {
    return { level: "over", cost, topStage: top?.stage, message: `Стоимость ролика ${cost.toFixed(4)}$ превысила предел ${max}$. ${blame}` };
  }
  if (cost >= warn) {
    return { level: "warn", cost, topStage: top?.stage, message: `Стоимость ролика ${cost.toFixed(4)}$ выше порога ${warn}$. ${blame}` };
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
