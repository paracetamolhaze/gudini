import type { CarouselStyleId } from "./types";

/** Визуальные стили карточек. Данные без кода: одни и те же для шаблона рендера и для интерфейса. */
export type CarouselStyle = {
  id: CarouselStyleId;
  label: string;
  description: string;
  /** CSS-фон карточки целиком */
  background: string;
  text: string;
  dim: string;
  accent: string;
  accentInk: string;
  line: string;
  chipBg: string;
  chipText: string;
  titleFont: "display" | "condensed";
  titleUpper: boolean;
  emphasis: "color" | "marker";
  deco: "rings" | "paper" | "glow" | "grid" | "stripe";
  /** тёмный фон: полупрозрачные украшения светлые */
  dark: boolean;
  swatch: [string, string, string];
};

export const CAROUSEL_STYLES: CarouselStyle[] = [
  {
    id: "graphite",
    label: "Графит",
    description: "Тёмный фон, лавандовый акцент, спокойный экспертный тон",
    background: "radial-gradient(120% 80% at 100% 0%, #28243b 0%, #16171c 55%, #111216 100%)",
    text: "#f6f4ef",
    dim: "#c6c7d0",
    accent: "#c0b4ff",
    accentInk: "#1d1638",
    line: "rgba(255,255,255,0.14)",
    chipBg: "rgba(192,180,255,0.16)",
    chipText: "#d9d2ff",
    titleFont: "display",
    titleUpper: false,
    emphasis: "color",
    deco: "rings",
    dark: true,
    swatch: ["#16171c", "#c0b4ff", "#f6f4ef"],
  },
  {
    id: "paper",
    label: "Бумага",
    description: "Тёплый светлый фон, чёрный текст, терракотовый акцент",
    background: "#f3eee4",
    text: "#1d1b18",
    dim: "#4a453d",
    accent: "#d24a26",
    accentInk: "#ffffff",
    line: "rgba(29,27,24,0.14)",
    chipBg: "rgba(210,74,38,0.12)",
    chipText: "#b23d1d",
    titleFont: "display",
    titleUpper: false,
    emphasis: "color",
    deco: "paper",
    dark: false,
    swatch: ["#f3eee4", "#d24a26", "#1d1b18"],
  },
  {
    id: "sunset",
    label: "Закат",
    description: "Яркий градиент для лайфстайла и мотивации",
    background: "linear-gradient(155deg, #ff8a5b 0%, #d6457a 52%, #4b2a86 100%)",
    text: "#ffffff",
    dim: "#fff4f7",
    accent: "#ffe36e",
    accentInk: "#2d1745",
    line: "rgba(255,255,255,0.3)",
    chipBg: "rgba(45,23,69,0.28)",
    chipText: "#ffffff",
    titleFont: "display",
    titleUpper: false,
    emphasis: "color",
    deco: "glow",
    dark: true,
    swatch: ["#ff8a5b", "#d6457a", "#ffe36e"],
  },
  {
    id: "ocean",
    label: "Океан",
    description: "Глубокий сине-зелёный, узкие заголовки, технологичный тон",
    background: "linear-gradient(170deg, #0b2533 0%, #0f4455 58%, #136b69 100%)",
    text: "#eefaf7",
    dim: "#c4e3dd",
    accent: "#7ef0c4",
    accentInk: "#062a24",
    line: "rgba(126,240,196,0.16)",
    chipBg: "rgba(126,240,196,0.14)",
    chipText: "#9ff5d4",
    titleFont: "condensed",
    titleUpper: true,
    emphasis: "color",
    deco: "grid",
    dark: true,
    swatch: ["#0b2533", "#136b69", "#7ef0c4"],
  },
  {
    id: "contrast",
    label: "Контраст",
    description: "Белый фон, чёрный текст, жёлтый маркер",
    background: "#ffffff",
    text: "#0c0c0d",
    dim: "#34343a",
    accent: "#ffd60a",
    accentInk: "#0c0c0d",
    line: "rgba(12,12,13,0.12)",
    chipBg: "#0c0c0d",
    chipText: "#ffffff",
    titleFont: "condensed",
    titleUpper: true,
    emphasis: "marker",
    deco: "stripe",
    dark: false,
    swatch: ["#ffffff", "#ffd60a", "#0c0c0d"],
  },
];

export const DEFAULT_STYLE: CarouselStyleId = "graphite";

export function isStyleId(v: unknown): v is CarouselStyleId {
  return typeof v === "string" && CAROUSEL_STYLES.some((s) => s.id === v);
}

export function getStyle(id: CarouselStyleId): CarouselStyle {
  return CAROUSEL_STYLES.find((s) => s.id === id) ?? CAROUSEL_STYLES[0];
}
