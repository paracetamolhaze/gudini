import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { z } from "zod";
import { loadSettings } from "../../config/settings.js";
import { one } from "../../db/pool.js";
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

/** Hyperliquid trades (cards + posts) and market movers. */
export function registerTradeRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/trades`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const settings = await loadSettings();
    const wallet = tradeWallet(settings);
    const trades = wallet ? await listTrades({ wallet, status: q.status, limit: clampInt(q.limit, 1, 300, 100) }) : [];
    const thresholds = { minPnlUsd: settings.trades.minPnlUsd, minRoePct: settings.trades.minRoePct, requireBoth: settings.trades.requireBoth };
    return {
      wallet: wallet ? { short: shortWallet(wallet), valid: isWalletAddress(wallet) } : null,
      settings: settings.trades,
      stats: wallet ? await tradeStats(wallet, 30) : null,
      trades: trades.map((t) => ({ ...t, wallet: undefined, worth: worthPosting({ status: t.status, netPnl: t.net_pnl, roePct: t.roe_pct, movePct: t.move_pct }, thresholds) })),
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
    return { queued: true, jobId: await enqueue("trades", "trades:draft", { tradeId: id, manual: true }, { jobId: `trade-draft-${id}-${Date.now()}`, priority: 1, attempts: 2 }) };
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
    return { settings: settings.movers, moves: await listMoves(80) };
  });

  app.post(`${api}/market/scan`, async () => ({ queued: true, jobId: await enqueue("market", "market:scan", {}, { jobId: `market-scan-manual-${Date.now()}`, priority: 1, attempts: 1 }) }));

  app.post(`${api}/market/moves/:id/draft`, async (req) => {
    const { id } = req.params as { id: string };
    if (!(await getMove(id))) throw new HttpError(404, "движение не найдено");
    return { queued: true, jobId: await enqueue("market", "market:draft", { moveId: id }, { jobId: `market-draft-${id}-${Date.now()}`, priority: 1, attempts: 2 }) };
  });
}
