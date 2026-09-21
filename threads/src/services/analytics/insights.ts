import { loadSettings } from "../../config/settings.js";
import { query } from "../../db/pool.js";
import { activePlatforms, type PlatformId } from "../../platforms/index.js";
import { PermissionError, RateLimitError } from "../../threads/errors.js";
import { audit } from "../audit.js";
import { errorMessage } from "../../shared/logger.js";

/** Snapshot views/likes/replies/reposts/quotes/shares for recent publications on every connected platform. */
export async function captureInsights(): Promise<{ captured: number; skipped: number; error: string | null }> {
  const settings = await loadSettings();
  const active = new Map(activePlatforms(settings).map((a) => [a.id, a]));
  if (!active.size) return { captured: 0, skipped: 0, error: "no platform connected" };
  const rows = await query<{ id: string; platform: PlatformId; platform_post_id: string }>(
    `SELECT id, platform, platform_post_id FROM publications
     WHERE dry_run = false AND published_at >= now() - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM insight_snapshots s WHERE s.publication_id = publications.id AND s.captured_at >= now() - interval '2 hours')
     ORDER BY published_at DESC LIMIT 40`,
    [settings.analytics.snapshotDays],
  );
  let captured = 0;
  let skipped = 0;
  const blocked = new Set<PlatformId>();
  const errors: string[] = [];
  for (const p of rows) {
    const adapter = active.get(p.platform);
    if (!adapter || blocked.has(p.platform)) {
      skipped++;
      continue;
    }
    try {
      const m = await adapter.metrics(p.platform_post_id);
      await query(`INSERT INTO insight_snapshots (publication_id, platform, platform_post_id, views, likes, replies, reposts, quotes, shares) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [p.id, p.platform, p.platform_post_id, m.views, m.likes, m.replies, m.reposts, m.quotes, m.shares]);
      captured++;
    } catch (err) {
      skipped++;
      if (err instanceof PermissionError || err instanceof RateLimitError) {
        // One refusal speaks for the whole platform this round.
        blocked.add(p.platform);
        const msg = err instanceof PermissionError ? `${adapter.label} insights: нужно разрешение ${err.scope ?? "threads_manage_insights"}` : `${adapter.label} insights: лимит API`;
        errors.push(msg);
        await audit("INSIGHTS_CAPTURED", msg, {}, { platform: p.platform }, "warn");
        continue;
      }
      await audit("INSIGHTS_CAPTURED", `Не удалось получить метрики для ${p.platform}:${p.platform_post_id}: ${errorMessage(err)}`, { publicationId: p.id }, null, "warn");
    }
  }
  if (captured) await audit("INSIGHTS_CAPTURED", `Снимки метрик: ${captured} публикаций`, {}, { captured, skipped });
  return { captured, skipped, error: errors.length ? errors.join("; ") : null };
}
