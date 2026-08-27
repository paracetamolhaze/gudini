import { NextRequest, NextResponse } from "next/server";
import { getProject, updateProject, projectDir } from "@/lib/store";
import { makeCover } from "@/lib/pipeline";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Ручная перегенерация обложки — РОВНО ОДНА платная генерация на нажатие.
 * Никаких подменных обложек и авто-повторов: при провале QC возвращается coverStatus=failed.
 * Необязательный body {headline}: пользователь может сам сократить заголовок.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  let headline: string | undefined;
  try {
    const body = await req.json();
    if (body?.headline) headline = String(body.headline).slice(0, 60);
  } catch {}

  const dir = projectDir(id);
  const { cover, coverStatus } = await makeCover(
    dir,
    project.topic,
    project.script,
    project.meta?.title,
    headline,
    true, // действие пользователя: одна оплаченная генерация
  );
  const updated = updateProject(id, { cover, coverStatus });
  return NextResponse.json(updated ?? project);
}
