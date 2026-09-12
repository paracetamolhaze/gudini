import type { Carousel } from "./types";
import { CAROUSEL_LIMITS, HARD_FIELD_MAX } from "./limits";
import { isStyleId } from "./styles";
import { cleanCaption, cleanText, normalizeHashtags } from "./text";
import { CarouselError } from "./store";
import { slideHash } from "./templates";

function snapshot(c: Carousel) {
  return JSON.stringify([c.title, c.caption, c.hashtags, c.footer, c.style, c.slides.map((s) => [s.id, s.kicker, s.title, s.body, s.bullets, s.cta])]);
}

/**
 * Ручная правка из редактора. Применяется к карусели, открытой под блокировкой.
 * Ревизия обязательна: правка поверх изменений из другого окна или фонового задания
 * отклоняется, а не затирает их молча.
 */
export function applyManualEdit(c: Carousel, body: Record<string, any>): { contentChanged: boolean; renderNeeded: boolean } {
  if (typeof body.revision !== "number" || body.revision !== c.revision) {
    throw new CarouselError(
      "Карусель изменилась после загрузки страницы (другое окно или фоновое задание). Обновите страницу — несохранённый черновик восстановится.",
      409,
      "stale_revision",
    );
  }
  const before = snapshot(c);

  if (body.title !== undefined) {
    const title = cleanText(body.title, { max: CAROUSEL_LIMITS.titleMax });
    if (!title) throw new CarouselError("Название не может быть пустым", 400, "bad_title");
    c.title = title;
  }
  if (body.caption !== undefined) c.caption = cleanCaption(body.caption, 3000);
  if (body.hashtags !== undefined) c.hashtags = normalizeHashtags(body.hashtags);
  if (body.footer !== undefined) c.footer = cleanText(body.footer, { max: CAROUSEL_LIMITS.footerMax });
  if (body.style !== undefined) {
    if (!isStyleId(body.style)) throw new CarouselError("Неизвестный стиль", 400, "bad_style");
    c.style = body.style;
  }

  if (body.slides !== undefined) {
    if (!Array.isArray(body.slides)) throw new CarouselError("slides — список правок", 400, "bad_slides");
    for (const patch of body.slides) {
      const slide = c.slides.find((s) => s.id === patch?.id);
      if (!slide) throw new CarouselError("Слайд не найден — обновите страницу", 409, "slide_missing");
      const n = c.slides.indexOf(slide) + 1;
      if (patch.kicker !== undefined) slide.kicker = cleanText(patch.kicker, { max: HARD_FIELD_MAX });
      if (patch.title !== undefined) {
        const title = cleanText(patch.title, { max: HARD_FIELD_MAX });
        if (!title) throw new CarouselError(`У слайда ${n} пустой заголовок`, 400, "bad_title");
        slide.title = title;
      }
      if (patch.body !== undefined) slide.body = cleanText(patch.body, { max: HARD_FIELD_MAX });
      if (patch.bullets !== undefined && slide.kind === "content") {
        const list: unknown[] = Array.isArray(patch.bullets) ? patch.bullets : [];
        slide.bullets = list.map((b) => cleanText(b, { max: HARD_FIELD_MAX })).filter(Boolean).slice(0, 6);
      }
      if (patch.cta !== undefined && slide.kind === "final") slide.cta = cleanText(patch.cta, { max: HARD_FIELD_MAX });
    }
  }

  if (body.order !== undefined) {
    const order = body.order;
    const valid =
      Array.isArray(order) &&
      order.length === c.slides.length &&
      new Set(order).size === order.length &&
      order.every((id: unknown) => c.slides.some((s) => s.id === id));
    if (!valid) throw new CarouselError("Порядок слайдов не совпадает с текущими — обновите страницу", 409, "bad_order");
    const next = (order as string[]).map((id) => c.slides.find((s) => s.id === id)!);
    if (next[0].kind !== "cover" || next[next.length - 1].kind !== "final") {
      throw new CarouselError("Обложка остаётся первой, а заключительный слайд — последним", 400, "bad_order");
    }
    c.slides = next;
  }

  const total = c.slides.length;
  return {
    contentChanged: snapshot(c) !== before,
    renderNeeded: c.slides.some((s, i) => !s.render || s.render.hash !== slideHash(c, s, i, total)),
  };
}
