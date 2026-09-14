import { loadSettings } from "../../config/settings.js";
import { query } from "../../db/pool.js";
import { threadsClient } from "../../threads/index.js";
import { PermissionError } from "../../threads/errors.js";
import { audit } from "../audit.js";
import { errorMessage } from "../../shared/logger.js";

/** Snapshot views/likes/replies/reposts/quotes/shares for recent publications (threads_manage_insights). */
export async function captureInsights(): Promise<{ captured: number; skipped: number; error: string | null }> {
  const settings = await loadSettings();
  const client = threadsClient();
  if (!client.hasToken) return { captured: 0, skipped: 0, error: "no token" };
  const rows = await query<{ id: string; threads_post_id: string }>(
    `SELECT id, threads_post_id FROM publications
     WHERE dry_run = false AND published_at >= now() - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM insight_snapshots s WHERE s.publication_id = publications.id AND s.captured_at >= now() - interval '2 hours')
     ORDER BY published_at DESC LIMIT 40`,
    [settings.analytics.snapshotDays],
  );
  let captured = 0;
  let skipped = 0;
  for (const p of rows) {
    try {
      const m = await client.postInsights(p.threads_post_id);
      await query(`INSERT INTO insight_snapshots (publication_id, threads_post_id, views, likes, replies, reposts, quotes, shares) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [p.id, p.threads_post_id, m.views, m.likes, m.replies, m.reposts, m.quotes, m.shares]);
      captured++;
    } catch (err) {
      if (err instanceof PermissionError) {
        const msg = `Insights: нужно разрешение ${err.scope ?? "threads_manage_insights"} на токене`;
        await audit("INSIGHTS_CAPTURED", msg, {}, null, "warn");
        return { captured, skipped: rows.length - captured, error: msg };
      }
      skipped++;
      await audit("INSIGHTS_CAPTURED", `Не удалось получить метрики для ${p.threads_post_id}: ${errorMessage(err)}`, { publicationId: p.id }, null, "warn");
    }
  }
  if (captured) await audit("INSIGHTS_CAPTURED", `Снимки метрик: ${captured} публикаций`, {}, { captured, skipped });
  return { captured, skipped, error: null };
}
