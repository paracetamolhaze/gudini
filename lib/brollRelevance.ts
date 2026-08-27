import fs from "fs";
import path from "path";
import { mediaVision, mediaLlmAvailable } from "./mediaLlm";
import { getSettings } from "./store";
import { VisualIntent } from "./editPlan";
import { detectImageMediaType } from "./coverQc";

/**
 * Semantic-отбор б-ролла: что реально видно на кандидате vs что нужно по смыслу.
 *
 * Архитектура стоимости:
 *   16 кандидатов → дешёвый технический преранк → TOP-3 → vision-анализ ПРЕВЬЮ (тумбнейл
 *   провайдера, не видео) → детерминированный матчинг против visualIntent.
 * Vision-анализ ассета выполняется ОДИН раз и кэшируется навсегда (data/broll-cache/analysis.json);
 * сравнение с intent — чистый код, без LLM. Любой сбой vision → фолбэк на технический скоринг.
 */

export type AssetAnalysis = {
  description: string;
  objects: string[]; // существительные + синонимы/категории, en, lowercase
  environment: string;
  action: string;
  /** скриншот страницы/поста/статьи/таблицы — не визуал, а документ */
  isScreenshot?: boolean;
  /** крупный читаемый текст занимает заметную часть кадра */
  hasLargeText?: boolean;
  /** крупный водяной знак поверх кадра */
  hasLargeWatermark?: boolean;
  updatedAt: string;
};

export type VisualRelevanceScore = {
  relevance: number; // 0..1
  subjectMatch: number;
  environmentMatch: number;
  actionMatch: number;
  /** совпала ли КОНКРЕТНАЯ сущность (человек, матч, событие), если она заявлена */
  specificityMatch: number;
  avoidViolation: boolean;
  /** кандидат слишком общий для конкретной сущности — жёсткое отклонение */
  specificityFail: boolean;
  reason: string;
};

/** Для этих намерений «просто похожий по теме» сток не годится. */
const SPECIFIC_INTENTS = new Set(["PERSON", "TEAM_MATCHUP", "SPECIFIC_EVENT"]);

const ANALYSIS_FILE = path.join(process.cwd(), "data", "broll-cache", "analysis.json");

