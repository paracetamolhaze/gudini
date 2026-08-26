import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getProject, projectDir, updateProject } from "@/lib/store";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Файл не передан" }, { status: 400 });

  const ext = (path.extname(file.name || "").toLowerCase() || ".mp4").replace(/[^.a-z0-9]/g, "");
  const allowed = [".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"];
  const finalExt = allowed.includes(ext) ? ext : ".mp4";
  const filename = `raw${finalExt}`;

  const dir = projectDir(id);
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(path.join(dir, filename), buffer);

  // сбрасываем результат прошлого монтажа
  const updated = updateProject(id, {
    rawVideo: filename,
    processedVideo: null,
    processing: { state: "idle", step: "", progress: 0 },
    publications: [],
  });
  return NextResponse.json(updated);
}
