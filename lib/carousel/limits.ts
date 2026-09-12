import type { CarouselFormat, CarouselLanguage, SlideKind } from "./types";

/**
 * Ограничения Instagram Content Publishing API. Сверено с документацией Meta 2026-09-13:
 * developers.facebook.com/docs/instagram-platform/content-publishing
 * developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 *
 * Карусель — до 10 элементов; картинки только JPEG до 8 МБ, ширина 320–1440, соотношение
 * от 4:5 до 1.91:1, sRGB; подпись до 2200 символов, 30 хэштегов и 20 упоминаний; не больше
 * 100 публикаций через API за скользящие 24 часа; неопубликованный контейнер живёт 24 часа.
 */
export const IG_LIMITS = {
  minItems: 2,
  maxItems: 10,
  imageMime: "image/jpeg",
  imageMaxBytes: 8 * 1024 * 1024,
  minWidth: 320,
  maxWidth: 1440,
  minAspect: 4 / 5,
  maxAspect: 1.91,
  captionMaxChars: 2200,
  maxHashtags: 30,
  maxMentions: 20,
  postsPer24h: 100,
  containerTtlHours: 24,
  docsCheckedAt: "2026-09-13",
} as const;

/** Версия Graph API для публикации каруселей (Reels живут на своей версии в lib/publish.ts). */
export const IG_API_VERSION = "v25.0";

export const CAROUSEL_LIMITS = {
  minSlides: 3,
  maxSlides: IG_LIMITS.maxItems,
  defaultSlides: 7,
  ideaMin: 3,
  ideaMax: 1500,
  wishesMax: 1500,
  instructionMax: 800,
  hintMax: 400,
  footerMax: 40,
  titleMax: 90,
  claimsMax: 12,
  /** очередь заданий на весь раздел: генерация не должна копиться без предела */
  maxQueuedJobs: 20,
} as const;

export const FORMATS: Record<CarouselFormat, { width: number; height: number; label: string }> = {
  portrait: { width: 1080, height: 1350, label: "4:5 · 1080×1350" },
  square: { width: 1080, height: 1080, label: "1:1 · 1080×1080" },
};

export const LANGUAGES: Record<CarouselLanguage, { label: string; prompt: string; swipe: string }> = {
  ru: { label: "Русский", prompt: "на русском языке", swipe: "Листай" },
  uk: { label: "Українська", prompt: "українською мовою", swipe: "Гортай" },
  en: { label: "English", prompt: "in English", swipe: "Swipe" },
};

/**
 * Пределы длины полей карточки в символах. Это ориентир для Claude и счётчики редактора;
 * окончательно помещается ли текст, решает рендер (он проверяет переполнение).
 */
export const TEXT_LIMITS: Record<SlideKind, { kicker: number; title: number; body: number; bodyWithBullets: number; bullet: number; bullets: number; cta: number }> = {
  cover: { kicker: 32, title: 80, body: 100, bodyWithBullets: 0, bullet: 0, bullets: 0, cta: 0 },
  content: { kicker: 28, title: 70, body: 200, bodyWithBullets: 90, bullet: 70, bullets: 4, cta: 0 },
  final: { kicker: 28, title: 70, body: 160, bodyWithBullets: 0, bullet: 0, bullets: 0, cta: 50 },
};

/** Жёсткий потолок ручного ввода: защищает хранилище, а не вёрстку. */
export const HARD_FIELD_MAX = 600;

export function isFormat(v: unknown): v is CarouselFormat {
  return v === "portrait" || v === "square";
}

export function isLanguage(v: unknown): v is CarouselLanguage {
  return v === "ru" || v === "uk" || v === "en";
}
