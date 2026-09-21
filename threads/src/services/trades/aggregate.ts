/**
 * Fills → round-trip trades. A trade is one position lifecycle on one coin: it opens when the
 * position leaves zero and closes when it returns to zero (or flips through it). Pure and
 * deterministic, so re-running it over the same fills always rebuilds the same trades.
 */
export interface FillInput {
  tid: number;
  coin: string;
  /** B = buy, A = sell. */
  side: "B" | "A";
  px: number;
  sz: number;
  /** Signed position size before this fill. */
  startPosition: number;
  closedPnl: number;
  fee: number;
  hash: string | null;
  time: Date;
}

export interface BuiltTrade {
  coin: string;
  direction: "LONG" | "SHORT";
  status: "OPEN" | "CLOSED";
  openedAt: Date;
  closedAt: Date | null;
  entryPx: number;
  exitPx: number | null;
  maxSize: number;
  /** Notional of everything that was bought/sold to build the position. */
  entryNotional: number;
  closedPnl: number;
  fees: number;
  netPnl: number;
  /** Price move in the trade's favour, percent. */
  movePct: number | null;
  fillsCount: number;
  firstTid: number;
  lastTid: number;
  lastHash: string | null;
}

interface Acc {
  coin: string;
  direction: "LONG" | "SHORT";
  openedAt: Date;
  openQty: number;
  openNotional: number;
  closeQty: number;
  closeNotional: number;
  maxSize: number;
  closedPnl: number;
  fees: number;
  fills: number;
  firstTid: number;
  lastTid: number;
  lastHash: string | null;
  lastTime: Date;
}

const EPS = 1e-9;
const round = (v: number, digits = 8): number => Math.round(v * 10 ** digits) / 10 ** digits;

function finish(a: Acc, closed: boolean): BuiltTrade {
  const entryPx = a.openQty > 0 ? a.openNotional / a.openQty : 0;
  const exitPx = a.closeQty > 0 ? a.closeNotional / a.closeQty : null;
  const movePct = exitPx !== null && entryPx > 0 ? ((exitPx - entryPx) / entryPx) * 100 * (a.direction === "LONG" ? 1 : -1) : null;
  return {
    coin: a.coin,
    direction: a.direction,
    status: closed ? "CLOSED" : "OPEN",
    openedAt: a.openedAt,
    closedAt: closed ? a.lastTime : null,
    entryPx: round(entryPx),
    exitPx: exitPx === null ? null : round(exitPx),
    maxSize: round(a.maxSize),
    entryNotional: round(a.openNotional, 4),
    closedPnl: round(a.closedPnl, 4),
    fees: round(a.fees, 4),
    netPnl: round(a.closedPnl - a.fees, 4),
    movePct: movePct === null ? null : round(movePct, 4),
    fillsCount: a.fills,
    firstTid: a.firstTid,
    lastTid: a.lastTid,
    lastHash: a.lastHash,
  };
}

/** Trades of ONE coin. Fills whose opening is outside the window (history cut off) are ignored until the position is flat. */
export function buildTradesForCoin(fills: FillInput[]): BuiltTrade[] {
  const sorted = [...fills].sort((a, b) => a.time.getTime() - b.time.getTime() || a.tid - b.tid);
  const out: BuiltTrade[] = [];
  let acc: Acc | null = null;
  const open = (f: FillInput, qty: number, signed: number, feeShare: number): Acc => ({
    coin: f.coin,
    direction: signed > 0 ? "LONG" : "SHORT",
    openedAt: f.time,
    openQty: qty,
    openNotional: qty * f.px,
    closeQty: 0,
    closeNotional: 0,
    maxSize: qty,
    closedPnl: 0,
    fees: feeShare,
    fills: 1,
    firstTid: f.tid,
    lastTid: f.tid,
    lastHash: f.hash,
    lastTime: f.time,
  });

  for (const f of sorted) {
    if (!(f.sz > 0) || !(f.px > 0)) continue;
    const signed = f.side === "B" ? f.sz : -f.sz;
    const start = Math.abs(f.startPosition) < EPS ? 0 : f.startPosition;
    let end = start + signed;
    if (Math.abs(end) < EPS) end = 0;

    if (start === 0) {
      // A flat start always begins a new trade; an unfinished accumulator means fills were missed.
      acc = open(f, f.sz, signed, f.fee);
      continue;
    }
    if (!acc) continue; // position was opened before the window: its entry is unknown
    acc.fills++;
    acc.lastTid = f.tid;
    acc.lastHash = f.hash;
    acc.lastTime = f.time;

    const sameSide = Math.sign(start) === Math.sign(signed);
    if (sameSide) {
      acc.openQty += f.sz;
      acc.openNotional += f.sz * f.px;
      acc.fees += f.fee;
      acc.maxSize = Math.max(acc.maxSize, Math.abs(end));
      continue;
    }
    const closing = Math.min(f.sz, Math.abs(start));
    const closingShare = closing / f.sz;
    acc.closeQty += closing;
    acc.closeNotional += closing * f.px;
    acc.closedPnl += f.closedPnl;
    acc.fees += f.fee * closingShare;
    if (end === 0 || Math.sign(end) !== Math.sign(start)) {
      out.push(finish(acc, true));
      acc = null;
      // A flip: the rest of this fill opens the opposite position at the same price.
      const rest = f.sz - closing;
      if (rest > EPS) acc = open(f, rest, signed, f.fee * (1 - closingShare));
    }
  }
  if (acc) out.push(finish(acc, false));
  return out;
}

export function buildTrades(fills: FillInput[]): BuiltTrade[] {
  const byCoin = new Map<string, FillInput[]>();
  for (const f of fills) {
    const list = byCoin.get(f.coin) ?? [];
    list.push(f);
    byCoin.set(f.coin, list);
  }
  return [...byCoin.values()].flatMap(buildTradesForCoin).sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
}

/** Return on the margin actually put up: net PnL over (largest position notional / leverage). */
export function roePct(trade: Pick<BuiltTrade, "netPnl" | "maxSize" | "entryPx">, leverage: number | null): number | null {
  if (!leverage || leverage <= 0) return null;
  const margin = (trade.maxSize * trade.entryPx) / leverage;
  return margin > 0 ? Math.round((trade.netPnl / margin) * 10_000) / 100 : null;
}

export interface TradeThresholds {
  minPnlUsd: number;
  minRoePct: number;
  requireBoth: boolean;
}

/** Only closed, profitable trades above the owner's bar are worth a post. */
export function worthPosting(trade: { status: string; netPnl: number; roePct: number | null; movePct: number | null }, t: TradeThresholds): { ok: boolean; reason: string } {
  if (trade.status !== "CLOSED") return { ok: false, reason: "позиция ещё открыта" };
  if (!(trade.netPnl > 0)) return { ok: false, reason: "сделка не в плюсе" };
  const pnlOk = trade.netPnl >= t.minPnlUsd;
  // Without a known leverage the raw price move stands in for ROE (it can only understate it).
  const roe = trade.roePct ?? trade.movePct ?? 0;
  const roeOk = roe >= t.minRoePct;
  const ok = t.requireBoth ? pnlOk && roeOk : pnlOk || roeOk;
  if (ok) return { ok: true, reason: "" };
  return { ok: false, reason: `ниже порога: PnL $${trade.netPnl.toFixed(2)} (нужно ${t.minPnlUsd}), доходность ${roe.toFixed(1)}% (нужно ${t.minRoePct}%)` };
}
