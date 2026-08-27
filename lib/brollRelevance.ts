import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";
import { VisualIntent } from "./editPlan";

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
  updatedAt: string;
};

export type VisualRelevanceScore = {
  relevance: number; // 0..1
  subjectMatch: number;
  environmentMatch: number;
  actionMatch: number;
  avoidViolation: boolean;
  reason: string;
};

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

const VISION_SYSTEM = `You describe a stock-video preview frame for editorial matching.
Reply with STRICT JSON only:
{"description":"one sentence what is happening","objects":["nouns and broad synonyms/categories, lowercase english, 5-12 items"],"environment":"where it takes place, few words","action":"main action, few words"}
Be generous with objects: include category words (e.g. for a tiger: tiger, big cat, predator, animal, wildlife).`;

/** Vision-описание ассета по превью; кэшируется по provider:id. */
export async function analyzeAsset(
  cacheKey: string,
  thumbnailUrl: string,
): Promise<AssetAnalysis | null> {
  const cache = readAnalysisCache();
  if (cache[cacheKey]) return cache[cacheKey];

  const key = getSettings().anthropicKey;
  if (!key || !thumbnailUrl) return null;

  const client = new Anthropic({ apiKey: key });
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2000,
    system: VISION_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: thumbnailUrl } },
          { type: "text", text: "Describe this preview frame." },
        ],
      },
    ],
  });
  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
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

/** Детерминированный матчинг анализа против intent — без LLM, бесплатно. */
export function scoreRelevance(intent: VisualIntent, analysis: AssetAnalysis): VisualRelevanceScore {
  const haystack = `${analysis.description} ${analysis.objects.join(" ")} ${analysis.environment} ${analysis.action}`.toLowerCase();

  const termHit = (term: string): boolean => {
    const words = term.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (!words.length) return false;
    const hits = words.filter((w) => haystack.includes(stem(w))).length;
    return hits / words.length >= 0.5;
  };

  // avoid — жёсткое отклонение
  const violated = intent.avoid.find((a) => termHit(a));
  if (violated) {
    return {
      relevance: 0,
      subjectMatch: 0,
      environmentMatch: 0,
      actionMatch: 0,
      avoidViolation: true,
      reason: `нарушен avoid: «${violated}»`,
    };
  }

  const mustTerms = intent.mustHave.length ? intent.mustHave : [intent.subject];
  const mustHits = mustTerms.filter((t) => termHit(t)).length;
  const subjectMatch = mustTerms.length ? mustHits / mustTerms.length : termHit(intent.subject) ? 1 : 0;
  const environmentMatch = intent.environment ? (termHit(intent.environment) ? 1 : partial(intent.environment, haystack)) : 0.5;
  const actionMatch = intent.action ? (termHit(intent.action) ? 1 : partial(intent.action, haystack)) : 0.5;

  const relevance = subjectMatch * 0.55 + environmentMatch * 0.25 + actionMatch * 0.2;
  return {
    relevance: round2(relevance),
    subjectMatch: round2(subjectMatch),
    environmentMatch: round2(environmentMatch),
    actionMatch: round2(actionMatch),
    avoidViolation: false,
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
