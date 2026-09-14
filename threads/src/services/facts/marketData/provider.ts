/**
 * Market data abstraction. The fact checker only knows this interface; CoinGecko is the first
 * implementation and others (CoinMarketCap, exchange APIs) can be added without touching callers.
 */
export interface AssetQuote {
  symbol: string;
  name: string;
  priceUsd: number | null;
  change24hPct: number | null;
  change7dPct: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  fetchedAt: Date;
  provider: string;
}

export interface MarketDataProvider {
  readonly name: string;
  /** Resolve a ticker or project name; null when unknown. Never throws for "not found". */
  getQuote(symbolOrName: string): Promise<AssetQuote | null>;
}

export class MarketDataError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "MarketDataError";
    this.retryable = retryable;
  }
}
