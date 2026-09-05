import { NextRequest, NextResponse } from "next/server";
import { collectBalances, ProviderBalance } from "@/lib/balances";
import { readManualBalances, readSpendLog } from "@/lib/spendLog";

export const dynamic = "force-dynamic";

/** Кэш опроса провайдеров на 10 минут: пять сетевых запросов, а запрос к Brave платный. */
const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; balances: ProviderBalance[] } | null = null;
let inFlight: Promise<ProviderBalance[]> | null = null;

/** Журнал за последние 62 дня: «сегодня» и «за месяц» считает клиент в своём часовом поясе. */
const SPEND_WINDOW_MS = 62 * 24 * 60 * 60 * 1000;

/** GET /api/balances — остатки по API, журнал расходов и введённые вручную остатки. ?refresh=1 опрашивает заново. */
export async function GET(req: NextRequest) {
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  let cached = true;
  if (refresh || !cache || Date.now() - cache.at >= CACHE_MS) {
    if (!inFlight) {
      inFlight = collectBalances().finally(() => {
        inFlight = null;
      });
    }
    const balances = await inFlight;
    cache = { at: Date.now(), balances };
    cached = false;
  }
  // журнал и ручные остатки читаются каждый раз: они меняются после каждого прогона
  const since = Date.now() - SPEND_WINDOW_MS;
  const spend = readSpendLog().filter((r) => Date.parse(r.at) >= since);
  return NextResponse.json({
    balances: cache!.balances,
    checkedAt: new Date(cache!.at).toISOString(),
    cached,
    spend,
    manual: readManualBalances(),
  });
}
