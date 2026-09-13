import type { Carousel, Slide } from "./types";
import { slideHash } from "./templates";
import { illustratedHash } from "./illustrated";
import { DEFAULT_DESIGN } from "./designShared";

/** Отпечаток готовой карточки: у текстовых карточек — шаблон цвета, у иллюстрированных — картинка и оформление. */
export function slideContentHash(c: Pick<Carousel, "mode" | "style" | "format" | "language" | "footer" | "design">, slide: Slide, index: number, total: number): string {
  if (c.mode === "illustrated") return illustratedHash({ format: c.format, language: c.language, design: c.design ?? DEFAULT_DESIGN }, slide, index, total);
  return slideHash(c, slide, index, total);
}
