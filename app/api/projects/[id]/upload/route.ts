import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { getProject, projectDir, updateProject } from "@/lib/store";

type Ctx = { params: Promise<{ id: string }> };

const ALLOWED = [".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"];

function safeExt(name: string): string {
  const ext = (path.extname(name || "").toLowerCase() || ".mp4").replace(/[^.a-z0-9]/g, "");
  return ALLOWED.includes(ext) ? ext : ".mp4";
}

function finalize(id: string, filename: string) {
  return updateProject(id, {
    rawVideo: filename,
    processedVideo: null,
    processing: { state: "idle", step: "", progress: 0 },
    publications: [],
  });
}

/** Потоковая загрузка: тело запроса пишется на диск без буферизации в памяти. */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  try {
    if (!req.body) return NextResponse.json({ error: "Пустое тело запроса" }, { status: 400 });
    const filename = `raw${safeExt(req.headers.get("x-filename") ?? "")}`;
    const filePath = path.join(projectDir(id), filename);

    const nodeStream = Readable.fromWeb(req.body as any);
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(filePath);
      nodeStream.pipe(out);
      out.on("finish", () => resolve());
      out.on("error", reject);
      nodeStream.on("error", reject);
    });

    const size = fs.statSync(filePath).size;
    if (size < 10_000) {
      return NextResponse.json({ error: `Файл записался пустым (${size} байт) — запись с камеры не удалась` }, { status: 400 });
    }
    // контроль целостности: если соединение оборвалось, примем меньше байт, чем заявлено
    const expected = Number(req.headers.get("x-file-size") ?? req.headers.get("content-length") ?? 0);
    if (expected > 0 && size < expected) {
      return NextResponse.json(
        { error: `Загрузка оборвалась: получено ${Math.round(size / 1e6)} из ${Math.round(expected / 1e6)} МБ — попробуйте ещё раз` },
        { status: 400 },
      );
    }
    return NextResponse.json({ ...finalize(id, filename), uploadedSize: size });
  } catch (e: any) {
    return NextResponse.json({ error: `Сбой записи файла: ${String(e?.message ?? e)}` }, { status: 500 });
  }
}

/** Загрузка через форму (multipart) — запасной путь. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Файл не передан" }, { status: 400 });

    const filename = `raw${safeExt(file.name)}`;
    const dir = projectDir(id);
    fs.writeFileSync(path.join(dir, filename), Buffer.from(await file.arrayBuffer()));
    return NextResponse.json(finalize(id, filename));
  } catch (e: any) {
    return NextResponse.json({ error: `Сбой загрузки: ${String(e?.message ?? e)}` }, { status: 500 });
  }
}
