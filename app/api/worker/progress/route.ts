import { NextRequest, NextResponse } from "next/server";
import { getProject, updateProject } from "@/lib/store";
import { touchWorker } from "@/lib/workerState";

/** Воркер сообщает прогресс монтажа — стример видит его в интерфейсе. */
export async function POST(req: NextRequest) {
  touchWorker();
  const { id, step, progress } = await req.json();
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });
  if (project.processing.state === "running") {
    updateProject(id, {
      processing: {
        state: "running",
        step: `${String(step ?? "Монтаж")} (воркер)`,
        progress: Math.max(0, Math.min(99, Number(progress) || 0)),
      },
    });
  }
  return NextResponse.json({ ok: true });
}
