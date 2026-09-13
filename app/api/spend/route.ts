import { NextResponse } from "next/server";
import { readManualBalances, readSpendLog } from "@/lib/spendLog";
import { spendRuns as carouselSpendRuns } from "@/lib/carousel/spend";

export const dynamic = "force-dynamic";

/** Журнал за последние 62 дня и ручные остатки — без опроса провайдеров (для главной). */
export async function GET() {
  const since = Date.now() - 62 * 24 * 60 * 60 * 1000;
  // расходы каруселей — из их собственного журнала, отдельной категорией «carousel»; журнал роликов не меняется
  return NextResponse.json({
    spend: [...readSpendLog().filter((r) => Date.parse(r.at) >= since), ...carouselSpendRuns(since)],
    manual: readManualBalances(),
  });
}
