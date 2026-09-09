import fs from "fs";
import path from "path";

/**
 * Статистика обложек. Автоматических повторов и автоматической проверки нет, поэтому
 * нет и счётчиков попыток с причинами отказа: каждая генерация — отдельное действие
 * пользователя и отдельная оплата. manualRegenerations показывает, сколько раз человек
 * нажал «Создать заново».
 */

export type CoverRun = {
  status: "PASS" | "ERROR";
  cost: number;
  manual?: boolean;
  error?: string;
  /** длина отправленного заголовка — видно, какие заголовки просит пользователь */
  headlineWords?: number;
  headlineChars?: number;
};

export type CoverStats = {
  generated: number;
  made: number;
  manualRegenerations: number;
  errors: number;
  totalCost: number;
  headlineAvgWords: number;
  headlineAvgChars: number;
  updatedAt?: string;
};

const STATS_FILE = path.join(process.cwd(), "data", "cover-stats.json");

const EMPTY: CoverStats = {
  generated: 0,
  made: 0,
  manualRegenerations: 0,
  errors: 0,
  totalCost: 0,
  headlineAvgWords: 0,
  headlineAvgChars: 0,
};

export function readCoverStats(file = STATS_FILE): CoverStats {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const stats = { ...EMPTY };
    for (const key of Object.keys(EMPTY) as (keyof CoverStats)[]) {
      const v = raw[key];
      if (typeof v === "number") (stats[key] as number) = v;
    }
    if (typeof raw.updatedAt === "string") stats.updatedAt = raw.updatedAt;
    // «made» появился вместо passedQc: старую цифру не теряем
    if (!stats.made && typeof raw.passedQc === "number") stats.made = raw.passedQc;
    return stats;
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

  if (run.status === "PASS") s.made += 1;

  // скользящее среднее по длине заголовков
  if (run.headlineWords !== undefined && run.headlineChars !== undefined) {
    const round = (v: number) => Number(v.toFixed(2));
    s.headlineAvgWords = round(s.headlineAvgWords + (run.headlineWords - s.headlineAvgWords) / s.generated);
    s.headlineAvgChars = round(s.headlineAvgChars + (run.headlineChars - s.headlineAvgChars) / s.generated);
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
