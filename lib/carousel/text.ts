import type { CarouselLanguage } from "./types";
import { IG_LIMITS } from "./limits";

/**
 * Текст карточек и подписи. Модель пишет содержание, а нормализация здесь: на карточках нет
 * эмодзи и управляющих символов (шрифты их не содержат — вместо буквы вышел бы квадрат),
 * короткие слова не висят в конце строки, хэштеги приводятся к виду, который принимает Instagram.
 */

const NBSP = "\u00A0";
const PICTO_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|\u20E3)/gu;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u2060\uFEFF]/g;

/** Строка для карточки: без эмодзи и управляющих символов, пробелы схлопнуты. */
export function cleanText(value: unknown, opts: { multiline?: boolean; max?: number } = {}): string {
  let s = typeof value === "string" ? value : value == null ? "" : String(value);
  s = s.normalize("NFC").replace(/\r\n?/g, "\n").replace(CONTROL_RE, "").replace(PICTO_RE, "");
  // знака рубля нет в текстовом шрифте карточек
  s = s.replace(/(\d)\s*₽/g, "$1 руб.").replace(/₽/g, "руб.");
  if (opts.multiline) {
    s = s
      .split("\n")
      .map((l) => l.replace(/[ \t\u00A0]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    s = s.replace(/\s+/g, " ").trim();
  }
  if (opts.max && s.length > opts.max) s = s.slice(0, opts.max).trimEnd();
  return s;
}

/** Подпись к посту: эмодзи и переносы строк остаются, мусорные символы — нет. */
export function cleanCaption(value: unknown, max = 4000): string {
  let s = typeof value === "string" ? value : value == null ? "" : String(value);
  s = s.normalize("NFC").replace(/\r\n?/g, "\n").replace(CONTROL_RE, "");
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

/** Хэштеги в самом конце подписи — отдельный список, а не часть текста. */
export function splitTrailingHashtags(caption: string): { caption: string; tags: string[] } {
  const m = caption.match(/(?:^|\s)((?:#[\p{L}\p{N}_]+\s*)+)$/u);
  if (!m || m.index === undefined) return { caption, tags: [] };
  return { caption: caption.slice(0, m.index).trim(), tags: m[1].split(/\s+/).filter(Boolean) };
}

/**
 * Типографика для вёрстки: неразрывный пробел после коротких слов и перед тире,
 * число не отрывается от следующего слова. Для английского — только тире и числа.
 */
export function typograph(s: string, lang: CarouselLanguage): string {
  let t = s.replace(/ -{1,2} /g, " — ").replace(/ —/g, `${NBSP}—`);
  if (lang !== "en") {
    const short = /(^|[\s\u00A0(«„"])([А-Яа-яЁёІіЇїЄєҐґA-Za-z]{1,2}) (?=[^\s—])/g;
    // один проход: цепочка коротких слов («Вы не ленивые —») не склеивается в неразрывный кусок шире строки
    t = t.replace(short, `$1$2${NBSP}`);
  }
  return t.replace(/(\d) (?=[^\s\d—])/g, `$1${NBSP}`);
}

/** **двойные звёздочки** — акцент в заголовке. Непарные звёздочки выделением не считаются. */
export function emphasisParts(s: string): { text: string; hl: boolean }[] {
  const pieces = s.split("**");
  if (pieces.length < 3 || pieces.length % 2 === 0) return [{ text: stripEmphasis(s), hl: false }];
  return pieces.map((text, i) => ({ text, hl: i % 2 === 1 })).filter((p) => p.text.length > 0);
}

export function stripEmphasis(s: string): string {
  return s.replace(/\*\*/g, "");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Хэштеги из массива или строки: без повторов, только буквы, цифры и подчёркивание. */
export function normalizeHashtags(value: unknown, max: number = IG_LIMITS.maxHashtags): string[] {
  const raw = Array.isArray(value) ? value.map((v) => String(v ?? "")) : typeof value === "string" ? [value] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of raw) {
    for (const part of chunk.split(/[\s,;]+/)) {
      const tag = part.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 60);
      if (!tag || /^\d+$/.test(tag)) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`#${tag}`);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Итоговая подпись поста: текст, пустая строка, хэштеги. */
export function composeCaption(caption: string, hashtags: string[]): string {
  return [caption.trim(), hashtags.join(" ").trim()].filter(Boolean).join("\n\n");
}

export function countHashtags(text: string): number {
  return (text.match(/(?:^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu) ?? []).length;
}

export function countMentions(text: string): number {
  return (text.match(/(?:^|[^\p{L}\p{N}_.@])@[A-Za-z0-9_.]{1,30}/gu) ?? []).length;
}

/** Проблемы подписи по правилам Instagram; длина считается в UTF-16 — не меньше, чем считает Instagram. */
export function captionProblems(caption: string, hashtags: string[]): string[] {
  const full = composeCaption(caption, hashtags);
  const p: string[] = [];
  if (full.length > IG_LIMITS.captionMaxChars) p.push(`подпись ${full.length} символов при пределе ${IG_LIMITS.captionMaxChars}`);
  const tags = countHashtags(full);
  if (tags > IG_LIMITS.maxHashtags) p.push(`хэштегов ${tags} при пределе ${IG_LIMITS.maxHashtags}`);
  const mentions = countMentions(full);
  if (mentions > IG_LIMITS.maxMentions) p.push(`упоминаний ${mentions} при пределе ${IG_LIMITS.maxMentions}`);
  return p;
}

/** Длина видимого текста поля: звёздочки акцента не считаются. */
export function visibleLength(s: string): number {
  return [...stripEmphasis(s)].length;
}

/**
 * Две формулировки об одном и том же: доля общих основ слов (первые 6 букв слов от 4 букв)
 * от меньшего набора. Грубо, но ловит «повтор другими словами», который модель любит делать.
 */
export function tooSimilar(a: string, b: string): boolean {
  const words = (x: string) =>
    stripEmphasis(x)
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .map((w) => w.slice(0, 6));
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (A.size < 3 || B.size < 3) {
    const na = stripEmphasis(a).trim().toLowerCase();
    return na.length > 0 && na === stripEmphasis(b).trim().toLowerCase();
  }
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size) >= 0.75;
}
