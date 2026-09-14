import type { VerifiedFact } from "../analysis/schemas.js";
import type { MarketDataProvider } from "../facts/marketData/provider.js";
import { extractNumbers } from "../writer/validate.js";

/**
 * Time-sensitive numbers (price, % move, market cap) are re-fetched right before publishing.
 * A draft whose text still carries a stale value is not sent as-is: the caller either refreshes
 * the facts and regenerates or routes the draft to review.
 */
export interface FreshnessResult {
  fresh: boolean;
  drifted: Array<{ claim: string; textValue: number; liveValue: number; driftPct: number; asset: string }>;
  updatedFacts: VerifiedFact[];
  checkedAt: string;
  providerErrors: string[];
}

export async function recheckDynamicFacts(text: string, facts: VerifiedFact[], provider: MarketDataProvider, opts: { priceDriftPct?: number; pctPointDrift?: number } = {}): Promise<FreshnessResult> {
  const priceDrift = opts.priceDriftPct ?? 3;
  const pctDrift = opts.pctPointDrift ?? 2;
  const numbers = extractNumbers(text);
  const drifted: FreshnessResult["drifted"] = [];
  const providerErrors: string[] = [];
  const updated: VerifiedFact[] = [];
  const checkedAt = new Date().toISOString();
  for (const f of facts) {
    if (!f.isDynamic || !f.asset || f.value === null) {
      updated.push(f);
      continue;
    }
    const inText = numbers.some((n) => Math.abs(n.value - f.value!) <= Math.max(Math.abs(f.value!) * 0.015, 0.005));
    if (!inText) {
      updated.push(f);
      continue;
    }
    let quote;
    try {
      quote = await provider.getQuote(f.asset);
    } catch (err) {
      providerErrors.push(`${f.asset}: ${err instanceof Error ? err.message : String(err)}`);
      updated.push(f);
      continue;
    }
    if (!quote) {
      updated.push(f);
      continue;
    }
    const unit = (f.unit ?? "").toLowerCase();
    const claim = f.claim.toLowerCase();
    let live: number | null = null;
    let tolerance = priceDrift;
    let absolute = false;
    if (/percent|%/.test(unit)) {
      live = quote.change24hPct;
      tolerance = pctDrift;
      absolute = true;
    } else if (/market cap|mcap/.test(claim)) live = quote.marketCapUsd;
    else if (/volume/.test(claim)) live = quote.volume24hUsd;
    else if (f.type === "price" || /price|trading|hits|above|below|around/.test(claim)) live = quote.priceUsd;
    if (live === null) {
      updated.push(f);
      continue;
    }
    const drift = absolute ? Math.abs(live - f.value) : (Math.abs(live - f.value) / Math.max(1e-9, Math.abs(f.value))) * 100;
    if (drift > tolerance) {
      drifted.push({ claim: f.claim, textValue: f.value, liveValue: live, driftPct: Math.round(drift * 100) / 100, asset: f.asset });
      updated.push({
        ...f,
        value: absolute ? Math.round(live * 100) / 100 : live,
        claim: `${f.claim} → актуально на ${checkedAt.slice(0, 16).replace("T", " ")} UTC: ${absolute ? `${live.toFixed(2)}%` : `$${Math.round(live).toLocaleString("en-US")}`}`,
        status: "VERIFIED",
        evidence: `обновлено перед публикацией по ${quote.provider}`,
        observedValue: live,
        checkedAt,
      });
    } else {
      updated.push({ ...f, observedValue: live, checkedAt, status: f.status === "CONTRADICTED" ? f.status : "VERIFIED", evidence: `актуально по ${quote.provider} (${checkedAt.slice(11, 16)} UTC)` });
    }
  }
  return { fresh: drifted.length === 0, drifted, updatedFacts: updated, checkedAt, providerErrors };
}
