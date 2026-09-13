import type { CarouselFormat, ImageModelId } from "./types";

/**
 * Модели раздела «Карусели». Сверено с каталогом OpenRouter 2026-09-13:
 * GET /api/v1/images/models (параметры моделей) и /api/v1/images/models/<id>/endpoints (цены).
 * Все три модели вызываются одним POST /api/v1/images, но возможности у них разные:
 * у GPT Image 2 нет соотношения 4:5 и выбора разрешения. Цена картинки здесь — оценка для
 * бюджета и подсказки; фактическая стоимость берётся из usage.cost ответа OpenRouter.
 */
export const MODELS_CHECKED_AT = "2026-09-13";

export type ImageResolution = "1K" | "2K" | "4K";

export type ImageModelInfo = {
  id: ImageModelId;
  label: string;
  vendor: string;
  /** соотношение сторон, которое запрашивается у модели для формата карточки */
  aspect: Record<CarouselFormat, string>;
  /** поддерживаемые разрешения; null — параметр модель не принимает */
  resolutions: ImageResolution[] | null;
  quality?: "low" | "medium" | "high";
  maxReferences: number;
  /** оценка цены одной картинки, $ */
  estimateUsd: Partial<Record<ImageResolution, number>> & { default: number };
  pricing: string;
  note?: string;
};

export const IMAGE_MODELS: Record<ImageModelId, ImageModelInfo> = {
  "google/gemini-3.1-flash-image": {
    id: "google/gemini-3.1-flash-image",
    label: "Nano Banana 2",
    vendor: "Google · Gemini 3.1 Flash Image",
    aspect: { portrait: "4:5", square: "1:1" },
    resolutions: ["1K", "2K", "4K"],
    maxReferences: 14,
    estimateUsd: { "1K": 0.07, "2K": 0.1, "4K": 0.15, default: 0.1 },
    pricing: "$0.00006 за токен выходного изображения; 2K ≈ $0.10 за картинку (оценка)",
  },
  "google/gemini-3-pro-image": {
    id: "google/gemini-3-pro-image",
    label: "Nano Banana Pro",
    vendor: "Google · Gemini 3 Pro Image",
    aspect: { portrait: "4:5", square: "1:1" },
    resolutions: ["1K", "2K", "4K"],
    maxReferences: 14,
    estimateUsd: { "1K": 0.14, "2K": 0.14, "4K": 0.25, default: 0.14 },
    pricing: "$0.00012 за токен выходного изображения + входные референсы; 2K ≈ $0.14 (оценка)",
  },
  "openai/gpt-image-2": {
    id: "openai/gpt-image-2",
    label: "GPT Image 2",
    vendor: "OpenAI · GPT Image 2",
    aspect: { portrait: "3:4", square: "1:1" },
    resolutions: null,
    quality: "medium",
    maxReferences: 16,
    estimateUsd: { default: 0.07 },
    pricing: "$0.00003 за токен выходного изображения + входные картинки; качество medium ≈ $0.07 (оценка)",
    note: "Модель не умеет 4:5 и не принимает разрешение: картинка 3:4 кадрируется до 4:5 без растяжения, 2K не заказывается.",
  },
};

export const IMAGE_MODEL_IDS = Object.keys(IMAGE_MODELS) as ImageModelId[];
export const DEFAULT_IMAGE_MODEL: ImageModelId = "google/gemini-3.1-flash-image";
export const DEFAULT_RESOLUTION: ImageResolution = "2K";

/**
 * Claude для каруселей: Sonnet 5 — баланс качества русского текста и цены. Opus в каждой
 * мелкой правке не нужен; модель меняется переменной CAROUSEL_TEXT_MODEL.
 */
export const DEFAULT_TEXT_MODEL = "anthropic/claude-sonnet-5";

/** Цены текстовых моделей OpenRouter за миллион токенов (каталог 2026-09-13). */
export const TEXT_MODEL_PRICES: Record<string, { inPerM: number; outPerM: number }> = {
  "anthropic/claude-sonnet-5": { inPerM: 2, outPerM: 10 },
  "anthropic/claude-opus-5": { inPerM: 5, outPerM: 25 },
  "anthropic/claude-haiku-4.5": { inPerM: 1, outPerM: 5 },
  "anthropic/claude-sonnet-4.6": { inPerM: 3, outPerM: 15 },
};

export const isImageModelId = (v: unknown): v is ImageModelId => typeof v === "string" && Object.prototype.hasOwnProperty.call(IMAGE_MODELS, v);

export function isResolution(v: unknown): v is ImageResolution {
  return v === "1K" || v === "2K" || v === "4K";
}

/** Разрешение, которое реально уходит в запрос: у модели без параметра — null, без подмены. */
export function requestResolution(model: ImageModelId, wanted: ImageResolution): ImageResolution | null {
  const r = IMAGE_MODELS[model].resolutions;
  if (!r) return null;
  return r.includes(wanted) ? wanted : null;
}

export function imageEstimate(model: ImageModelId, resolution: ImageResolution | null): number {
  const m = IMAGE_MODELS[model];
  return (resolution && m.estimateUsd[resolution]) || m.estimateUsd.default;
}

const TEXT_TOKENS = { plan: [7000, 7000], edit: [7000, 6000], slide: [6000, 1500] } as const;

/** Оценка одного запроса к Claude. Неизвестная модель считается по цене Opus, чтобы не занизить. */
export function textEstimate(model: string, kind: keyof typeof TEXT_TOKENS): number {
  const p = TEXT_MODEL_PRICES[model] ?? TEXT_MODEL_PRICES["anthropic/claude-opus-5"];
  const [input, output] = TEXT_TOKENS[kind];
  return (input * p.inPerM + output * p.outPerM) / 1_000_000;
}

export type CarouselEstimate = { text: number; perImage: number; images: number; total: number; resolution: ImageResolution | null };

/** Оценка расходов до запуска: план Claude с запасом на одно исправление и по картинке на слайд. */
export function estimateCarousel(args: { slideCount: number; imageModel: ImageModelId; resolution: ImageResolution; textModel: string }): CarouselEstimate {
  const resolution = requestResolution(args.imageModel, args.resolution);
  const text = textEstimate(args.textModel, "plan") * 1.5;
  const perImage = imageEstimate(args.imageModel, resolution);
  const images = perImage * args.slideCount;
  return { text, perImage, images, total: text + images, resolution };
}
