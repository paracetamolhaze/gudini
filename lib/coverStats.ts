import fs from "fs";
import path from "path";
import type { CoverQcStatus } from "./coverQc";
import type { CoverTypographyMode } from "./coverTypography";

/**
 * Накопительная статистика обложек: сколько Full-AI проходит с первого раза,
 * сколько спасает retry, сколько уходит в фолбэк. После первых 50–100 обложек
 * по этим числам решается, оставлять ли Full-AI дефолтом.
 */

export type CoverRun = {
  mode: CoverTypographyMode;
  attempts: number;
  qc: CoverQcStatus | "SKIPPED";
  fallbackUsed: boolean;
  cost: number;
  error?: string;
};

export type CoverStats = {
  totalFullAi: number;
  passFirstTry: number;
  passSecondTry: number;
  fallback: number;
  rendererDirect: number;
  textMismatch: number;
  extraText: number;
  unreadableText: number;
  identityFail: number;
  anatomyFail: number;
  qcUnavailable: number;
  errors: number;
  totalCost: number;
  updatedAt?: string;
};

const STATS_FILE = path.join(process.cwd(), "data", "cover-stats.json");

const EMPTY: CoverStats = {
  totalFullAi: 0,
  passFirstTry: 0,
  passSecondTry: 0,
  fallback: 0,
  rendererDirect: 0,
  textMismatch: 0,
  extraText: 0,
  unreadableText: 0,
  identityFail: 0,
  anatomyFail: 0,
  qcUnavailable: 0,
  errors: 0,
  totalCost: 0,
};

export function readCoverStats(file = STATS_FILE): CoverStats {
  try {
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { ...EMPTY };
  }
}

/** Чистый апдейт счётчиков — тестируется без файловой системы. */
export function applyCoverRun(stats: CoverStats, run: CoverRun): CoverStats {
  const s = { ...stats };
  s.totalCost = Number((s.totalCost + (run.cost || 0)).toFixed(6));
  if (run.error) s.errors += 1;

  if (run.mode === "FULL_AI") {
    s.totalFullAi += 1;
    if (run.fallbackUsed) s.fallback += 1;
    else if (run.qc === "PASS") (run.attempts <= 1 ? (s.passFirstTry += 1) : (s.passSecondTry += 1));
  } else {
    s.rendererDirect += 1;
  }

  switch (run.qc) {
    case "TEXT_MISMATCH": s.textMismatch += 1; break;
    case "EXTRA_TEXT": s.extraText += 1; break;
    case "UNREADABLE_TEXT": s.unreadableText += 1; break;
    case "IDENTITY_PROBLEM": s.identityFail += 1; break;
    case "ANATOMY_PROBLEM": s.anatomyFail += 1; break;
    case "QC_UNAVAILABLE": s.qcUnavailable += 1; break;
  }
  s.updatedAt = new Date().toISOString();
  return s;
}

export function recordCoverRun(run: CoverRun, file = STATS_FILE): CoverStats {
  const next = applyCoverRun(readCoverStats(file), run);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  } catch {}
  return next;
}