function readAnalysisCache(): Record<string, AssetAnalysis> {
  try {
    return JSON.parse(fs.readFileSync(ANALYSIS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeAnalysisCache(cache: Record<string, AssetAnalysis>) {
  try {
    fs.mkdirSync(path.dirname(ANALYSIS_FILE), { recursive: true });
    fs.writeFileSync(ANALYSIS_FILE, JSON.stringify(cache, null, 2));
  } catch {}
}

const VISION_SYSTEM = `You inspect a candidate frame for use as b-roll in a short video.
Reply with STRICT JSON only:
{"description":"one sentence what is happening","objects":["nouns and broad synonyms/categories, lowercase english, 5-12 items"],"environment":"where it takes place, few words","action":"main action, few words","isScreenshot":<true if this is a screenshot of a web page, social post, article, chat, table, chart or app UI rather than a photograph or video frame>,"hasLargeText":<true if readable text occupies a noticeable part of the frame (headlines, captions burned in, subtitles, tweet text)>,"hasLargeWatermark":<true if a large watermark or logo covers a significant area>}
Be generous with objects: include category words (e.g. for a tiger: tiger, big cat, predator, animal, wildlife).
Judge isScreenshot strictly: a photo of a person holding a phone is NOT a screenshot; a captured tweet or article IS.`;

/**
 * Vision-описание ассета по превью; кэшируется по ключу.
 * buffer — когда картинку нужно передать байтами: часть источников (Wikimedia)
 * не отдаёт файлы сторонним загрузчикам, и ссылку модель скачать не может.
 */
export async function analyzeAsset(
  cacheKey: string,
  thumbnailUrl: string,
  buffer?: Buffer,
): Promise<AssetAnalysis | null> {
  const cache = readAnalysisCache();
  if (cache[cacheKey]) return cache[cacheKey];

  if (!mediaLlmAvailable() || (!thumbnailUrl && !buffer)) return null;

  const raw = (
    await mediaVision({
      system: VISION_SYSTEM,
      user: "Describe this preview frame.",
      image: buffer
        ? { base64: buffer.toString("base64"), mediaType: detectImageMediaType(buffer) }
        : { url: thumbnailUrl },
    })
  )
    .replace(/^```(json)?/m, "")
    .replace(/```$/m, "")
    .trim();
  try {
    const json = JSON.parse(raw);
    const analysis: AssetAnalysis = {
      description: String(json.description ?? ""),
      objects: Array.isArray(json.objects) ? json.objects.map((o: unknown) => String(o).toLowerCase()) : [],
      environment: String(json.environment ?? "").toLowerCase(),
      action: String(json.action ?? "").toLowerCase(),
      isScreenshot: json.isScreenshot === true,
      hasLargeText: json.hasLargeText === true,
      hasLargeWatermark: json.hasLargeWatermark === true,
      updatedAt: new Date().toISOString(),
    };
    const fresh = readAnalysisCache();
    fresh[cacheKey] = analysis;
    writeAnalysisCache(fresh);
    return analysis;
  } catch {
    return null;
  }
}

/**
 * Детерминированный матчинг анализа против intent — без LLM, бесплатно.
 * Если заявлена конкретная сущность (Jordan Henderson, England vs Mexico), общий
 * кадр по теме отклоняется: семантическая точность важнее вертикальности и 1080p.
 */
export function scoreRelevance(
  intent: VisualIntent,
  analysis: AssetAnalysis,
  entity?: { sourceIntent?: string; entityName?: string },
): VisualRelevanceScore {
  const haystack = `${analysis.description} ${analysis.objects.join(" ")} ${analysis.environment} ${analysis.action}`.toLowerCase();

  /**
   * threshold=0.5 для обязательных условий (описание кадра редко дословно совпадает),
   * но для ЗАПРЕТОВ нужно совпадение целиком: иначе «empty stadium» срабатывал на любом
   * слове «stadium» и отбрасывал нормальные кадры команд на стадионе.
   */
  const termHit = (term: string, threshold = 0.5): boolean => {
    const words = term.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (!words.length) return false;
    const hits = words.filter((w) => haystack.includes(stem(w))).length;
    return hits / words.length >= threshold;
  };

  // Скриншот страницы, поста или статьи — это документ, а не визуал события.
  // Такой кадр в вертикальном ролике читается как случайная картинка из интернета.
  const junk = analysis.isScreenshot
    ? "скриншот страницы/поста"
    : analysis.hasLargeText
      ? "крупный читаемый текст в кадре"
      : analysis.hasLargeWatermark
        ? "крупный водяной знак"
        : null;
  if (junk) {
    return {
      relevance: 0,
      subjectMatch: 0,
      environmentMatch: 0,
      actionMatch: 0,
      specificityMatch: 0,
      avoidViolation: true,
      specificityFail: false,
      reason: junk,
    };
  }

  // avoid — жёсткое отклонение, но только при полном совпадении термина
  const violated = intent.avoid.find((a) => termHit(a, 1));
  if (violated) {
    return {
      relevance: 0,
      subjectMatch: 0,
      environmentMatch: 0,
      actionMatch: 0,
      specificityMatch: 0,
      avoidViolation: true,
      specificityFail: false,
      reason: `нарушен avoid: «${violated}»`,
    };
  }

  // конкретная сущность обязана быть видна на кадре, иначе это просто «что-то по теме»
  const needsEntity = SPECIFIC_INTENTS.has(String(entity?.sourceIntent)) && Boolean(entity?.entityName);
  if (needsEntity) {
    const parts = String(entity!.entityName)
      .split(/\s+|vs\.?|против/i)
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length > 2);
    const hits = parts.filter((p) => haystack.includes(stem(p))).length;
    const specificityMatch = parts.length ? hits / parts.length : 0;
    if (specificityMatch < 0.5) {
      return {
        relevance: 0,
        subjectMatch: 0,
        environmentMatch: 0,
        actionMatch: 0,
        specificityMatch: round2(specificityMatch),
        avoidViolation: false,
        specificityFail: true,
        reason: `слишком общий кадр для «${entity!.entityName}» (совпало ${hits}/${parts.length})`,
      };
    }
  }

  /**
   * ЯКОРЬ ДОМЕНА + ДОЛЯ УСЛОВИЙ вместо «все условия или отказ».
   * Первое условие в mustHave — домен сюжета («football»): без него кандидат
   * отклоняется всегда, поэтому скейтер не заменит футболиста, а носилки на улице —
   * носилки на поле. Остальные условия достаточно выполнить наполовину: требовать,
   * чтобы ОДИН кадр содержал сразу человека, щит, прыжок и падение, — значит не найти
   * ничего и вернуться к лицу автора. Недостающее договаривает соседний кадр.
   */
  const mustTerms = intent.mustHave.length ? intent.mustHave : [intent.subject];
  const anchor = mustTerms[0];
  const missing = mustTerms.filter((t) => !termHit(t));
  const mustHits = mustTerms.length - missing.length;
  const anchorOk = termHit(anchor);
  const ratio = mustTerms.length ? mustHits / mustTerms.length : 0;
  if (!anchorOk || ratio < 0.5) {
    return {
      relevance: 0,
      subjectMatch: 0,
      environmentMatch: 0,
      actionMatch: 0,
      specificityMatch: 0,
      avoidViolation: false,
      specificityFail: true,
      reason: anchorOk
        ? `слишком мало совпадений (${mustHits}/${mustTerms.length}): ${missing.join(", ")}`
        : `нет главного условия «${anchor}»`,
    };
  }
  const subjectMatch = ratio;
  const environmentMatch = intent.environment ? (termHit(intent.environment) ? 1 : partial(intent.environment, haystack)) : 0.5;
  const actionMatch = intent.action ? (termHit(intent.action) ? 1 : partial(intent.action, haystack)) : 0.5;

  const relevance = subjectMatch * 0.55 + environmentMatch * 0.25 + actionMatch * 0.2;
  return {
    relevance: round2(relevance),
    subjectMatch: round2(subjectMatch),
    environmentMatch: round2(environmentMatch),
    actionMatch: round2(actionMatch),
    specificityMatch: needsEntity ? 1 : 1,
    avoidViolation: false,
    specificityFail: false,
    reason: `subject ${mustHits}/${mustTerms.length}, env ${round2(environmentMatch)}, action ${round2(actionMatch)}`,
  };
}

/** Итоговый балл: смысл важнее вертикальности — 70% релевантность, 30% техника. */
export function combineScores(relevance: number, technicalScore: number, technicalMax = 3.5): number {
  return round2(relevance * 0.7 + Math.min(1, technicalScore / technicalMax) * 0.3);
}

function partial(term: string, haystack: string): number {
  const words = term.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (!words.length) return 0;
  return words.filter((w) => haystack.includes(stem(w))).length / words.length;
}

/** Примитивный стемминг: срезает окончания, чтобы walking≈walk, buildings≈building. */
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/i, "").slice(0, 8);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
