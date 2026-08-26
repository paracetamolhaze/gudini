import { NextRequest, NextResponse } from "next/server";
import { getProject, updateProject } from "@/lib/store";
import { processProject } from "@/lib/pipeline";
import { workerActive, WORKER_QUEUED_STEP } from "@/lib/workerState";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });
  if (!project.rawVideo) return NextResponse.json({ error: "Сначала загрузите видео" }, { status: 400 });

  if (project.processing.state === "running") {
    // зависшую задачу (без обновлений > 15 минут) можно перезапустить
    const age = Date.now() - new Date(project.processing.at ?? 0).getTime();
    if (age < 15 * 60 * 1000) return NextResponse.json(project);
  }

  if (workerActive()) {
    // ПК владельца в сети — монтаж уйдёт на него
    updateProject(id, { processing: { state: "running", step: WORKER_QUEUED_STEP, progress: 2 } });
    return NextResponse.json(getProject(id));
  }

  updateProject(id, { processing: { state: "running", step: "Запуск", progress: 1 } });
  // запускаем монтаж на сервере в фоне; клиент опрашивает статус
  processProject(id);
  return NextResponse.json(getProject(id));
}
