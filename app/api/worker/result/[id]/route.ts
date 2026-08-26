import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { getProject, projectDir } from "@/lib/store";
import { touchWorker } from "@/lib/workerState";

type Ctx = { params: Promise<{ id: string }> };

/** Воркер заливает результат монтажа: ?file=out | cover (кусками при x-offset или потоком). */
export async function PUT(req: NextRequest, { params }: Ctx) {
  touchWorker();
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });
  const which = req.nextUrl.searchParams.get("file");
  const filename = which === "cover" ? "cover.jpg" : "out.mp4";
  if (!req.body) return NextResponse.json({ error: "Пустое тело" }, { status: 400 });

  try {
    const dir = projectDir(id);
    const filePath = path.join(dir, filename);

    // куски: прокси хостинга обрывает большие тела запросов
    if (req.headers.get("x-offset") !== null) {
      const offset = Number(req.headers.get("x-offset"));
      const total = Number(req.headers.get("x-file-size") ?? 0);
      const buf = Buffer.from(await req.arrayBuffer());
      const part = `${filePath}.part`;
      const current = fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (offset === 0) fs.writeFileSync(part, buf);
      else if (current === offset) fs.appendFileSync(part, buf);
      else if (current !== offset + buf.length) {
        return NextResponse.json({ error: "рассинхрон", received: current }, { status: 409 });
      }
      const received = fs.statSync(part).size;
      if (total > 0 && received >= total) {
        if (received !== total) {
          fs.rmSync(part, { force: true });
          return NextResponse.json({ error: `размер не сошёлся: ${received}/${total}` }, { status: 400 });
        }
        fs.renameSync(part, filePath);
        return NextResponse.json({ done: true, size: received });
      }
      return NextResponse.json({ ok: true, received });
    }
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
