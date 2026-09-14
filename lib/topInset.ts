/**
 * Верхняя карточка-иллюстрация и область автора.
 *
 * Автор — главный слой ролика. Внешний материал показывается СТРОГО одинаковой
 * карточкой в верхней части кадра: одинаковый размер, одинаковое место, всегда
 * 16:9. Прошлая версия вписывала материал «как получится», и в одном ролике
 * оказались широкое фото и узкие вертикальные полоски — смотреть на такое нельзя.
 *
 * В новом плане геометрия выбирается по положению головы автора и сохраняется
 * в EditPlan.cardRect на весь ролик. CARD — исходный формат подготовки медиатеки
 * и совместимость со старыми планами без измерения головы.
 * Материал приводится к ней масштабированием с сохранением пропорций и аккуратной
 * обрезкой: ничего не растягивается, чёрных полей не возникает.
 *
 * Один и тот же расчёт используют подготовка материала, рендерер и проверка
 * результата — иначе они будут спорить о том, где искать картинку.
 */

export const FRAME = { w: 1080, h: 1920 } as const;

/** Исходная карточка медиатеки; итоговый размер записи хранится в EditPlan.cardRect. */
export const CARD = { w: 900, h: 506, x: 90, y: 120 } as const;
export type CardRect = { w: number; h: number; x: number; y: number };
export const cardFilter = (c: CardRect) => `scale=${c.w}:${c.h}:force_original_aspect_ratio=increase,crop=${c.w}:${c.h}:(iw-${c.w})/2:(ih-${c.h})*0.15`;
export const cardCrop = (c: CardRect) => `crop=${c.w}:${c.h}:${c.x}:${c.y}`;

/** Stable geometry for the whole recording, with space above the highest sampled crown. */
export function cardAboveHead(headTop: number): CardRect {
  if (!Number.isFinite(headTop) || headTop < 0 || headTop > 1920) throw new Error("Некорректная граница головы");
  const y = 48, clearance = 72;
  const w = Math.min(780, Math.floor((headTop - clearance - y) * 16 / 9 / 2) * 2);
  if (w < 320) throw new Error("Над головой недостаточно места для читаемой картинки; нужен кадр с большим пространством сверху");
  return { w, h: Math.floor(w * 9 / 16 / 2) * 2, x: (1080 - w) / 2, y };
}

/** Минимальный исходник: мельче — это уже мыло на экране. */
/**
 * Минимальный исходник: карточка 900×506, увеличение до 1.5× на телефоне терпимо
 * (600×338 → 900×506). У объясняющих тем половина найденных фото — обычные картинки из
 * статей 600–800 px, и порог 1.3 отбрасывал 84 из 166 проверенных.
 * Строгий порог «не меньше карточки» отбраковывал 43 из 98 проверенных веб-картинок
 * в «Одиссее» Нолана — портретные фото актёров 800×1200 не проходили по ширине.
 */
export const MIN_SOURCE = { w: Math.round(CARD.w / 1.5), h: Math.round(CARD.h / 1.5) } as const;
/** Желательный исходник. */
export const GOOD_SOURCE = { w: 1280, h: 720 } as const;

/**
 * Приведение любого материала к карточке.
 * increase + crop: сначала покрываем всю карточку, потом обрезаем лишнее.
 * decrease здесь запрещён — он оставляет поля и даёт разный размер.
 */
/**
 * Приведение любого изображения к карточке: масштаб «накрыть» и обрезка. Обрезка
 * смещена к верху (15% лишней высоты сверху, а не 50%): у портретных фото лицо в
 * верхней трети, и центральный кроп оставлял в карточке туловище без головы.
 * Для горизонтальных 16:9 источников лишней высоты нет — смещение не работает.
 */
export const CARD_FILTER = `scale=${CARD.w}:${CARD.h}:force_original_aspect_ratio=increase,crop=${CARD.w}:${CARD.h}:(iw-${CARD.w})/2:(ih-${CARD.h})*0.15`;

/**
 * Портретная картинка (постер, портрет актёра): целиком по высоте карточки на размытой
 * копии себя по бокам. Обрезка до 16:9 оставляла от постера середину без названия,
 * а от портрета — фрагмент.
 */
export const PORTRAIT_CARD_FILTER =
  `split[bg][fg];[bg]scale=${CARD.w}:${CARD.h}:force_original_aspect_ratio=increase,crop=${CARD.w}:${CARD.h},gblur=sigma=24,eq=brightness=-0.08[bgb];` +
  `[fg]scale=-2:${CARD.h}[fgs];[bgb][fgs]overlay=(W-w)/2:0,setsar=1`;
export function isPortraitSource(w: number, h: number): boolean {
  return w > 0 && h > 0 && h > w * 1.15;
}
/** Портрет показывается целиком по высоте: ширина может быть заметно меньше карточки. */
export function portraitBigEnough(w: number, h: number): boolean {
  return h >= MIN_SOURCE.h && w >= Math.round(MIN_SOURCE.h * 0.55);
}

/** Область карточки в готовом кадре — для проверки результата. */
export const CARD_CROP = `crop=${CARD.w}:${CARD.h}:${CARD.x}:${CARD.y}`;

/** Зона автора, которая обязана оставаться видимой под карточкой. */
export const AUTHOR_SAFE_TOP = CARD.y + CARD.h; // 626
export const AUTHOR_CROP = `crop=${FRAME.w}:${FRAME.h - AUTHOR_SAFE_TOP}:0:${AUTHOR_SAFE_TOP}`;

/** Годится ли исходник по размеру. */
export function sourceBigEnough(w: number, h: number): boolean {
  return w >= MIN_SOURCE.w && h >= MIN_SOURCE.h;
}

/** Один способ вписать автора для монтажа и проверки результата обоих стилей. */
export function authorFitFilter(displayWidth: number, displayHeight: number): string {
  const target = 1080 / 1920;
  const ratio = displayWidth > 0 && displayHeight > 0 ? displayWidth / displayHeight : target;
  if (Math.abs(ratio - target) / target < 0.02) return "scale=1080:1920:flags=lanczos,setsar=1";
  return (
    "split[fitbg][fitfg];" +
    "[fitbg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28,eq=brightness=-0.12:saturation=0.75[fitbgb];" +
    "[fitfg]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos[fitfgs];" +
    "[fitbgb][fitfgs]overlay=(W-w)/2:(H-h)/2,setsar=1"
  );
}
