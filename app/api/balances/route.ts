import { NextRequest, NextResponse } from "next/server";
import { collectBalances, ProviderBalance } from "@/lib/balances";

export const dynamic = "force-dynamic";

/** Кэш на 10 минут: опрос идёт к пяти провайдерам, а запрос к Brave платный. */
const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; balances: ProviderBalance[] } | null = null;
let inFlight: Promise<ProviderBalance[]> | null = null;

/** GET /api/balances — остатки по всем используемым API. ?refresh=1 обновляет принудительно. */
export async function GET(req: NextRequest) {
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json({ balances: cache.balances, checkedAt: new Date(cache.at).toISOString(), cached: true });
  }
  if (!inFlight) {
    inFlight = collectBalances().finally(() => {
      inFlight = null;
    });
  }
  const balances = await inFlight;
  cache = { at: Date.now(), balances };
  return NextResponse.json({ balances, checkedAt: new Date(cache.at).toISOString(), cached: false });
}
