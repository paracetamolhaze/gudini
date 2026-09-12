import type { CarouselRequest } from "./types";
import { CAROUSEL_LIMITS, IG_LIMITS, isFormat, isLanguage } from "./limits";
import { DEFAULT_STYLE, isStyleId } from "./styles";
import { cleanText } from "./text";

/** Проверка формы создания карусели. Ошибка — готовая фраза для пользователя. */
export function parseCreateRequest(body: any): { request: CarouselRequest } | { error: string } {
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

  return { request: { idea, wishes, slideCount, language, style, format } };
}
