import fs from "fs";
import path from "path";
import { breakHeadline } from "./coverLayout";
import type { CoverConcept } from "./cover";

/**
 * Headline Preflight — дешёвая ТЕКСТОВАЯ стадия перед единственной платной генерацией.
 * Claude предлагает 3 коротких варианта, а выбор делает детерминированный код: модель
 * не умеет судить, что ей самой будет легче нарисовать, а статистика провалов QC
 * упирается именно в длинные заголовки и лишние символы.
 * Цель — поднять шанс успеха ПЕРВОЙ и единственной генерации, а не лечить брак повторами.
 */

const SERVICE_WORDS = new Set([
  "И", "А", "НО", "В", "ВО", "НА", "НЕ", "НИ", "С", "СО", "К", "КО", "У", "О", "ОБ", "ОБО", "ЗА", "ИЗ", "ДО", "ПО", "ОТ",
  "ПОД", "НАД", "ПРИ", "ПРО", "БЕЗ", "ДЛЯ", "ЧЕРЕЗ", "ПЕРЕД", "МЕЖДУ", "ЖЕ", "ЛИ", "БЫ",
]);

const IDEAL_WORDS_MIN = 2;
const IDEAL_WORDS_MAX = 3;
const MAX_CHARS_FREE = 18; // букв без пробелов
const FREE_SERVICE_WORDS = 1;

export type HeadlineScore = {
  headline: string;
  score: number; // 100 = идеально; штрафы вычитаются
  words: number;
  chars: number;
  longestWord: number;
  specials: number;
  numbers: number;
  punctuation: number;
  serviceWords: number;
  /** слова, несущие смысл (не служебные) — по ним разрешается ничья */
  contentWords: number;
  penalties: string[];
};

/** Детерминированная оценка «насколько безопасно это рисовать image-моделью». */
export function scoreHeadline(input: string): HeadlineScore {
  const headline = String(input ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  const words = headline.split(" ").filter(Boolean);
  const chars = headline.replace(/\s/g, "").length;
  const longestWord = words.reduce((max, w) => Math.max(max, w.length), 0);
  const specials = (headline.match(/[$%€₽№#@&*+=<>|\/\\→←↑↓]/g) ?? []).length;
  const numberMatches = headline.match(/\d+/g) ?? [];
  const punctuation = (headline.match(/[.,!?;:"'«»()\-—]/g) ?? []).length;
  const serviceWords = words.filter((w) => SERVICE_WORDS.has(w)).length;

  const penalties: string[] = [];
  let score = 100;
  const hit = (points: number, why: string) => {
    score -= points;
    penalties.push(`${why} (−${points})`);
  };

  // длина: 2–3 слова идеально, 4 допустимо, дальше резко хуже
  if (words.length === 1) hit(5, "одно слово");
  else if (words.length === 4) hit(10, "4 слова");
  else if (words.length === 5) hit(22, "5 слов");
  else if (words.length > 5) hit(40, `${words.length} слов`);

  if (chars > MAX_CHARS_FREE) hit(Math.round((chars - MAX_CHARS_FREE) * 1.5), `${chars} букв`);
  if (longestWord > 10) hit((longestWord - 10) * 2, `длинное слово (${longestWord} букв)`);
  if (specials) hit(specials * 12, `спецсимволов: ${specials}`);

  // цифры допустимы, если число и есть hook; цепочки чисел — рискованнее
  if (numberMatches.length) {
    hit(numberMatches.length * 8, `чисел: ${numberMatches.length}`);
    const longDigits = numberMatches.reduce((sum, n) => sum + Math.max(0, n.length - 2), 0);
    if (longDigits) hit(longDigits * 3, `длинных цифр: ${longDigits}`);
  }
  if (punctuation) hit(punctuation * 6, `пунктуации: ${punctuation}`);
  if (serviceWords > FREE_SERVICE_WORDS) hit((serviceWords - FREE_SERVICE_WORDS) * 10, `служебных слов: ${serviceWords}`);

  return {
    headline,
    score,
    words: words.length,
    chars,
    longestWord,
    specials,
    numbers: numberMatches.length,
    punctuation,
    serviceWords,
    contentWords: words.length - serviceWords,
    penalties,
  };
}

export type HeadlineSelection = {
  headlineCandidates: string[];
  scores: HeadlineScore[];
  selectedHeadline: string;
  reason: string;
};

/**
 * Выбирает самый безопасный вариант. При равных баллах побеждает более информативный
 * (больше смысловых слов), и только затем более короткий: иначе из равных вариантов
 * «ТИГР ВО ДВОРЕ» и «НЕ БЕГИ» выигрывал бы второй, теряющий сам сюжет обложки.
 */
export function selectHeadline(candidates: string[]): HeadlineSelection {
  const cleaned = candidates.map((c) => String(c ?? "").trim()).filter(Boolean);
  if (!cleaned.length) throw new Error("HEADLINE_PREFLIGHT: нет вариантов заголовка");

  const scores = cleaned.map(scoreHeadline);
  const better = (b: HeadlineScore, a: HeadlineScore) => {
    if (b.score !== a.score) return b.score > a.score;
    if (b.contentWords !== a.contentWords) return b.contentWords > a.contentWords;
    return b.chars < a.chars;
  };
  const best = scores.reduce((a, b) => (better(b, a) ? b : a));
  const tie = scores.filter((s) => s.score === best.score).length > 1;
  const reason = best.penalties.length
    ? `${best.score} баллов — лучший из ${scores.length}; замечания: ${best.penalties.join(", ")}`
    : `${best.score} баллов — ${best.words} слова, ${best.chars} букв, без цифр и спецсимволов` +
      (tie ? `; при равном счёте выбран самый информативный (${best.contentWords} смысловых слова)` : "");

  return { headlineCandidates: scores.map((s) => s.headline), scores, selectedHeadline: best.headline, reason };
}

/**
 * Применяет preflight к концепту: фиксирует победивший заголовок и пишет отчёт.
 * После этого headline не меняется — ни промптом, ни QC.
 */
export function applyHeadlinePreflight(concept: CoverConcept, dir?: string): HeadlineSelection {
  const fromLines = concept.headlineLines.map((l) => l.text).join(" ");
  const candidates = concept.headlineCandidates?.length ? concept.headlineCandidates : [fromLines];
  const selection = selectHeadline(candidates);

  concept.headlineLines = breakHeadline(null, selection.selectedHeadline);
  concept.headline = concept.headlineLines.map((l) => l.text).join("\n");

  if (dir) {
    fs.writeFileSync(
      path.join(dir, "cover-headline-preflight.json"),
      JSON.stringify(
        {
          headlineCandidates: selection.headlineCandidates,
          scores: selection.scores.map((s) => s.score),
          selectedHeadline: selection.selectedHeadline,
          reason: selection.reason,
          details: selection.scores,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  return selection;
}
