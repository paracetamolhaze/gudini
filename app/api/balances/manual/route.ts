import { NextRequest, NextResponse } from "next/server";
import { isCostProvider, readManualBalances, setManualBalance } from "@/lib/spendLog";

export const dynamic = "force-dynamic";

/**
 * Остаток из консоли провайдера, введённый вручную: POST { provider, balance }.
 * Момент ввода становится точкой отсчёта — дальше остаток = введённое − расход по журналу.
 * DELETE ?provider=… убирает введённое значение.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const provider = body.provider;
  const balance = Number(body.balance);
  if (!isCostProvider(provider)) return NextResponse.json({ error: "Неизвестный провайдер" }, { status: 400 });
  if (!Number.isFinite(balance) || balance < 0 || balance > 1_000_000) {
    return NextResponse.json({ error: "Остаток — число в долларах, например 12.5" }, { status: 400 });
  }
  return NextResponse.json({ manual: setManualBalance(provider, balance) });
}

export async function DELETE(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider");
  if (!isCostProvider(provider)) return NextResponse.json({ error: "Неизвестный провайдер" }, { status: 400 });
  return NextResponse.json({ manual: setManualBalance(provider, null) });
}

export async function GET() {
  return NextResponse.json({ manual: readManualBalances() });
}
