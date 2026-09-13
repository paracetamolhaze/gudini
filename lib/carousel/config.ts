import { DEFAULT_IMAGE_MODEL, DEFAULT_RESOLUTION, DEFAULT_TEXT_MODEL, IMAGE_MODEL_IDS, isImageModelId, isResolution, type ImageResolution } from "./models";
import type { ImageModelId } from "./types";

/**
 * Настройки раздела «Карусели» — только серверные переменные окружения.
 *
 * Ключ OpenRouter у раздела свой: CAROUSEL_OPENROUTER_API_KEY. Ключи видео и обложек
 * (OPENROUTER, OPENROUTER_CLAUDE_KEY), ключ Anthropic и ключи из «Настроек» здесь не
 * читаются, и запасного перехода на них нет: без своего ключа платные действия раздела
 * просто не выполняются. Значение ключа не уходит ни в браузер, ни в ответы API, ни в логи —
 * наружу только «задан / не задан».
 */

export const KEY_ENV = "CAROUSEL_OPENROUTER_API_KEY";

export function carouselApiKey(): string | null {
  const raw = process.env.CAROUSEL_OPENROUTER_API_KEY;
  const key = typeof raw === "string" ? raw.trim() : "";
  return key.length >= 10 ? key : null;
}

const MODEL_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._:-]*$/i;

export function textModel(): { id: string; problem?: string } {
  const raw = (process.env.CAROUSEL_TEXT_MODEL ?? "").trim();
  if (!raw) return { id: DEFAULT_TEXT_MODEL };
  if (!MODEL_ID_RE.test(raw)) return { id: raw, problem: `CAROUSEL_TEXT_MODEL: «${raw.slice(0, 60)}» — не идентификатор модели OpenRouter` };
  return { id: raw };
}

/** Модель изображений по умолчанию. Неизвестная модель — ошибка настройки, не повод взять другую. */
export function defaultImageModel(): { id: ImageModelId | null; problem?: string } {
  const raw = (process.env.CAROUSEL_IMAGE_MODEL ?? "").trim();
  if (!raw) return { id: DEFAULT_IMAGE_MODEL };
  if (isImageModelId(raw)) return { id: raw };
  return { id: null, problem: `CAROUSEL_IMAGE_MODEL: «${raw.slice(0, 60)}» не поддерживается разделом (доступны: ${IMAGE_MODEL_IDS.join(", ")})` };
}

export function imageResolution(): ImageResolution {
  const raw = (process.env.CAROUSEL_IMAGE_RESOLUTION ?? "").trim().toUpperCase();
  return isResolution(raw) ? raw : DEFAULT_RESOLUTION;
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Отдельный бюджет раздела: месяц и одна карусель. 0 — платные действия выключены. */
export function budgetLimits(): { monthlyUsd: number; perCarouselUsd: number } {
  return {
    monthlyUsd: num("CAROUSEL_MONTHLY_BUDGET_USD", 20, 0, 100_000),
    perCarouselUsd: num("CAROUSEL_MAX_COST_PER_CAROUSEL_USD", 3, 0, 10_000),
  };
}

/** Параллельных запросов к генератору внутри одного задания — видео и сайт не должны страдать. */
export const imageConcurrency = () => Math.round(num("CAROUSEL_IMAGE_CONCURRENCY", 2, 1, 4));
export const imageTimeoutMs = () => num("CAROUSEL_IMAGE_TIMEOUT_MS", 240_000, 30_000, 900_000);
export const textTimeoutMs = () => num("CAROUSEL_TEXT_TIMEOUT_MS", 240_000, 30_000, 900_000);

/** Сколько минут после назначенного времени публикация ещё отправляется (например, после простоя сервера). */
export const scheduleGraceMinutes = () => Math.round(num("CAROUSEL_SCHEDULE_GRACE_MINUTES", 60, 0, 24 * 60));

/** Что мешает платным действиям раздела — готовые фразы для интерфейса, без значений секретов. */
export function configProblems(): string[] {
  const p: string[] = [];
  if (!carouselApiKey()) p.push(`Требуется ключ OpenRouter для каруселей: переменная ${KEY_ENV} в .env сайта.`);
  const t = textModel();
  if (t.problem) p.push(t.problem);
  const i = defaultImageModel();
  if (i.problem) p.push(i.problem);
  return p;
}
