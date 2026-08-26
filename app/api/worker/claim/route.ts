import { NextRequest, NextResponse } from "next/server";
import { getProject, updateProject } from "@/lib/store";
import { touchWorker, WORKER_QUEUED_STEP, WORKER_RUNNING_STEP } from "@/lib/workerState";

/** Воркер забирает задачу: возвращаем весь проект для локального монтажа. */
export async function POST(req: NextRequest) {
  touchWorker();
  const { id } = await req.json();
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });
  if (project.processing.step !== WORKER_QUEUED_STEP) {
    return NextResponse.json({ error: "Задача уже занята" }, { status: 409 });
  }
  updateProject(id, { processing: { state: "running", step: WORKER_RUNNING_STEP, progress: 3 } });
  return NextResponse.json({ project: getProject(id) });
}
