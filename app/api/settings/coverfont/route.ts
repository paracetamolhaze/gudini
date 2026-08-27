import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { coverFontFile } from "@/lib/store";
import { checkGlyphCoverage } from "@/lib/coverLayout";

/**
 * Пользовательский шрифт заголовков обложек (Cover Font).
 * При загрузке проверяются обязательные глифы: АБВГД абвгд 0123456789 $ %.
 */

const DATA_DIR = path.join(process.cwd(), "data");

export async function GET() {
  const file = coverFontFile();
  if (!file) return NextResponse.json({ exists: false }, { status: 404 });
  return new NextResponse(fs.createReadStream(file) as any, {
    headers: { "Content-Type": "font/ttf", "Cache-Control": "no-store", "x-font-name": path.basename(file) },
  });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Файл не передан" }, { status: 400 });
  if (file.size > 5 * 1024 * 1024) return NextResponse.json({ error: "Шрифт больше 5 МБ" }, { status: 400 });

  const ext = path.extname(file.name || "").toLowerCase();
  if (![".ttf", ".otf"].includes(ext)) {
    return NextResponse.json({ error: "Поддерживаются .ttf и .otf (woff2 сконвертируйте в ttf)" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const coverage = checkGlyphCoverage(buffer);
  if (!coverage.ok) {
    return NextResponse.json(
      { error: `В шрифте нет обязательных символов: ${coverage.missing} — нужен шрифт с кириллицей` },
      { status: 400 },
    );
  }

  // одна каноническая пара имён; старый вариант удаляем
  for (const name of ["coverfont.ttf", "coverfont.otf"]) fs.rmSync(path.join(DATA_DIR, name), { force: true });
  fs.writeFileSync(path.join(DATA_DIR, `coverfont${ext}`), buffer);
  return NextResponse.json({ exists: true });
}

export async function DELETE() {
  for (const name of ["coverfont.ttf", "coverfont.otf"]) {
    try {
      fs.rmSync(path.join(DATA_DIR, name), { force: true });
    } catch {}
  }
  return NextResponse.json({ exists: false });
}
