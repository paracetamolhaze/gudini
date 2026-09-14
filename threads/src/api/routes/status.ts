import type { FastifyInstance } from "fastify";
import { loadSettings } from "../../config/settings.js";
import { one, query } from "../../db/pool.js";
import { pingRedis } from "../../queue/connection.js";
import { queueCounts } from "../../queue/queues.js";
import { checkDb, checkThreads } from "../health.js";
import { threadsClient } from "../../threads/index.js";
import { env } from "../../config/env.js";

/** Overview numbers for the dashboard: today's activity, waiting work, dependency health, cost. */
export function registerStatusRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/overview`, async () => {
    const settings = await loadSettings();
    const [db, redis, threads, queues] = await Promise.all([checkDb(), pingRedis(), checkThreads(), queueCounts().catch(() => ({}))]);
    const today = await one<{
      posts: number;
      own_replies: number;
      public_replies: number;
      candidates_found: number;
      candidates_rejected: number;
      drafts_waiting: number;
      scheduled: number;
      needs_review: number;
      cost_today: number | null;
    }>(`SELECT
        (SELECT count(*) FROM publications WHERE published_at >= now() - interval '24 hours')::int AS posts,
        (SELECT count(*) FROM interactions WHERE status = 'SENT' AND type <> 'PUBLIC_POST_REPLY' AND sent_at >= now() - interval '24 hours')::int AS own_replies,
        (SELECT count(*) FROM interactions WHERE status = 'SENT' AND type = 'PUBLIC_POST_REPLY' AND sent_at >= now() - interval '24 hours')::int AS public_replies,
        (SELECT count(*) FROM content_candidates WHERE created_at >= now() - interval '24 hours')::int AS candidates_found,
        (SELECT count(*) FROM content_candidates WHERE status = 'REJECTED' AND updated_at >= now() - interval '24 hours')::int AS candidates_rejected,
        (SELECT count(*) FROM drafts WHERE status IN ('DRAFT','NEEDS_REVIEW'))::int AS drafts_waiting,
        (SELECT count(*) FROM drafts WHERE status IN ('APPROVED','SCHEDULED'))::int AS scheduled,
        (SELECT count(*) FROM interactions WHERE status IN ('NEEDS_REVIEW','DRAFT'))::int AS needs_review,
        (SELECT sum(estimated_cost) FROM llm_calls WHERE at >= date_trunc('day', now()))::float AS cost_today`);
    const sources = await one<{ total: number; enabled: number; errors: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE enabled)::int AS enabled, count(*) FILTER (WHERE last_error IS NOT NULL)::int AS errors FROM sources`,
    );
    const lastPost = await one<{ published_at: Date }>(`SELECT published_at FROM publications ORDER BY published_at DESC LIMIT 1`);
    const account = await one<{ username: string; threads_user_id: string; token_expires_at: Date | null }>(`SELECT username, threads_user_id, token_expires_at FROM accounts ORDER BY updated_at DESC LIMIT 1`);
    return {
      mode: settings.mode,
      killSwitch: settings.killSwitch,
      dryRun: settings.dryRun,
      flags: settings.flags,
      today,
      sources,
      lastPostAt: lastPost?.published_at ?? null,
      account: account ? { username: account.username, userId: account.threads_user_id, tokenExpiresAt: account.token_expires_at ?? threadsClient().tokenExpiresAt ?? null } : null,
      health: { db, redis, threads, llmProvider: env().LLM_PROVIDER },
      queues,
    };
  });

  app.get(`${api}/costs`, async () => {
    const rows = await query<{ period: string; cost: number | null; calls: number; input_tokens: number; output_tokens: number }>(
      `SELECT period, sum(estimated_cost)::float AS cost, count(*)::int AS calls, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens
       FROM (
         SELECT CASE WHEN at >= date_trunc('day', now()) THEN 'today'
                     WHEN at >= now() - interval '7 days' THEN '7d'
                     ELSE '30d' END AS period, estimated_cost, input_tokens, output_tokens
         FROM llm_calls WHERE at >= now() - interval '30 days') t
       GROUP BY period`,
    );
    const byOp = await query<{ operation: string; model: string; cost: number | null; calls: number }>(
      `SELECT operation, model, sum(estimated_cost)::float AS cost, count(*)::int AS calls FROM llm_calls WHERE at >= now() - interval '30 days' GROUP BY operation, model ORDER BY cost DESC NULLS LAST LIMIT 50`,
    );
    const per = await one<{ posts: number; replies: number; cost30: number | null }>(
      `SELECT (SELECT count(*) FROM publications WHERE published_at >= now() - interval '30 days')::int AS posts,
              (SELECT count(*) FROM interactions WHERE status='SENT' AND sent_at >= now() - interval '30 days')::int AS replies,
              (SELECT sum(estimated_cost) FROM llm_calls WHERE at >= now() - interval '30 days')::float AS cost30`,
    );
    const today = rows.find((r) => r.period === "today");
    const week = rows.filter((r) => r.period === "today" || r.period === "7d");
    const month = rows;
    const sum = (list: typeof rows) => ({
      cost: list.reduce((s, r) => s + (r.cost ?? 0), 0),
      calls: list.reduce((s, r) => s + r.calls, 0),
      inputTokens: list.reduce((s, r) => s + r.input_tokens, 0),
      outputTokens: list.reduce((s, r) => s + r.output_tokens, 0),
    });
    return {
      today: sum(today ? [today] : []),
      last7d: sum(week),
      last30d: sum(month),
      costPerPublishedPost: per && per.posts > 0 ? (per.cost30 ?? 0) / per.posts : null,
      costPerReply: per && per.replies > 0 ? (per.cost30 ?? 0) / per.replies : null,
      byOperation: byOp,
    };
  });
}
