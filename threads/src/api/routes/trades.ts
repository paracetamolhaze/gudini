import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { z } from "zod";
import { loadSettings } from "../../config/settings.js";
import { one, query } from "../../db/pool.js";
import { getTrade, listTrades, tradeStats, updateTrade } from "../../db/repos/trades.js";
import { isWalletAddress } from "../../hyperliquid/client.js";
import { enqueue } from "../../queue/queues.js";
import { audit } from "../../services/audit.js";
import { worthPosting } from "../../services/trades/aggregate.js";
import { shortWallet } from "../../services/trades/card.js";
import { renderCardForTrade, tradeWallet } from "../../services/trades/pipeline.js";
import { getMove, listMoves } from "../../services/market/movers.js";
import { HttpError } from "../server.js";
import { clampInt } from "../../shared/ids.js";

/** What the queue is doing with the post asked for a row; `at` changes only when a new job starts. */
export interface RowJob {
  state: "QUEUED" | "RUNNING" | "DONE" | "FAILED";
  error: string | null;
  at: string;
}

const JOB_STATE: Record<string, RowJob["state"]> = { queued: "QUEUED", active: "RUNNING", completed: "DONE", failed: "FAILED" };

/**
 * The latest post job per row, read from the job log. A row can then honestly say "пишется…" and show
 * why it fell over instead of silently staying empty after the button said the post was on its way.
 */
async function draftJobs(name: string, key: "moveId" | "tradeId", ids: string[]): Promise<Map<string, RowJob>> {
  if (!ids.length) return new Map();
  const rows = await query<{ entity: string; status: string; error: string | null; started_at: Date }>(
    `SELECT DISTINCT ON (payload->>($2::text)) payload->>($2::text) AS entity, status, error, started_at
       FROM jobs
      WHERE name = $1 AND started_at >= now() - interval '7 days' AND payload->>($2::text) = ANY($3::text[])
      ORDER BY payload->>($2::text), started_at DESC, attempts DESC`,
    [name, key, ids],
  );
  return new Map(rows.map((r) => [r.entity, { state: JOB_STATE[r.status] ?? "RUNNING", error: r.error, at: r.started_at.toISOString() }]));
}

/** The click itself is logged, so the row says "в очереди" even before a worker takes the job — or if none ever does. */
async function recordQueued(queue: string, jobId: string, name: string, payload: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO jobs (queue, job_id, name, status, payload, attempts) VALUES ($1,$2,$3,'queued',$4::jsonb,0)
     ON CONFLICT (queue, job_id, attempts) DO NOTHING`,
    [queue, jobId, name, JSON.stringify(payload)],
  );
}

/** Hyperliquid trades (cards + posts) and market movers. */
export function registerTradeRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/trades`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const settings = await loadSettings();
    const wallet = tradeWallet(settings);
    const trades = wallet ? await listTrades({ wallet, status: q.status, limit: clampInt(q.limit, 1, 300, 100) }) : [];
    const thresholds = { minPnlUsd: settings.trades.minPnlUsd, minRoePct: settings.trades.minRoePct, requireBoth: settings.trades.requireBoth };
    const jobs = await draftJobs("trades:draft", "tradeId", trades.map((t) => t.id));
    return {
      wallet: wallet ? { short: shortWallet(wallet), valid: isWalletAddress(wallet) } : null,
      settings: settings.trades,
      stats: wallet ? await tradeStats(wallet, 30) : null,
      trades: trades.map((t) => ({ ...t, wallet: undefined, job: jobs.get(t.id) ?? null, worth: worthPosting({ status: t.status, netPnl: t.net_pnl, roePct: t.roe_pct, movePct: t.move_pct }, thresholds) })),
    };
  });

  app.post(`${api}/trades/sync`, async () => ({ queued: true, jobId: await enqueue("trades", "trades:sync", {}, { jobId: `trades-sync-manual-${Date.now()}`, priority: 1, attempts: 1 }) }));

  app.put(`${api}/trades/:id`, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ note: z.string().max(1500).nullable() }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, "note: строка до 1500 символов");
    const trade = await updateTrade(id, { note: body.data.note?.trim() || null });
    if (!trade) throw new HttpError(404, "сделка не найдена");
    return { trade: { ...trade, wallet: undefined } };
  });

  app.post(`${api}/trades/:id/draft`, async (req) => {
    const { id } = req.params as { id: string };
    const trade = await getTrade(id);
    if (!trade) throw new HttpError(404, "сделка не найдена");
    if (trade.status !== "CLOSED") throw new HttpError(409, "Позиция ещё открыта — пост делается после закрытия.");
    if (!(trade.net_pnl > 0)) throw new HttpError(409, "Минусовые сделки не публикуются.");
    // The reason of the previous attempt is dropped: the row must not show a stale failure while this one runs.
    await updateTrade(id, { skip_reason: null });
    const jobId = await enqueue("trades", "trades:draft", { tradeId: id, manual: true }, { jobId: `trade-draft-${id}-${Date.now()}`, priority: 1, attempts: 2 });
    await recordQueued("trades", jobId, "trades:draft", { tradeId: id, manual: true });
    return { queued: true, jobId };
  });

  app.post(`${api}/trades/:id/skip`, async (req) => {
    const { id } = req.params as { id: string };
    const trade = await updateTrade(id, { post_status: "SKIPPED", skip_reason: "пропущено вручную" });
    if (!trade) throw new HttpError(404, "сделка не найдена");
    await audit("TRADE_SKIPPED", `Сделка ${trade.coin} ${trade.direction} пропущена вручную`, {}, { tradeId: id });
    return { ok: true };
  });

  /** The card exactly as it would be attached; rendered on demand for trades that have no draft yet. */
  app.get(`${api}/trades/:id/card.jpg`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const trade = await getTrade(id);
    if (!trade) throw new HttpError(404, "сделка не найдена");
    if (trade.status !== "CLOSED") throw new HttpError(409, "карточка рисуется после закрытия позиции");
    let file: string | null = null;
    if (trade.card_asset_id) file = (await one<{ final_path: string | null }>(`SELECT final_path FROM media_assets WHERE id = $1`, [trade.card_asset_id]))?.final_path ?? null;
    if (!file || !existsSync(file) || (req.query as { fresh?: string }).fresh === "1") file = (await renderCardForTrade(trade, await loadSettings())).file;
    return reply.type("image/jpeg").header("cache-control", "private, max-age=60").send(createReadStream(file));
  });

  app.get(`${api}/market/moves`, async () => {
    const settings = await loadSettings();
    const moves = await listMoves(80);
    const jobs = await draftJobs("market:draft", "moveId", moves.map((m) => m.id));
    return { settings: settings.movers, moves: moves.map((m) => ({ ...m, job: jobs.get(m.id) ?? null })) };
  });

  app.post(`${api}/market/scan`, async () => ({ queued: true, jobId: await enqueue("market", "market:scan", {}, { jobId: `market-scan-manual-${Date.now()}`, priority: 1, attempts: 1 }) }));

  app.post(`${api}/market/moves/:id/draft`, async (req) => {
    const { id } = req.params as { id: string };
    if (!(await getMove(id))) throw new HttpError(404, "движение не найдено");
    // The reason of the previous attempt is dropped: the row must not show a stale failure while this one runs.
    await query(`UPDATE market_moves SET reason = NULL WHERE id = $1`, [id]);
    const jobId = await enqueue("market", "market:draft", { moveId: id }, { jobId: `market-draft-${id}-${Date.now()}`, priority: 1, attempts: 2 });
    await recordQueued("market", jobId, "market:draft", { moveId: id });
    return { queued: true, jobId };
  });
}
