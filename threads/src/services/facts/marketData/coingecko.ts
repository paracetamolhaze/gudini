import { MarketDataError, type AssetQuote, type MarketDataProvider } from "./provider.js";

/**
 * CoinGecko public API (no key; ~30 requests/minute). Ticker → coin id resolution goes through
 * a small built-in map for the majors plus /search for everything else; quotes are cached for a
 * minute so one fact check does not burn the quota.
 */
const KNOWN: Record<string, string> = {
  btc: "bitcoin",
  bitcoin: "bitcoin",
  eth: "ethereum",
  ethereum: "ethereum",
  sol: "solana",
  solana: "solana",
  xrp: "ripple",
  bnb: "binancecoin",
  usdt: "tether",
  tether: "tether",
  usdc: "usd-coin",
  ada: "cardano",
  doge: "dogecoin",
  dogecoin: "dogecoin",
  ton: "the-open-network",
  trx: "tron",
  avax: "avalanche-2",
  link: "chainlink",
  dot: "polkadot",
  matic: "matic-network",
  pol: "polygon-ecosystem-token",
  ltc: "litecoin",
  shib: "shiba-inu",
  sui: "sui",
  apt: "aptos",
  arb: "arbitrum",
  op: "optimism",
  near: "near",
  atom: "cosmos",
  uni: "uniswap",
  aave: "aave",
  pepe: "pepe",
  wif: "dogwifcoin",
  hype: "hyperliquid",
  ena: "ethena",
  ondo: "ondo-finance",
  tao: "bittensor",
  fet: "fetch-ai",
  render: "render-token",
};

interface Cached {
  at: number;
  quote: AssetQuote | null;
}

export class CoinGeckoProvider implements MarketDataProvider {
  readonly name = "coingecko";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, Cached>();
  private readonly idCache = new Map<string, string | null>();
  private readonly ttlMs: number;

  constructor(opts: { baseUrl?: string; fetchImpl?: typeof fetch; ttlMs?: number; apiKey?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.coingecko.com/api/v3").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.ttlMs = opts.ttlMs ?? 60_000;
  }

  private async getJson(path: string): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { accept: "application/json", "user-agent": "gudini-threads/0.1" }, signal: ctrl.signal });
      if (res.status === 429) throw new MarketDataError("CoinGecko rate limit (429)", true);
      if (!res.ok) throw new MarketDataError(`CoinGecko HTTP ${res.status}`, res.status >= 500);
      return await res.json();
    } catch (err) {
      if (err instanceof MarketDataError) throw err;
      throw new MarketDataError(`CoinGecko unreachable: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveId(symbolOrName: string): Promise<string | null> {
    const key = symbolOrName.trim().toLowerCase().replace(/^\$/, "");
    if (!key) return null;
    if (KNOWN[key]) return KNOWN[key]!;
    if (this.idCache.has(key)) return this.idCache.get(key) ?? null;
    const data = (await this.getJson(`/search?query=${encodeURIComponent(key)}`)) as { coins?: Array<{ id?: string; symbol?: string; name?: string; market_cap_rank?: number | null }> };
    const coins = (data.coins ?? []).filter((c) => typeof c.id === "string");
    // Exact symbol match first (highest market-cap rank), then exact name, else nothing: guessing is worse than not checking.
    const bySymbol = coins.filter((c) => (c.symbol ?? "").toLowerCase() === key).sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
    const byName = coins.filter((c) => (c.name ?? "").toLowerCase() === key);
    const pick = bySymbol[0]?.id ?? byName[0]?.id ?? null;
    this.idCache.set(key, pick);
    return pick;
  }

  async getQuote(symbolOrName: string): Promise<AssetQuote | null> {
    const id = await this.resolveId(symbolOrName);
    if (!id) return null;
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.quote;
    const data = (await this.getJson(`/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}&price_change_percentage=24h,7d`)) as Array<Record<string, unknown>>;
    const row = Array.isArray(data) ? data[0] : undefined;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const quote: AssetQuote | null = row
      ? {
          symbol: String(row.symbol ?? "").toUpperCase(),
          name: String(row.name ?? id),
          priceUsd: num(row.current_price),
          change24hPct: num(row.price_change_percentage_24h_in_currency) ?? num(row.price_change_percentage_24h),
          change7dPct: num(row.price_change_percentage_7d_in_currency),
          marketCapUsd: num(row.market_cap),
          volume24hUsd: num(row.total_volume),
          fetchedAt: new Date(),
          provider: this.name,
        }
      : null;
    this.cache.set(id, { at: Date.now(), quote });
    return quote;
  }
}

let shared: MarketDataProvider | null = null;
export function marketData(): MarketDataProvider {
  if (!shared) shared = new CoinGeckoProvider();
  return shared;
}
export function setMarketDataForTests(p: MarketDataProvider | null): void {
  shared = p;
}
