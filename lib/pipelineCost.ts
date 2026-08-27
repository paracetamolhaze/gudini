import fs from "fs";
import path from "path";

/**
 * Учёт расходов на один ролик. Раньше стоимость была видна только по обложке,
 * а поиск делал ~500 HTTP-запросов, о которых никто не знал. Теперь каждая стадия
 * пишет свои счётчики, и по завершении они ложатся рядом с проектом.
 */

export type PipelineCost = {
  researchLlmCalls: number;
  braveNewsRequests: number;
  braveVideoRequests: number;
  braveImageRequests: number;
  braveWebRequests: number;
  pageFetches: number;
  videoDownloads: number;
  visionCalls: number;
  speechCleanupCalls: number;
  editPlannerCalls: number;
  scriptLlmCalls: number;
  coverGenerationCost: number;
  coverQcCost: number;
};

const EMPTY: PipelineCost = {
  researchLlmCalls: 0,
  braveNewsRequests: 0,
  braveVideoRequests: 0,
  braveImageRequests: 0,
  braveWebRequests: 0,
  pageFetches: 0,
  videoDownloads: 0,
  visionCalls: 0,
  speechCleanupCalls: 0,
  editPlannerCalls: 0,
  scriptLlmCalls: 0,
  coverGenerationCost: 0,
  coverQcCost: 0,
};

let current: PipelineCost = { ...EMPTY };

/** Начать учёт для нового ролика. */
export function resetCost(): void {
  current = { ...EMPTY };
}

export function addCost(patch: Partial<PipelineCost>): void {
  for (const [k, v] of Object.entries(patch)) {
    const key = k as keyof PipelineCost;
    current[key] = Number((current[key] + (v ?? 0)).toFixed(6));
  }
}

export function readCost(): PipelineCost {
  return { ...current };
}

export function writeCost(dir: string): PipelineCost {
  const snapshot = readCost();
  try {
    fs.writeFileSync(path.join(dir, "pipeline-cost.json"), JSON.stringify(snapshot, null, 2), "utf8");
  } catch {}
  return snapshot;
}
