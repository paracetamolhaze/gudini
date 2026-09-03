/**
 * Геометрия верхней иллюстративной вставки.
 *
 * Автор — главный слой ролика и виден почти всё время. Внешний материал не
 * перекрывает экран, а показывается отдельным прямоугольником сверху, как
 * подпись к речи. Поэтому размеры и позиция считаются здесь ДЕТЕРМИНИРОВАННЫМ
 * кодом: модель выбирает, ЧТО показать, но не где и какого размера.
 *
 * Один и тот же расчёт используют рендерер и проверка результата — иначе они
 * будут спорить о том, где искать вставку.
 */

/** Границы области вставки в кадре 1080×1920. */
export const INSET = {
  frameW: 1080,
  frameH: 1920,
  /** предельный размер области: шире и выше вставка не бывает */
  maxW: 900,
  maxH: 520,
  /** верхняя координата области */
  top: 130,
} as const;

export type InsetBox = { x: number; y: number; w: number; h: number };

/**
 * Вписывает материал в область вставки, сохраняя пропорции.
 *
 * Растягивать нельзя: горизонтальный кадр останется горизонтальным, вертикальный
 * упрётся в высоту и станет уже. Ширина поэтому меняется от материала к материалу,
 * и это нормально.
 */
export function insetBox(srcW: number, srcH: number): InsetBox {
  const safeW = Math.max(1, Math.round(srcW || INSET.maxW));
  const safeH = Math.max(1, Math.round(srcH || INSET.maxH));
  const scale = Math.min(INSET.maxW / safeW, INSET.maxH / safeH);
  // чётные размеры: кодек не любит нечётную ширину или высоту
  const w = Math.max(2, Math.round((safeW * scale) / 2) * 2);
  const h = Math.max(2, Math.round((safeH * scale) / 2) * 2);
  return { x: Math.round((INSET.frameW - w) / 2), y: INSET.top, w, h };
}

/**
 * Нижняя граница вставки. Ниже неё начинается зона автора и субтитров,
 * которую вставка не имеет права занимать.
 */
export function insetBottom(box: InsetBox): number {
  return box.y + box.h;
}

/** Область автора, которая обязана оставаться видимой. */
export const AUTHOR_SAFE_TOP = INSET.top + INSET.maxH; // 650

/**
 * Фильтр ffmpeg для одной вставки: масштаб с сохранением пропорций.
 * Без обрезки, без размытого фона, без движения — только вписывание.
 */
export function insetScaleFilter(box: InsetBox): string {
  return `scale=${box.w}:${box.h}:force_original_aspect_ratio=decrease,setsar=1`;
}

/** Та же геометрия для проверки: как вырезать область вставки из готового кадра. */
export function insetCropFilter(box: InsetBox): string {
  return `crop=${box.w}:${box.h}:${box.x}:${box.y}`;
}
