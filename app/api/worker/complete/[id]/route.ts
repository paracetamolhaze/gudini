import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getProject, projectDir, updateProject } from "@/lib/store";
import { touchWorker } from "@/lib/workerState";

type Ctx = { params: Promise<{ id: string }> };

/** Воркер завершает задачу: метаданные и статус (файлы уже залиты через /result). */
export async function POST(req: NextRequest, { params }: Ctx) {
  touchWorker();
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  const body = await req.json();
  if (body.error) {
    return NextResponse.json(
      updateProject(id, {
        processing: { state: "error", step: "Ошибка", progress: 0, error: String(body.error) },
      }),
    );
  }

  const hasOut = fs.existsSync(path.join(projectDir(id), "out.mp4"));
  if (!hasOut) return NextResponse.json({ error: "out.mp4 не загружен" }, { status: 400 });
  const hasCover = fs.existsSync(path.join(projectDir(id), "cover.jpg"));

  return NextResponse.json(
    updateProject(id, {
      processedVideo: "out.mp4",
      cover: hasCover ? "cover.jpg" : null,
      coverOffsetSec: Number(body.coverOffsetSec) || 1,
      subtitlesSource: body.subtitlesSource,
      brollCount: Number(body.brollCount) || 0,
      meta: body.meta ?? project.meta,
      processing: { state: "done", step: "Готово", progress: 100 },
    }),
  );
}
