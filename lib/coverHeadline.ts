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
  /** сохранён ли главный предмет ролика (если якоря заданы) */
  anchorHit: boolean;
  matchedAnchors: string[];
  penalties: string[];
};

const ANCHOR_MISS_PENALTY = 45;

/** Морфология по-простому: сравниваем по усечённой основе, чтобы «тигр» ловил «ТИГРА». */
function stem(word: string): string {
  const w = word.toUpperCase().replace(/Ё/g, "Е");
  return w.slice(0, Math.max(3, w.length - 2));
}

/** Якорь найден, если основа якоря и основа слова заголовка совпадают по началу. */
export function matchAnchors(headline: string, anchors: string[]): string[] {
  const words = headline.toUpperCase().replace(/Ё/g, "Е").split(/[^А-ЯA-Z0-9]+/).filter(Boolean);
  return anchors.filter((anchor) => {
    const a = stem(anchor);
    return words.some((w) => w.startsWith(a) || stem(w).length >= 3 && a.startsWith(stem(w)));
  });
}

/**
 * Детерминированная оценка: насколько безопасно это рисовать image-моделью И
 * сохранился ли предмет ролика. Форма без смысла не считается хорошим заголовком.
 */
export function scoreHeadline(input: string, anchors: string[] = []): HeadlineScore {
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

  // главный критерий смысла: заголовок обязан сохранить предмет ролика
  const matchedAnchors = anchors.length ? matchAnchors(headline, anchors) : [];
  const anchorHit = anchors.length === 0 || matchedAnchors.length > 0;
  if (!anchorHit) hit(ANCHOR_MISS_PENALTY, `потерян предмет ролика (${anchors.join(", ")})`);

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
    anchorHit,
    matchedAnchors,
    penalties,
  };
}

export type HeadlineSelection = {
  /** прошёл ли semantic preflight: хотя бы один кандидат сохранил предмет ролика */
  ok: boolean;
  headlineCandidates: string[];
  scores: HeadlineScore[];
  selectedHeadline: string;
  reason: string;
};

/**
 * Выбирает вариант, который сохраняет предмет ролика И безопаснее всего рисуется.
 * Смысл важнее формы: если хотя бы один кандидат держит якорь, кандидаты без якоря
 * не побеждают никогда — иначе выигрывало бы «НЕ БЕГИ», из которого исчез тигр.
 * Дальше — баллы формы, затем информативность, затем краткость.
 *
 * ok=false означает, что якорь потеряли ВСЕ кандидаты. Это не повод платить за
 * картинку с заведомо слабым заголовком — вызывающий код обязан запросить новые
 * варианты текстом (это почти бесплатно), а не идти в генератор.
 */
export function selectHeadline(candidates: string[], anchors: string[] = []): HeadlineSelection {
  const cleaned = candidates.map((c) => String(c ?? "").trim()).filter(Boolean);
  if (!cleaned.length) throw new Error("HEADLINE_PREFLIGHT: нет вариантов заголовка");

  const scores = cleaned.map((c) => scoreHeadline(c, anchors));
  const anyAnchor = scores.some((s) => s.anchorHit);
  const better = (b: HeadlineScore, a: HeadlineScore) => {
    if (anyAnchor && b.anchorHit !== a.anchorHit) return b.anchorHit;
    if (b.score !== a.score) return b.score > a.score;
    if (b.contentWords !== a.contentWords) return b.contentWords > a.contentWords;
    return b.chars < a.chars;
  };
  const best = scores.reduce((a, b) => (better(b, a) ? b : a));
  const tie = scores.filter((s) => s.score === best.score && s.anchorHit === best.anchorHit).length > 1;
  const anchorNote = anchors.length
    ? best.matchedAnchors.length
      ? `; предмет ролика сохранён (${best.matchedAnchors.join(", ")})`
      : `; ОТКЛОНЕНО: ни один вариант не удержал якоря (${anchors.join(", ")}) — картинка не заказывается`
    : "";
  const reason = best.penalties.length
    ? `${best.score} баллов — лучший из ${scores.length}; замечания: ${best.penalties.join(", ")}${anchorNote}`
    : `${best.score} баллов — ${best.words} слова, ${best.chars} букв, без цифр и спецсимволов` +
      (tie ? `; при равном счёте выбран самый информативный (${best.contentWords} смысловых слова)` : "") +
      anchorNote;

  return {
    ok: anyAnchor,
    headlineCandidates: scores.map((s) => s.headline),
    scores,
    selectedHeadline: best.headline,
    reason,
  };
}

