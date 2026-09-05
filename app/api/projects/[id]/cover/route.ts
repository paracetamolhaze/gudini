import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getProject, updateProject, projectDir } from "@/lib/store";
import { makeCover } from "@/lib/pipeline";
import { recordSiteSpend } from "@/lib/spendLog";

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
  // Неудачная перегенерация раньше стирала прежнюю обложку из проекта. Прежний файл
  // откладывается и возвращается на место, если новая не прошла проверку.
  const coverFile = path.join(dir, "cover.jpg");
  const backup = path.join(dir, "cover-prev.jpg");
  const hadCover = !!project.cover && fs.existsSync(coverFile);
  if (hadCover) fs.copyFileSync(coverFile, backup);

  const { cover, coverStatus } = await recordSiteSpend({ projectId: id, topic: project.topic, label: "Обложка (ручная)" }, () =>
    makeCover(
      dir,
      project.topic,
      project.script,
      project.meta?.title,
      headline,
      true, // действие пользователя: одна оплаченная генерация
    ),
  );
  if (!cover && hadCover) {
    fs.copyFileSync(backup, coverFile);
    fs.rmSync(backup, { force: true });
    updateProject(id, { cover: project.cover, coverStatus: project.coverStatus ?? "ok" });
    return NextResponse.json(
      { error: `Новая обложка не прошла проверку (${coverStatus}) — оставлена прежняя` },
      { status: 409 },
    );
  }
  fs.rmSync(backup, { force: true });
  const updated = updateProject(id, { cover, coverStatus });
  return NextResponse.json(updated ?? project);
}
