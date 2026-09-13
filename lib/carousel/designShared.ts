import type { DesignSettings } from "./types";
import { cleanText } from "./text";

/**
 * Оформление аккаунта для карточек с иллюстрациями. Данные без файловых операций —
 * одинаковы для сервера и страницы настроек. Не заданы — нейтральный вариант ниже.
 */

export const DEFAULT_DESIGN: DesignSettings = {
  accent: "#F5C451",
  textColor: "#FFFFFF",
  scrimColor: "#0B0B10",
  titleFont: "display",
  author: "",
  illustrationStyle: "Современная редакционная иллюстрация: мягкий объёмный свет, чистые формы, выразительная композиция, спокойный фон без мелкого шума",
};

export const DESIGN_LIMITS = { authorMax: 40, styleMax: 400, logoMaxBytes: 1024 * 1024, referenceMaxBytes: 6 * 1024 * 1024 };

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Проверка правки оформления; файлы логотипа и референса меняются отдельными запросами. */
export function mergeDesign(current: DesignSettings, patch: Record<string, unknown>): { design: DesignSettings } | { error: string } {
  const next: DesignSettings = { ...current };
  for (const key of ["accent", "textColor", "scrimColor"] as const) {
    if (patch[key] === undefined) continue;
    const v = String(patch[key]).trim();
    if (!HEX_RE.test(v)) return { error: "Цвет задаётся в виде #RRGGBB" };
    next[key] = v.toUpperCase();
  }
  if (patch.titleFont !== undefined) {
    if (patch.titleFont !== "display" && patch.titleFont !== "condensed") return { error: "Неизвестный шрифт заголовков" };
    next.titleFont = patch.titleFont;
  }
  if (patch.author !== undefined) next.author = cleanText(patch.author, { max: DESIGN_LIMITS.authorMax });
  if (patch.illustrationStyle !== undefined) next.illustrationStyle = cleanText(patch.illustrationStyle, { max: DESIGN_LIMITS.styleMax });
  return { design: next };
}

/** Относительная яркость цвета: светлый акцент получает тёмный текст кнопки. */
export function isLightColor(hex: string): boolean {
  const m = HEX_RE.exec(hex) ? hex.slice(1) : "000000";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45;
}

export function hexToRgba(hex: string, alpha: number): string {
  const m = HEX_RE.exec(hex) ? hex.slice(1) : "000000";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}
