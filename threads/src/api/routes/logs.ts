import type { FastifyInstance } from "fastify";
import { query } from "../../db/pool.js";
import { clampInt } from "../../shared/ids.js";

export function registerLogRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/logs`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = clampInt(q.limit, 1, 500, 100);
    const before = q.before ? Number(q.before) : null;
    const conditions: string[] = [];
    const params: unknown[] = [];
    const push = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (before && Number.isFinite(before)) conditions.push(`id < ${push(before)}`);
    if (q.event) conditions.push(`event = ${push(q.event)}`);
    if (q.level) conditions.push(`level = ${push(q.level)}`);
    if (q.candidateId) conditions.push(`candidate_id = ${push(q.candidateId)}`);
    if (q.draftId) conditions.push(`draft_id = ${push(q.draftId)}`);
    if (q.interactionId) conditions.push(`interaction_id = ${push(q.interactionId)}`);
    if (q.sourceId) conditions.push(`source_id = ${push(q.sourceId)}`);
    if (q.search) conditions.push(`message ILIKE ${push(`%${q.search}%`)}`);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await query(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ${push(limit)}`, params);
    return { logs: rows };
  });

  app.get(`${api}/jobs`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = clampInt(q.limit, 1, 500, 100);
    const rows = await query(`SELECT * FROM jobs ORDER BY started_at DESC LIMIT $1`, [limit]);
    return { jobs: rows };
  });
}
