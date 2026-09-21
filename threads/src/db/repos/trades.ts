import { one, query } from "../pool.js";
import type { HlFill } from "../../hyperliquid/client.js";
import type { BuiltTrade, FillInput } from "../../services/trades/aggregate.js";

/** NONE — not considered yet; SKIPPED — below the bar / dismissed; DRAFTED — a draft exists; POSTED — it went out. */
export type TradePostStatus = "NONE" | "SKIPPED" | "DRAFTED" | "POSTED";

export interface TradeRow {
  id: string;
  wallet: string;
  coin: string;
  direction: "LONG" | "SHORT";
  status: "OPEN" | "CLOSED";
  opened_at: Date;
  closed_at: Date | null;
  entry_px: number;
  exit_px: number | null;
  max_size: number;
  entry_notional: number;
  closed_pnl: number;
  fees: number;
  net_pnl: number;
  leverage: number | null;
  roe_pct: number | null;
  move_pct: number | null;
  fills_count: number;
  first_tid: string;
  last_tid: string | null;
  last_hash: string | null;
  post_status: TradePostStatus;
  skip_reason: string | null;
  note: string | null;
  draft_id: string | null;
  card_asset_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const NUMERIC = ["entry_px", "exit_px", "max_size", "entry_notional", "closed_pnl", "fees", "net_pnl", "leverage", "roe_pct", "move_pct"] as const;

/** pg returns numeric as string; trades are small numbers, so plain JS numbers are fine. */
function normalize(row: TradeRow | null): TradeRow | null {
  if (!row) return null;
  const r = row as unknown as Record<string, unknown>;
  for (const k of NUMERIC) r[k] = r[k] === null || r[k] === undefined ? null : Number(r[k]);
  return row;
}

export async function insertFills(wallet: string, fills: HlFill[]): Promise<{ inserted: number; coins: string[] }> {
  let inserted = 0;
  const coins = new Set<string>();
  for (const f of fills) {
    const rows = await query(
      `INSERT INTO hl_fills (tid, wallet, coin, side, dir, px, sz, start_position, closed_pnl, fee, fee_token, hash, oid, crossed, time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, to_timestamp($15 / 1000.0))
       ON CONFLICT (tid) DO NOTHING RETURNING tid`,
      [f.tid, wallet, f.coin, f.side, f.dir ?? "", f.px, f.sz, f.startPosition ?? "0", f.closedPnl ?? "0", f.fee ?? "0", f.feeToken ?? null, f.hash ?? null, f.oid ?? null, f.crossed ?? null, f.time],
    );
    if (rows.length) {
      inserted++;
      coins.add(f.coin);
    }
  }
  return { inserted, coins: [...coins] };
}

export async function lastFillTime(wallet: string): Promise<Date | null> {
  const row = await one<{ t: Date | null }>(`SELECT max(time) AS t FROM hl_fills WHERE wallet = $1`, [wallet]);
  return row?.t ?? null;
}

export async function fillsForCoin(wallet: string, coin: string): Promise<FillInput[]> {
  const rows = await query<{ tid: string; coin: string; side: "B" | "A"; px: string; sz: string; start_position: string; closed_pnl: string; fee: string; fee_token: string | null; hash: string | null; time: Date }>(
    `SELECT tid, coin, side, px, sz, start_position, closed_pnl, fee, fee_token, hash, time FROM hl_fills WHERE wallet = $1 AND coin = $2 ORDER BY time ASC, tid ASC`,
    [wallet, coin],
  );
  // Perp fees are charged in USDC; a fee in another token (spot) is not part of the perp PnL.
  return rows.map((r) => ({ tid: Number(r.tid), coin: r.coin, side: r.side, px: Number(r.px), sz: Number(r.sz), startPosition: Number(r.start_position), closedPnl: Number(r.closed_pnl), fee: !r.fee_token || r.fee_token === "USDC" ? Number(r.fee) : 0, hash: r.hash, time: r.time }));
}

/** Rebuilt trades are matched by their first fill, so owner-made fields (note, draft, post status) survive. */
export async function upsertTrade(wallet: string, t: BuiltTrade, leverage: number | null, roe: number | null): Promise<{ row: TradeRow; justClosed: boolean }> {
  const before = await one<{ status: string }>(`SELECT status FROM hl_trades WHERE wallet = $1 AND coin = $2 AND first_tid = $3`, [wallet, t.coin, t.firstTid]);
  const row = normalize(
    await one<TradeRow>(
      `INSERT INTO hl_trades (wallet, coin, direction, status, opened_at, closed_at, entry_px, exit_px, max_size, entry_notional, closed_pnl, fees, net_pnl, leverage, roe_pct, move_pct, fills_count, first_tid, last_tid, last_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (wallet, coin, first_tid) DO UPDATE SET status = EXCLUDED.status, closed_at = EXCLUDED.closed_at, entry_px = EXCLUDED.entry_px, exit_px = EXCLUDED.exit_px,
         max_size = EXCLUDED.max_size, entry_notional = EXCLUDED.entry_notional, closed_pnl = EXCLUDED.closed_pnl, fees = EXCLUDED.fees, net_pnl = EXCLUDED.net_pnl,
         leverage = COALESCE(EXCLUDED.leverage, hl_trades.leverage), roe_pct = COALESCE(EXCLUDED.roe_pct, hl_trades.roe_pct), move_pct = EXCLUDED.move_pct,
         fills_count = EXCLUDED.fills_count, last_tid = EXCLUDED.last_tid, last_hash = EXCLUDED.last_hash, updated_at = now()
       RETURNING *`,
      [wallet, t.coin, t.direction, t.status, t.openedAt, t.closedAt, t.entryPx, t.exitPx, t.maxSize, t.entryNotional, t.closedPnl, t.fees, t.netPnl, leverage, roe, t.movePct, t.fillsCount, t.firstTid, t.lastTid, t.lastHash],
    ),
  );
  if (!row) throw new Error("upsert trade failed");
  return { row, justClosed: t.status === "CLOSED" && before?.status !== "CLOSED" };
}

export async function getTrade(id: string): Promise<TradeRow | null> {
  return normalize(await one<TradeRow>(`SELECT * FROM hl_trades WHERE id = $1`, [id]));
}

export async function listTrades(opts: { wallet?: string; status?: string; limit?: number } = {}): Promise<TradeRow[]> {
  const rows = await query<TradeRow>(
    `SELECT * FROM hl_trades WHERE ($1::text IS NULL OR wallet = $1) AND ($2::text IS NULL OR status = $2) ORDER BY COALESCE(closed_at, opened_at) DESC LIMIT $3`,
    [opts.wallet ?? null, opts.status ?? null, Math.min(300, opts.limit ?? 100)],
  );
  return rows.map((r) => normalize(r)!);
}

export async function updateTrade(id: string, patch: Partial<{ post_status: TradePostStatus; skip_reason: string | null; note: string | null; draft_id: string | null; card_asset_id: string | null; leverage: number | null; roe_pct: number | null }>): Promise<TradeRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) return getTrade(id);
  params.push(id);
  return normalize(await one<TradeRow>(`UPDATE hl_trades SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params));
}

export async function rememberLeverage(wallet: string, coin: string, leverage: number): Promise<void> {
  await query(`INSERT INTO hl_leverage (wallet, coin, leverage) VALUES ($1,$2,$3) ON CONFLICT (wallet, coin) DO UPDATE SET leverage = EXCLUDED.leverage, seen_at = now()`, [wallet, coin, leverage]);
}

export async function knownLeverage(wallet: string, coin: string): Promise<number | null> {
  const row = await one<{ leverage: string }>(`SELECT leverage FROM hl_leverage WHERE wallet = $1 AND coin = $2`, [wallet, coin]);
  return row ? Number(row.leverage) : null;
}

export async function tradePostsToday(timezone: string): Promise<number> {
  const row = await one<{ n: number }>(`SELECT count(*)::int AS n FROM drafts WHERE kind = 'TRADE' AND status NOT IN ('REJECTED','FAILED','EXPIRED') AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`, [timezone]);
  return row?.n ?? 0;
}

export async function tradeStats(wallet: string, days = 30): Promise<{ closed: number; wins: number; net_pnl: number; best: number | null }> {
  const row = await one<{ closed: number; wins: number; net_pnl: string | null; best: string | null }>(
    `SELECT count(*)::int AS closed, count(*) FILTER (WHERE net_pnl > 0)::int AS wins, sum(net_pnl) AS net_pnl, max(net_pnl) AS best FROM hl_trades WHERE wallet = $1 AND status = 'CLOSED' AND closed_at >= now() - make_interval(days => $2)`,
    [wallet, days],
  );
  return { closed: row?.closed ?? 0, wins: row?.wins ?? 0, net_pnl: Number(row?.net_pnl ?? 0), best: row?.best === null || row?.best === undefined ? null : Number(row.best) };
}
