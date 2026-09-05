import { NextRequest, NextResponse } from "next/server";
import { appendSpendRuns, sanitizeRun, SpendRun } from "@/lib/spendLog";
import { touchWorker } from "@/lib/workerState";

/**
 * Воркер присылает сводки прогонов (файлы cost-runs): сумма и разбивка по провайдерам.
 * Повторная отправка безопасна — прогоны различаются по runId.
 */
export async function POST(req: NextRequest) {
  touchWorker();
  const body = await req.json().catch(() => ({}));
  const raw = Array.isArray(body.runs) ? body.runs.slice(0, 500) : [];
  const runs = raw.map(sanitizeRun).filter((r: SpendRun | null): r is SpendRun => !!r);
  const result = appendSpendRuns(runs);
  return NextResponse.json({ ok: true, received: raw.length, accepted: runs.length, ...result });
}
