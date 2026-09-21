import type { FastifyInstance } from "fastify";
import { loadSettings, type Settings } from "../../config/settings.js";
import { one, query } from "../../db/pool.js";
import { pingRedis } from "../../queue/connection.js";
import { queueCounts } from "../../queue/queues.js";
import { checkDb, checkPlatform } from "../health.js";
import { threadsClient } from "../../threads/index.js";
import { env } from "../../config/env.js";
import { PLATFORM_IDS, PLATFORM_LABEL, platform, type PlatformId } from "../../platforms/index.js";
import { usageSummary } from "../../platforms/usage.js";
import { tradeWallet } from "../../services/trades/pipeline.js";
import { isWalletAddress } from "../../hyperliquid/client.js";
import { shortWallet } from "../../services/trades/card.js";

export async function platformOverview(settings: Settings, id: PlatformId) {
  const adapter = platform(id);
  const health = settings.platforms[id].enabled ? await checkPlatform(id) : { ok: false, message: "выключена в настройках" };
  const counts = await one<{ posts: number; replies: number; waiting: number }>(
    `SELECT (SELECT count(*) FROM publications WHERE platform = $1 AND published_at >= now() - interval '24 hours')::int AS posts,
            (SELECT count(*) FROM interactions WHERE platform = $1 AND status = 'SENT' AND sent_at >= now() - interval '24 hours')::int AS replies,
            (SELECT count(*) FROM interactions WHERE platform = $1 AND status IN ('DRAFT','NEEDS_REVIEW'))::int AS waiting`,
    [id],
  );
  const account = await one<{ username: string; platform_user_id: string; token_expires_at: Date | null }>(`SELECT username, platform_user_id, token_expires_at FROM accounts WHERE platform = $1 ORDER BY updated_at DESC LIMIT 1`, [id]);
  return {
    id,
    label: PLATFORM_LABEL[id],
    enabled: settings.platforms[id].enabled,
    configured: adapter.configured(),
    health,
    username: account?.username ?? ("username" in health ? health.username ?? null : null),
    tokenExpiresAt: id === "threads" ? account?.token_expires_at ?? (threadsClient().tokenExpiresAt ? new Date(threadsClient().tokenExpiresAt!) : null) : null,
    maxChars: settings.platforms[id].maxChars,
    publicReplies: adapter.publicReplyChannel() === "api" ? "api" : settings.platforms.x.engagementMode,
    today: counts ?? { posts: 0, replies: 0, waiting: 0 },
    usage: id === "x" ? await usageSummary("x") : null,
  };
}

/** Overview numbers for the dashboard: today's activity, waiting work, dependency health, cost. */
export function registerStatusRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/overview`, async () => {
    const settings = await loadSettings();
    const [db, redis, queues, platforms] = await Promise.all([checkDb(), pingRedis(), queueCounts().catch(() => ({})), Promise.all(PLATFORM_IDS.map((id) => platformOverview(settings, id)))]);
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
        (SELECT count(DISTINCT COALESCE(draft_id::text, id::text)) FROM publications WHERE published_at >= now() - interval '24 hours')::int AS posts,
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
    const e = env();
    const llmKey = Boolean(e.LLM_API_KEY || e.OPENROUTER_API_KEY || e.OPENAI_API_KEY || e.ANTHROPIC_API_KEY || e.GEMINI_API_KEY);
    const last = await one<{ source_check: Date | null; source_post: Date | null; draft: Date | null }>(
      `SELECT (SELECT max(last_checked_at) FROM sources) AS source_check, (SELECT max(created_at) FROM source_posts) AS source_post, (SELECT max(created_at) FROM drafts) AS draft`,
    );
    const wallet = tradeWallet(settings);
    const trades = await one<{ fills: number; last_fill: Date | null; closed_7d: number; wins_7d: number; waiting: number; last_move: Date | null; moves_24h: number }>(
      `SELECT (SELECT count(*) FROM hl_fills WHERE wallet = $1)::int AS fills,
              (SELECT max(time) FROM hl_fills WHERE wallet = $1) AS last_fill,
              (SELECT count(*) FROM hl_trades WHERE wallet = $1 AND status = 'CLOSED' AND closed_at >= now() - interval '7 days')::int AS closed_7d,
              (SELECT count(*) FROM hl_trades WHERE wallet = $1 AND status = 'CLOSED' AND net_pnl > 0 AND closed_at >= now() - interval '7 days')::int AS wins_7d,
              (SELECT count(*) FROM drafts WHERE kind = 'TRADE' AND status IN ('DRAFT','NEEDS_REVIEW'))::int AS waiting,
              (SELECT max(detected_at) FROM market_moves) AS last_move,
              (SELECT count(*) FROM market_moves WHERE detected_at >= now() - interval '24 hours')::int AS moves_24h`,
      [wallet],
    );
    const threads = platforms.find((p) => p.id === "threads")!;
    return {
      mode: settings.mode,
      killSwitch: settings.killSwitch,
      dryRun: settings.dryRun,
      flags: settings.flags,
      today,
      sources,
      lastPostAt: lastPost?.published_at ?? null,
      platforms,
      hyperliquid: {
        enabled: settings.trades.enabled,
        walletSet: Boolean(wallet),
        walletValid: isWalletAddress(wallet),
        wallet: wallet ? shortWallet(wallet) : null,
        autoPublish: settings.trades.autoPublish,
        fills: trades?.fills ?? 0,
        lastFillAt: trades?.last_fill ?? null,
        closed7d: trades?.closed_7d ?? 0,
        wins7d: trades?.wins_7d ?? 0,
        draftsWaiting: trades?.waiting ?? 0,
      },
      market: { enabled: settings.movers.enabled, lastMoveAt: trades?.last_move ?? null, moves24h: trades?.moves_24h ?? 0 },
      persona: { filled: Boolean(settings.persona.name.trim() || settings.persona.rules.trim()), name: settings.persona.name },
      // Legacy shape (single Threads account) still read by the diagnostics page.
      account: threads.username ? { username: threads.username, userId: "", tokenExpiresAt: threads.tokenExpiresAt } : null,
      health: { db, redis, threads: threads.health, llmProvider: e.LLM_PROVIDER },
      readiness: { llmKey, publicBaseUrl: Boolean(e.PUBLIC_BASE_URL), lastSourceCheckAt: last?.source_check ?? null, lastSourcePostAt: last?.source_post ?? null, lastDraftAt: last?.draft ?? null },
      queues,
    };
  });

  app.get(`${api}/platforms`, async () => {
    const settings = await loadSettings();
    return { platforms: await Promise.all(PLATFORM_IDS.map((id) => platformOverview(settings, id))) };
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
      `SELECT (SELECT count(DISTINCT COALESCE(draft_id::text, id::text)) FROM publications WHERE published_at >= now() - interval '30 days')::int AS posts,
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
      x: await usageSummary("x"),
    };
  });
}
