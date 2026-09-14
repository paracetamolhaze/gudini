import type { Fact, VerifiedFact, FactStatus } from "../analysis/schemas.js";
import { MarketDataError, type AssetQuote, type MarketDataProvider } from "./marketData/provider.js";

/**
 * Independent verification of extracted claims. What can be checked against market data is
 * checked; everything else is labelled UNVERIFIED (kept with attribution) or NOT_CHECKABLE.
 * A number that cannot be confirmed is never promoted to an established fact.
 */
export interface FactCheckOptions {
  /** Relative tolerance for prices/market caps (0.06 = 6%). Sources round, snapshots differ by hours. */
  priceTolerance?: number;
  /** Absolute tolerance in percentage points for "% change" claims. */
  percentTolerance?: number;
  now?: Date;
}

const PRICE_UNITS = new Set(["usd", "$", "dollars", "usdt", "usdc"]);
const PCT_UNITS = new Set(["percent", "%", "pct"]);

function classify(fact: Fact): "price" | "marketcap" | "volume" | "pct24h" | "other" {
  const claim = fact.claim.toLowerCase();
  const unit = (fact.unit ?? "").toLowerCase();
  if (fact.type === "price" || (PRICE_UNITS.has(unit) && /price|trading at|hits|reaches|above|below|breaks|\$/.test(claim) && !/market cap|volume|inflow|outflow|raised|hack|stolen|tvl|unlock/.test(claim))) return "price";
  if (/market cap|market capitalization|mcap/.test(claim) && PRICE_UNITS.has(unit)) return "marketcap";
  if (/24h volume|daily volume|trading volume/.test(claim) && PRICE_UNITS.has(unit)) return "volume";
  if (PCT_UNITS.has(unit) && /24h|24 hours|today|past day|daily/.test(claim) && /up|down|gain|drop|fell|rose|jump|plunge|rally|surge/.test(claim)) return "pct24h";
  return "other";
}

function within(observed: number | null, claimed: number, relTol: number): boolean {
  if (observed === null || !Number.isFinite(observed) || !Number.isFinite(claimed) || claimed === 0) return false;
  return Math.abs(observed - claimed) / Math.abs(claimed) <= relTol;
}

export async function checkFacts(facts: Fact[], provider: MarketDataProvider, opts: FactCheckOptions = {}): Promise<{ facts: VerifiedFact[]; providerErrors: string[] }> {
  const relTol = opts.priceTolerance ?? 0.06;
  const pctTol = opts.percentTolerance ?? 2.5;
  const now = (opts.now ?? new Date()).toISOString();
  const errors: string[] = [];
  const quotes = new Map<string, AssetQuote | null>();

  async function quoteFor(asset: string): Promise<AssetQuote | null | undefined> {
    const key = asset.toLowerCase();
    if (quotes.has(key)) return quotes.get(key);
    try {
      const q = await provider.getQuote(asset);
      quotes.set(key, q);
      return q;
    } catch (err) {
      const msg = err instanceof MarketDataError ? err.message : err instanceof Error ? err.message : String(err);
      errors.push(`${asset}: ${msg}`);
      quotes.set(key, null);
      return undefined; // provider failure, not "unknown asset"
    }
  }

  const out: VerifiedFact[] = [];
  for (const fact of facts) {
    const base: VerifiedFact = { ...fact, status: "NOT_CHECKABLE", evidence: null, observedValue: null, checkedAt: null };
    if (!fact.requiresVerification) {
      out.push({ ...base, status: fact.certainty === "FACT" ? "UNVERIFIED" : "NOT_CHECKABLE", evidence: fact.certainty === "FACT" ? "не требует независимой проверки, сохраняем атрибуцию" : `помечено как ${fact.certainty}` });
      continue;
    }
    const kind = classify(fact);
    if (kind === "other" || !fact.asset || fact.value === null) {
      out.push({ ...base, status: "UNVERIFIED", evidence: "нет независимого источника для проверки; в тексте — только с атрибуцией" });
      continue;
    }
    const quote = await quoteFor(fact.asset);
    if (quote === undefined) {
      out.push({ ...base, status: "UNVERIFIED", evidence: "поставщик рыночных данных недоступен; число остаётся с атрибуцией" });
      continue;
    }
    if (quote === null) {
      out.push({ ...base, status: "UNVERIFIED", evidence: `актив ${fact.asset} не найден у ${provider.name}` });
      continue;
    }
    let observed: number | null = null;
    let ok = false;
    let label = "";
    switch (kind) {
      case "price":
        observed = quote.priceUsd;
        ok = within(observed, fact.value, relTol);
        label = `цена ${quote.symbol} по ${provider.name}: $${fmt(observed)}`;
        break;
      case "marketcap":
        observed = quote.marketCapUsd;
        ok = within(observed, fact.value, relTol);
        label = `капитализация ${quote.symbol} по ${provider.name}: $${fmt(observed)}`;
        break;
      case "volume":
        observed = quote.volume24hUsd;
        ok = within(observed, fact.value, Math.max(relTol, 0.15));
        label = `объём 24ч ${quote.symbol} по ${provider.name}: $${fmt(observed)}`;
        break;
      case "pct24h":
        observed = quote.change24hPct;
        ok = observed !== null && Math.abs(observed - fact.value) <= pctTol && Math.sign(observed) === Math.sign(fact.value);
        label = `изменение 24ч ${quote.symbol} по ${provider.name}: ${observed === null ? "n/a" : `${observed.toFixed(2)}%`}`;
        break;
    }
    const status: FactStatus = observed === null ? "UNVERIFIED" : ok ? "VERIFIED" : "CONTRADICTED";
    out.push({ ...base, status, evidence: label, observedValue: observed, checkedAt: now });
  }
  return { facts: out, providerErrors: errors };
}

function fmt(n: number | null): string {
  if (n === null) return "n/a";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Facts safe to state without hedging: verified numbers plus non-numeric FACT claims from the source (with attribution). */
export function summarizeFactCheck(facts: VerifiedFact[]): { verified: number; unverified: number; contradicted: number; dynamic: number; hasContradiction: boolean } {
  return {
    verified: facts.filter((f) => f.status === "VERIFIED").length,
    unverified: facts.filter((f) => f.status === "UNVERIFIED").length,
    contradicted: facts.filter((f) => f.status === "CONTRADICTED").length,
    dynamic: facts.filter((f) => f.isDynamic).length,
    hasContradiction: facts.some((f) => f.status === "CONTRADICTED"),
  };
}
