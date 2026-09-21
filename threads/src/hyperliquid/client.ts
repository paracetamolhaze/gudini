import { env } from "../config/env.js";
import { delay } from "../shared/ids.js";

/**
 * Hyperliquid public info API (POST /info). Everything here is read-only and keyed by a public
 * wallet address: no private key, no signature, no way to move funds.
 */
export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  feeToken?: string;
}

export interface HlPosition {
  coin: string;
  szi: string;
  entryPx: string | null;
  leverage: { type: string; value: number };
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
}

export interface HlClearinghouseState {
  assetPositions: Array<{ position: HlPosition }>;
  marginSummary?: { accountValue: string };
}

export interface HlCandle {
  t: number;
  T: number;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
}

export interface HlAssetCtx {
  name: string;
  markPx: number | null;
  prevDayPx: number | null;
  dayNtlVlm: number | null;
  funding: number | null;
  openInterest: number | null;
}

export class HyperliquidError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "HyperliquidError";
    this.status = status;
    this.retryable = retryable;
  }
}

export const isWalletAddress = (v: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(v.trim());

/** Perps only: spot pairs are named "@107" or "PURR/USDC" and have no position to open or close. */
export const isPerpCoin = (coin: string): boolean => !coin.startsWith("@") && !coin.includes("/");

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export class HyperliquidClient {
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { host?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.host = (opts.host ?? "https://api.hyperliquid.xyz").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async info<T>(body: Record<string, unknown>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.host}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
        const text = await res.text();
        if (!res.ok) throw new HyperliquidError(`Hyperliquid ${body.type}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status, res.status === 429 || res.status >= 500);
        return JSON.parse(text) as T;
      } catch (err) {
        lastError = err instanceof HyperliquidError ? err : new HyperliquidError(`Hyperliquid ${String(body.type)} unreachable: ${err instanceof Error ? err.message : String(err)}`, 0, true);
        if (!(lastError as HyperliquidError).retryable || attempt === 2) throw lastError;
        await delay(700 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  /** Fills since `startTime`, oldest first. The API returns at most 2000 per call; page forward by time. */
  async userFillsSince(user: string, startTime: number, maxPages = 5): Promise<HlFill[]> {
    const out = new Map<number, HlFill>();
    let from = startTime;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.info<HlFill[]>({ type: "userFillsByTime", user, startTime: from, aggregateByTime: false });
      if (!Array.isArray(batch) || !batch.length) break;
      for (const f of batch) out.set(f.tid, f);
      if (batch.length < 2000) break;
      const newest = Math.max(...batch.map((f) => f.time));
      if (newest <= from) break;
      from = newest;
    }
    return [...out.values()].sort((a, b) => a.time - b.time || a.tid - b.tid);
  }

  async clearinghouseState(user: string): Promise<HlClearinghouseState> {
    return this.info<HlClearinghouseState>({ type: "clearinghouseState", user });
  }

  /** The leverage setting of `coin` for this user — known even when no position is open. */
  async leverageFor(user: string, coin: string): Promise<number | null> {
    const res = await this.info<{ leverage?: { value?: number } }>({ type: "activeAssetData", user, coin });
    return typeof res?.leverage?.value === "number" ? res.leverage.value : null;
  }

  async candles(coin: string, interval: string, startTime: number, endTime: number): Promise<HlCandle[]> {
    const res = await this.info<HlCandle[]>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } });
    return Array.isArray(res) ? res : [];
  }

  async assetContexts(): Promise<HlAssetCtx[]> {
    const res = await this.info<[{ universe: Array<{ name: string }> }, Array<Record<string, unknown>>]>({ type: "metaAndAssetCtxs" });
    const universe = res?.[0]?.universe ?? [];
    const ctxs = res?.[1] ?? [];
    return universe.map((u, i) => ({ name: u.name, markPx: num(ctxs[i]?.markPx), prevDayPx: num(ctxs[i]?.prevDayPx), dayNtlVlm: num(ctxs[i]?.dayNtlVlm), funding: num(ctxs[i]?.funding), openInterest: num(ctxs[i]?.openInterest) }));
  }
}

let shared: HyperliquidClient | null = null;
export function hyperliquid(): HyperliquidClient {
  if (!shared) shared = new HyperliquidClient({ host: env().HYPERLIQUID_API_HOST });
  return shared;
}
export function setHyperliquidForTests(next: HyperliquidClient | null): void {
  shared = next;
}
