import type { ScoreBreakdown, SourceAnalysis } from "./schemas.js";

/**
 * Final candidate score. Weights (settings.scoring.weights) are normalised so any positive
 * numbers work; the risk penalty is subtracted afterwards. Everything here is deterministic
 * so the dashboard can explain exactly why a candidate passed or failed.
 */
export interface ScoringInput {
  analysis: Pick<SourceAnalysis, "relevanceScore" | "freshnessScore" | "noveltyScore" | "valueScore" | "riskScore" | "isBreaking">;
  /** 0 = top priority … 3 = evergreen (sources.priority). */
  sourcePriority: number;
  /** 0–100 trust of the source. */
  sourceTrust: number;
  /** Hours since the source published (null when unknown). */
  ageHours: number | null;
  weights: { relevance: number; freshness: number; sourcePriority: number; novelty: number; value: number };
  threshold: number;
  /** How many independent sources reported the same event (cluster size). */
  corroboration?: number;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Freshness decays with age: breaking news loses value within hours, ordinary news within days. */
export function freshnessFromAge(ageHours: number | null, modelFreshness: number, isBreaking: boolean): number {
  if (ageHours === null) return modelFreshness;
  const halfLife = isBreaking ? 6 : 24;
  const decay = Math.pow(0.5, Math.max(0, ageHours) / halfLife);
  return clamp(modelFreshness * (0.35 + 0.65 * decay));
}

export function sourcePriorityScore(priority: number, trust: number): number {
  const p = [100, 80, 60, 40][Math.min(3, Math.max(0, Math.round(priority)))] ?? 60;
  return clamp(p * 0.6 + clamp(trust) * 0.4);
}

export function riskPenalty(risk: number, corroboration = 1): number {
  // Low risk costs nothing; high risk is expensive. Independent corroboration softens it.
  const base = risk <= 30 ? 0 : ((risk - 30) / 70) * 35;
  const relief = Math.min(10, Math.max(0, corroboration - 1) * 4);
  return Math.max(0, base - relief);
}

export function scoreCandidate(input: ScoringInput): ScoreBreakdown {
  const w = input.weights;
  const sum = w.relevance + w.freshness + w.sourcePriority + w.novelty + w.value || 1;
  const relevance = clamp(input.analysis.relevanceScore);
  const freshness = freshnessFromAge(input.ageHours, clamp(input.analysis.freshnessScore), input.analysis.isBreaking);
  const sourcePriority = sourcePriorityScore(input.sourcePriority, input.sourceTrust);
  const novelty = clamp(input.analysis.noveltyScore);
  const value = clamp(input.analysis.valueScore);
  const risk = clamp(input.analysis.riskScore);
  const weighted = (relevance * w.relevance + freshness * w.freshness + sourcePriority * w.sourcePriority + novelty * w.novelty + value * w.value) / sum;
  const total = Math.round(clamp(weighted - riskPenalty(risk, input.corroboration)) * 100) / 100;
  return { relevance, freshness, sourcePriority, novelty, value, risk, total, threshold: input.threshold, passes: total >= input.threshold };
}

export function priorityFromAnalysis(a: Pick<SourceAnalysis, "isBreaking" | "contentKind">, total: number): "P0" | "P1" | "P2" | "P3" {
  if (a.isBreaking) return "P0";
  if (total >= 85) return "P1";
  if (a.contentKind === "ANALYSIS" || a.contentKind === "OPINION") return "P3";
  return "P2";
}