/**
 * Применяет preflight к концепту: фиксирует победивший заголовок и пишет отчёт.
 * После этого headline не меняется — ни промптом, ни QC.
 */
export function applyHeadlinePreflight(
  concept: CoverConcept,
  dir?: string,
  options: { attempt?: number; ignoreAnchor?: boolean } = {},
): HeadlineSelection {
  const fromLines = concept.headlineLines.map((l) => l.text).join(" ");
  const candidates = concept.headlineCandidates?.length ? concept.headlineCandidates : [fromLines];
  // явный заголовок пользователя — его осознанный выбор, шлюз смысла к нему не применяем
  const selection = selectHeadline(candidates, options.ignoreAnchor ? [] : (concept.headlineAnchor ?? []));

  concept.headlineLines = breakHeadline(null, selection.selectedHeadline);
  concept.headline = concept.headlineLines.map((l) => l.text).join("\n");

  if (dir) {
    const attempt = options.attempt ?? 1;
    fs.writeFileSync(
      path.join(dir, attempt > 1 ? `cover-headline-preflight-${attempt}.json` : "cover-headline-preflight.json"),
      JSON.stringify(
        {
          attempt,
          ok: selection.ok,
          headlineCandidates: selection.headlineCandidates,
          scores: selection.scores.map((s) => s.score),
          headlineAnchor: concept.headlineAnchor ?? [],
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

/** Жёсткое напоминание для повторной ТЕКСТОВОЙ попытки (картинка ещё не заказывалась). */
export const STRICT_ANCHOR_NOTE =
  "ВАЖНО: предыдущие варианты заголовка потеряли предмет ролика и были отклонены. " +
  "Каждый из трёх новых вариантов ОБЯЗАН содержать хотя бы одно слово из headlineAnchor " +
  "(можно в другой форме). Абстракции вроде «ВСЁ ПРОПАЛО», «БУДУЩЕЕ НАСТАЛО», «НЕ БЕГИ» запрещены.";

export const MAX_HEADLINE_ATTEMPTS = 2;

export type HeadlineResolution = {
  ok: boolean;
  attempts: number;
  concept?: CoverConcept;
  selection?: HeadlineSelection;
};

/**
 * Semantic preflight как ШЛЮЗ перед платной генерацией.
 * Текстовые попытки стоят доли цента, поэтому при потере смысла мы просим новые
 * варианты (максимум 2 попытки) и только потом решаем, заказывать ли картинку.
 * Если смысл не удержан и после этого — HEADLINE_FAILED, Gemini не вызывается вообще.
 */
export async function resolveHeadline(
  makeConcept: (attempt: number, strictNote: string | null) => Promise<CoverConcept | null>,
  dir?: string,
  options: { ignoreAnchor?: boolean; maxAttempts?: number } = {},
): Promise<HeadlineResolution> {
  const maxAttempts = options.maxAttempts ?? MAX_HEADLINE_ATTEMPTS;
  let last: { concept: CoverConcept; selection: HeadlineSelection } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const concept = await makeConcept(attempt, attempt > 1 ? STRICT_ANCHOR_NOTE : null);
    if (!concept) continue;
    const selection = applyHeadlinePreflight(concept, dir, { attempt, ignoreAnchor: options.ignoreAnchor });
    last = { concept, selection };
    if (selection.ok) return { ok: true, attempts: attempt, concept, selection };
    console.warn(`Cover preflight #${attempt}: ${selection.reason}`);
  }

  return { ok: false, attempts: maxAttempts, concept: last?.concept, selection: last?.selection };
}
