import type { Carousel, DesignSettings } from "./types";
import { CAROUSEL_LIMITS, HARD_FIELD_MAX } from "./limits";
import { isStyleId } from "./styles";
import { isImageModelId } from "./models";
import { cleanCaption, cleanText, normalizeHashtags } from "./text";
import { CarouselError } from "./store";
import { slideContentHash } from "./hash";

function snapshot(c: Carousel) {
  return JSON.stringify([
    c.title,
    c.caption,
    c.hashtags,
    c.footer,
    c.style,
    c.imageModel,
    c.design,
    c.slides.map((s) => [s.id, s.kicker, s.title, s.body, s.bullets, s.cta, s.image?.brief, s.image?.composition, s.image?.textPlacement, s.image?.currentId]),
  ]);
}

/**
 * Ручная правка из редактора. Применяется к карусели, открытой под блокировкой.
 * Ревизия обязательна: правка поверх изменений из другого окна или фонового задания
 * отклоняется, а не затирает их молча. Текст и выбор версии картинки меняются без
 * обращения к генератору — рендер карточки пересобирается по новому отпечатку.
 */
export function applyManualEdit(c: Carousel, body: Record<string, any>, opts: { design?: DesignSettings } = {}): { contentChanged: boolean; renderNeeded: boolean } {
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
  if (body.imageModel !== undefined) {
    if (!isImageModelId(body.imageModel)) throw new CarouselError("Неизвестная модель изображений", 400, "bad_model");
    c.imageModel = body.imageModel;
  }
  if (body.applyDesign === true) {
    if (c.mode !== "illustrated") throw new CarouselError("Оформление аккаунта применяется к каруселям с иллюстрациями", 400, "bad_mode");
    if (!opts.design) throw new CarouselError("Оформление аккаунта не загружено", 500, "no_design");
    c.design = opts.design;
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

      const img = slide.image;
      if (patch.textPlacement !== undefined || patch.imageBrief !== undefined || patch.imageComposition !== undefined || patch.imageVersionId !== undefined) {
        if (!img) throw new CarouselError(`У слайда ${n} нет иллюстрации`, 400, "no_image");
        let touched = false;
        if (patch.textPlacement !== undefined) {
          if (patch.textPlacement !== "top" && patch.textPlacement !== "bottom") throw new CarouselError("Место текста — top или bottom", 400, "bad_placement");
          if (img.textPlacement !== patch.textPlacement) {
            img.textPlacement = patch.textPlacement;
            touched = true;
          }
        }
        if (patch.imageBrief !== undefined) {
          const brief = cleanText(patch.imageBrief, { max: 700 });
          if (brief.length < 10) throw new CarouselError(`Описание иллюстрации слайда ${n} слишком короткое`, 400, "bad_brief");
          if (brief !== img.brief) {
            img.brief = brief;
            touched = true;
          }
        }
        if (patch.imageComposition !== undefined) {
          const composition = cleanText(patch.imageComposition, { max: 700 });
          if (composition !== img.composition) {
            img.composition = composition;
            touched = true;
          }
        }
        if (patch.imageVersionId !== undefined) {
          const v = img.versions.find((x) => x.id === patch.imageVersionId);
          if (!v) throw new CarouselError(`Версия иллюстрации слайда ${n} не найдена`, 404, "version_missing");
          if (img.currentId !== v.id) {
            img.currentId = v.id;
            img.status = "ready";
            img.error = undefined;
            touched = true;
          }
        }
        // любая правка слайда делает ответ уже идущей генерации «устаревшим»: он сохранится версией, но текущей не станет
        if (touched) img.rev += 1;
      }
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
    renderNeeded: c.slides.some((s, i) => !s.render || s.render.hash !== slideContentHash(c, s, i, total)),
  };
}
