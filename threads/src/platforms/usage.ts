import { one, query } from "../db/pool.js";
import { cachedSettings } from "../config/settings.js";
import { logger } from "../shared/logger.js";
import type { XUsageKind } from "../x/client.js";
import type { PlatformId } from "./types.js";

/**
 * Ledger of billable platform calls. X is pay-per-use, so reads are budgeted per day and every
 * write is priced; the dashboard shows the running total next to the LLM spend.
 */
export function xUnitPrice(kind: XUsageKind): number {
  const p = cachedSettings().platforms.x.prices;
  switch (kind) {
    case "post_create":
      return p.postCreate;
    case "post_create_url":
      return p.postCreateUrl;
    case "post_create_summoned":
      return p.postCreateSummoned;
    case "post_read":
      return p.postRead;
    case "owned_read":
      return p.ownedRead;
    case "user_read":
      return p.userRead;
    case "media_upload":
      return 0;
  }
}

export function recordUsage(platform: PlatformId, operation: string, units: number, unitCost: number, meta?: Record<string, unknown>): void {
  query(`INSERT INTO platform_usage (platform, operation, units, estimated_cost, meta) VALUES ($1,$2,$3,$4,$5::jsonb)`, [platform, operation, units, units * unitCost, JSON.stringify(meta ?? null)]).catch((err) =>
    logger().warn({ err: err instanceof Error ? err.message : String(err) }, "platform usage not recorded"),
  );
}

/** Posts of other people read on X since midnight UTC (the unit the daily read budget is set in). */
export async function xPaidReadsToday(): Promise<number> {
  const row = await one<{ n: number }>(`SELECT COALESCE(sum(units), 0)::int AS n FROM platform_usage WHERE platform = 'x' AND operation = 'post_read' AND at >= date_trunc('day', now())`);
  return row?.n ?? 0;
}

export async function usageSummary(platform: PlatformId): Promise<{ today: number; last30d: number; byOperation: Array<{ operation: string; units: number; cost: number }> }> {
  const totals = await one<{ today: number | null; month: number | null }>(
    `SELECT sum(estimated_cost) FILTER (WHERE at >= date_trunc('day', now()))::float AS today, sum(estimated_cost)::float AS month FROM platform_usage WHERE platform = $1 AND at >= now() - interval '30 days'`,
    [platform],
  );
  const byOperation = await query<{ operation: string; units: number; cost: number }>(
    `SELECT operation, sum(units)::int AS units, sum(estimated_cost)::float AS cost FROM platform_usage WHERE platform = $1 AND at >= now() - interval '30 days' GROUP BY operation ORDER BY cost DESC`,
    [platform],
  );
  return { today: totals?.today ?? 0, last30d: totals?.month ?? 0, byOperation };
}
