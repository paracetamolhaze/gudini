import { getPool } from "../pool.js";

/**
 * Retention for the bookkeeping tables. Nothing else in the project ever deletes from `jobs`,
 * `audit_logs`, `llm_calls` or `insight_snapshots`: every tick of every repeatable job writes a row,
 * so on a home machine the Postgres volume grows until the disk is full (BullMQ's removeOnComplete
 * only trims Redis).
 *
 * Deletes go in small batches by ctid. One `DELETE ... WHERE at < ...` over a table that already has
 * a million rows holds row locks and writes one enormous WAL transaction — long enough to stall the
 * publisher and to double the disk usage before it frees anything. A few thousand ctids at a time
 * commit in milliseconds, and an interrupted run simply leaves the rest for tomorrow.
 */

/** Small enough to commit instantly on a home Postgres, large enough that a day's rows go in one pass. */
const BATCH = 2_000;
/** Ceiling per table per run (800k rows): clears years of neglect over a few nights, never loops forever. */
const MAX_BATCHES = 400;
/** Breathing room for Postgres and for the other queues' workers between batches. The publisher queue
 *  runs one job at a time, so its own tick waits for this sweep either way. */
const PAUSE_MS = 100;

export interface PruneResult {
  table: string;
  removed: number;
  /** Hit MAX_BATCHES — more rows are still due, the next run picks them up. */
  truncated: boolean;
}

export interface RetentionDays {
  jobs: number;
  audit: number;
  llmCalls: number;
  insights: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `table` and `where` are literals from this module — never user input — so they are interpolated;
 * the cut-off day count is a bound parameter.
 */
async function pruneBatched(table: string, where: string, days: number): Promise<PruneResult> {
  const sql = `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${BATCH})`;
  let removed = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = await getPool().query(sql, [days]);
    const n = res.rowCount ?? 0;
    removed += n;
    if (n < BATCH) return { table, removed, truncated: false };
    await sleep(PAUSE_MS);
  }
  return { table, removed, truncated: true };
}

/**
 * Drop history nobody reads any more. Insight snapshots are the one exception to "older than N days":
 * the dashboard and the performance report show the *latest* snapshot of every publication, so the
 * newest row per post survives however old it is — only the intermediate history is thinned out.
 */
export async function pruneHistory(days: RetentionDays): Promise<PruneResult[]> {
  return [
    await pruneBatched("jobs", "started_at < now() - make_interval(days => $1)", days.jobs),
    await pruneBatched("audit_logs", "at < now() - make_interval(days => $1)", days.audit),
    await pruneBatched("llm_calls", "at < now() - make_interval(days => $1)", days.llmCalls),
    await pruneBatched(
      "insight_snapshots",
      `captured_at < now() - make_interval(days => $1)
         AND EXISTS (SELECT 1 FROM insight_snapshots newer
                      WHERE newer.publication_id = insight_snapshots.publication_id
                        AND newer.captured_at > insight_snapshots.captured_at)`,
      days.insights,
    ),
  ];
}
