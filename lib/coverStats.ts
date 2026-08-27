import fs from "fs";
import path from "path";
import type { CoverQcStatus } from "./coverQc";

/**
 * Статистика обложек. Фолбэков в системе нет, поэтому и счётчиков фолбэка нет:
 * обложка либо проходит QC на одной из трёх попыток, либо это COVER_FAILED.
 */

export type CoverRun = {
  attempts: number;
  status: "PASS" | "COVER_FAILED" | "ERROR";
  qc: CoverQcStatus | "NONE";
  cost: number;
  error?: string;
};

export type CoverStats = {
  totalCovers: number;
  passFirst: number;
  passSecond: number;
  passThird: number;
  failedAfterThree: number;
  textMismatch: number;
  extraText: number;
  unreadableText: number;
  identityFail: number;
  anatomyFail: number;
  visualArtifacts: number;
  qcUnavailable: number;
  errors: number;
  totalCost: number;
  updatedAt?: string;
};

const STATS_FILE = path.join(process.cwd(), "data", "cover-stats.json");

const EMPTY: CoverStats = {
  totalCovers: 0,
  passFirst: 0,
  passSecond: 0,
  passThird: 0,
  failedAfterThree: 0,
  textMismatch: 0,
  extraText: 0,
  unreadableText: 0,
  identityFail: 0,
  anatomyFail: 0,
  visualArtifacts: 0,
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
  s.totalCovers += 1;
  s.totalCost = Number((s.totalCost + (run.cost || 0)).toFixed(6));
  if (run.error) s.errors += 1;

  if (run.status === "PASS") {
    if (run.attempts <= 1) s.passFirst += 1;
    else if (run.attempts === 2) s.passSecond += 1;
    else s.passThird += 1;
  } else if (run.status === "COVER_FAILED") {
    s.failedAfterThree += 1;
  }

  switch (run.qc) {
    case "TEXT_MISMATCH": s.textMismatch += 1; break;
    case "EXTRA_TEXT": s.extraText += 1; break;
    case "UNREADABLE_TEXT": s.unreadableText += 1; break;
    case "IDENTITY_PROBLEM": s.identityFail += 1; break;
    case "ANATOMY_PROBLEM": s.anatomyFail += 1; break;
    case "VISUAL_ARTIFACTS": s.visualArtifacts += 1; break;
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
