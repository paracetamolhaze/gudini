import fs from "fs";
import path from "path";
import type { CoverQcStatus } from "./coverQc";

/**
 * Статистика обложек. Автоматических повторов нет, поэтому нет и счётчиков попыток:
 * каждая генерация — отдельное действие пользователя и отдельная оплата.
 * manualRegenerations показывает, сколько раз пользователь нажал «Перегенерировать».
 */

export type CoverRun = {
  status: "PASS" | "COVER_FAILED" | "ERROR";
  qc: CoverQcStatus | "NONE";
  cost: number;
  manual?: boolean;
  error?: string;
  /** длина отправленного заголовка — чтобы увидеть связь с провалами QC */
  headlineWords?: number;
  headlineChars?: number;
};

export type CoverStats = {
  generated: number;
  passedQc: number;
  failedQc: number;
  manualRegenerations: number;
  textMismatch: number;
  extraText: number;
  unreadableText: number;
  identityFail: number;
  anatomyFail: number;
  visualArtifacts: number;
  qcUnavailable: number;
  errors: number;
  totalCost: number;
  headlineAvgWords: number;
  headlineAvgChars: number;
  updatedAt?: string;
};

const STATS_FILE = path.join(process.cwd(), "data", "cover-stats.json");

const EMPTY: CoverStats = {
  generated: 0,
  passedQc: 0,
  failedQc: 0,
  manualRegenerations: 0,
  textMismatch: 0,
  extraText: 0,
  unreadableText: 0,
  identityFail: 0,
  anatomyFail: 0,
  visualArtifacts: 0,
  qcUnavailable: 0,
  errors: 0,
  totalCost: 0,
  headlineAvgWords: 0,
  headlineAvgChars: 0,
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
  s.generated += 1;
  s.totalCost = Number((s.totalCost + (run.cost || 0)).toFixed(6));
  if (run.manual) s.manualRegenerations += 1;
  if (run.error) s.errors += 1;

  if (run.status === "PASS") s.passedQc += 1;
  else if (run.status === "COVER_FAILED") s.failedQc += 1;

  // скользящее среднее по длине заголовков (для связи «длина ↔ провалы QC»)
  if (run.headlineWords !== undefined && run.headlineChars !== undefined) {
    const round = (v: number) => Number(v.toFixed(2));
    s.headlineAvgWords = round(s.headlineAvgWords + (run.headlineWords - s.headlineAvgWords) / s.generated);
    s.headlineAvgChars = round(s.headlineAvgChars + (run.headlineChars - s.headlineAvgChars) / s.generated);
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
