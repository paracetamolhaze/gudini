import type { CarouselMode, CarouselRequest, ImageModelId } from "./types";
import { CAROUSEL_LIMITS, IG_LIMITS, isFormat, isLanguage } from "./limits";
import { DEFAULT_STYLE, isStyleId } from "./styles";
import { IMAGE_MODELS, isImageModelId } from "./models";
import { cleanText } from "./text";

export type ParsedCreate = { request: CarouselRequest; mode: CarouselMode; imageModel?: ImageModelId };

/**
 * Проверка формы создания карусели. Ошибка — готовая фраза для пользователя.
 * Новый сценарий — с иллюстрациями; mode="text_cards" оставлен для прежних текстовых карточек.
 */
export function parseCreateRequest(body: any, defaults: { imageModel: ImageModelId | null } = { imageModel: null }): ParsedCreate | { error: string } {
  const idea = cleanText(body?.idea, { multiline: true });
  if (idea.length < CAROUSEL_LIMITS.ideaMin) return { error: "Опишите идею карусели — хотя бы несколько слов" };
  if (idea.length > CAROUSEL_LIMITS.ideaMax) return { error: `Идея длиннее ${CAROUSEL_LIMITS.ideaMax} символов — сократите` };

  const wishes = cleanText(body?.wishes, { multiline: true });
  if (wishes.length > CAROUSEL_LIMITS.wishesMax) return { error: `Пожелания длиннее ${CAROUSEL_LIMITS.wishesMax} символов — сократите` };

  const rawCount = body?.slideCount;
  const slideCount = rawCount === undefined || rawCount === null || rawCount === "" ? CAROUSEL_LIMITS.defaultSlides : Number(rawCount);
  if (!Number.isInteger(slideCount) || slideCount < CAROUSEL_LIMITS.minSlides || slideCount > CAROUSEL_LIMITS.maxSlides) {
    return { error: `Количество слайдов — от ${CAROUSEL_LIMITS.minSlides} до ${CAROUSEL_LIMITS.maxSlides}: Instagram принимает в карусели не больше ${IG_LIMITS.maxItems} картинок` };
  }

  const language = body?.language ?? "ru";
  if (!isLanguage(language)) return { error: "Неизвестный язык" };
  const style = body?.style ?? DEFAULT_STYLE;
  if (!isStyleId(style)) return { error: "Неизвестный визуальный стиль" };
  const format = body?.format ?? "portrait";
  if (!isFormat(format)) return { error: "Неизвестный формат" };

  const mode: CarouselMode = body?.mode === "text_cards" ? "text_cards" : "illustrated";
  const request: CarouselRequest = { idea, wishes, slideCount, language, style, format };
  if (mode === "text_cards") return { request, mode };

  const rawModel = body?.imageModel ?? defaults.imageModel;
  if (!rawModel) return { error: "Не задана модель изображений (CAROUSEL_IMAGE_MODEL)" };
  if (!isImageModelId(rawModel)) return { error: `Модель изображений «${String(rawModel).slice(0, 60)}» не поддерживается разделом (доступны: ${Object.values(IMAGE_MODELS).map((m) => m.label).join(", ")})` };
  request.imageModel = rawModel;
  return { request, mode, imageModel: rawModel };
}
