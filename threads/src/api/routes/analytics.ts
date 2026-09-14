import type { FastifyInstance } from "fastify";
import { loadSettings } from "../../config/settings.js";
import { performanceReport } from "../../services/analytics/performance.js";
import { one, query } from "../../db/pool.js";
import { HttpError } from "../server.js";
import { enqueue } from "../../queue/queues.js";
import { clampInt } from "../../shared/ids.js";

export function registerAnalyticsRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/analytics`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const settings = await loadSettings();
    const days = clampInt(q.days, 1, 365, 30);
    const report = await performanceReport(settings.schedule.timezone, days);
    const snapshots = await one<{ n: number; last: Date | null }>(`SELECT count(*)::int AS n, max(captured_at) AS last FROM insight_snapshots`);
    return { days, report, snapshots };
  });

  app.get(`${api}/recommendations`, async () => ({ recommendations: await query(`SELECT * FROM recommendations ORDER BY created_at DESC LIMIT 100`) }));

  app.post(`${api}/recommendations/:id/:decision`, async (req) => {
    const { id, decision } = req.params as { id: string; decision: string };
    if (decision !== "accept" && decision !== "reject") throw new HttpError(400, "decision must be accept or reject");
    const row = await one(`UPDATE recommendations SET status = $2, decided_at = now() WHERE id = $1 RETURNING *`, [id, decision === "accept" ? "ACCEPTED" : "REJECTED"]);
    if (!row) throw new HttpError(404, "recommendation not found");
    return { recommendation: row };
  });

  app.post(`${api}/analytics/refresh`, async () => {
    const insights = await enqueue("analytics", "analytics:insights", {}, { jobId: `insights-manual-${Date.now()}`, priority: 1 });
    const recommend = await enqueue("analytics", "analytics:recommend", {}, { jobId: `recommend-manual-${Date.now()}`, priority: 1 });
    return { queued: [insights, recommend] };
  });
}
