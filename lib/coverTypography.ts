import type { HeadlineLine } from "./coverLayout";

/**
 * Hybrid cover pipeline — выбор способа отрисовки заголовка обложки.
 * FULL_AI: image-модель рисует обложку целиком, включая типографику
 *   (короткие ударные headline — эталон: «ДЕТИ / НА ЗАКАЗ / БОГАТЫМ»).
 * RENDERER_TEXT: image-модель рисует только key art без текста, заголовок кладёт
 *   наш детерминированный рендерер (coverLayout) — для цифр, валют и сложных
 *   конструкций, где у модели есть риск перепутать символы («5000$ / СТАЛИ / 300$»).
 *
 * Почему эталон FULL_AI — ряд «генетика» из бенчмарка: короткий headline (4 слова),
 * одна жёлтая плашка-акцент, чистый фон, читаемый контраст, ясная иерархия строк.
 */
export type CoverTypographyMode = "FULL_AI" | "RENDERER_TEXT";

export type TypographyModeChoice = {
  mode: CoverTypographyMode;
  /** причины, по которым headline отдан рендереру (пусто для FULL_AI) */
  reasons: string[];
};

// Служебные связки: одна допустима («ДЕТИ НА ЗАКАЗ»), россыпь мелких слов
// («ТИГР ВО ДВОРЕ НЕ БЕГИ») делает AI-типографику рыхлой и хуже читаемой.
const SERVICE_WORDS = new Set([
  "И", "А", "В", "ВО", "НА", "НЕ", "НИ", "С", "СО", "К", "КО", "У", "О", "ОБ", "ЗА", "ИЗ", "ДО", "ПО", "ОТ",
]);

const MAX_WORDS_FULL_AI = 5;
const MAX_LINES_FULL_AI = 4;
const MAX_CHARS_FULL_AI = 24; // букв без пробелов
const MAX_DIGITS_IN_NUMBER = 2; // «80 ЛЕТ» — ок; «5000$» — рендерер

/** Решает, можно ли доверить этот headline AI-типографике. */
export function selectTypographyMode(lines: HeadlineLine[]): TypographyModeChoice {
  const words = lines.flatMap((l) => l.text.trim().split(/\s+/).filter(Boolean));
  const text = words.join(" ");
  const reasons: string[] = [];

  if (/[$%€₽№#]/.test(text)) reasons.push("валюта/проценты — риск порчи символов");
  const numbers = text.match(/\d+/g) ?? [];
  if (numbers.some((n) => n.length > MAX_DIGITS_IN_NUMBER))
    reasons.push(`длинное число (${numbers.find((n) => n.length > MAX_DIGITS_IN_NUMBER)}) — риск порчи цифр`);
  if (numbers.length > 1) reasons.push("больше одного числа — сложная числовая конструкция");
  if (/[→←↓↑=+*\/\\|<>]/.test(text)) reasons.push("спецсимволы — модель их искажает");
  if (words.length > MAX_WORDS_FULL_AI) reasons.push(`слов ${words.length} > ${MAX_WORDS_FULL_AI}`);
  if (lines.length > MAX_LINES_FULL_AI) reasons.push(`строк ${lines.length} > ${MAX_LINES_FULL_AI}`);
  const letters = text.replace(/\s+/g, "").length;
  if (letters > MAX_CHARS_FULL_AI) reasons.push(`символов ${letters} > ${MAX_CHARS_FULL_AI}`);
  const service = words.filter((w) => SERVICE_WORDS.has(w.toUpperCase()));
  if (service.length > 1) reasons.push(`служебных слов ${service.length} (${service.join(", ")}) — перегруженная структура`);

  return reasons.length ? { mode: "RENDERER_TEXT", reasons } : { mode: "FULL_AI", reasons: [] };
}
