import { NextResponse } from "next/server";
import { listProjects } from "@/lib/store";
import { touchWorker, WORKER_QUEUED_STEP } from "@/lib/workerState";

/** Опрос воркером: отмечает воркер «в сети» и возвращает задачи в очереди. */
export async function GET() {
  touchWorker();
  const jobs = listProjects()
    .filter((p) => p.processing.state === "running" && p.processing.step === WORKER_QUEUED_STEP)
    .map((p) => p.id);
  return NextResponse.json({ jobs });
}
