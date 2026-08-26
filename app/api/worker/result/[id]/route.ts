import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { getProject, projectDir } from "@/lib/store";
import { touchWorker } from "@/lib/workerState";

type Ctx = { params: Promise<{ id: string }> };

/** Воркер заливает результат монтажа: ?file=out | cover (потоковая запись). */
export async function PUT(req: NextRequest, { params }: Ctx) {
  touchWorker();
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });
  const which = req.nextUrl.searchParams.get("file");
  const filename = which === "cover" ? "cover.jpg" : "out.mp4";
  if (!req.body) return NextResponse.json({ error: "Пустое тело" }, { status: 400 });

  try {
    const filePath = path.join(projectDir(id), filename);
    const nodeStream = Readable.fromWeb(req.body as any);
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(filePath);
      nodeStream.pipe(out);
      out.on("finish", () => resolve());
      out.on("error", reject);
      nodeStream.on("error", reject);
    });
    return NextResponse.json({ ok: true, size: fs.statSync(filePath).size });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
