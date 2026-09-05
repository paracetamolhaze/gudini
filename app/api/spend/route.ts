import { NextResponse } from "next/server";
import { readManualBalances, readSpendLog } from "@/lib/spendLog";

export const dynamic = "force-dynamic";

/** Журнал за последние 62 дня и ручные остатки — без опроса провайдеров (для главной). */
export async function GET() {
  const since = Date.now() - 62 * 24 * 60 * 60 * 1000;
  return NextResponse.json({
    spend: readSpendLog().filter((r) => Date.parse(r.at) >= since),
    manual: readManualBalances(),
  });
}
