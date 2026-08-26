import { NextRequest, NextResponse } from "next/server";
import { getProject, updateProject } from "@/lib/store";
import { processProject } from "@/lib/pipeline";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });
  if (!project.rawVideo) return NextResponse.json({ error: "Сначала загрузите видео" }, { status: 400 });
  if (project.processing.state === "running") return NextResponse.json(project);

  updateProject(id, { processing: { state: "running", step: "Запуск", progress: 1 } });
  // запускаем монтаж в фоне; клиент опрашивает статус
  processProject(id);
  return NextResponse.json(getProject(id));
}
