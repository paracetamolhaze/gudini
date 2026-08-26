import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { hasFace, FACE_FILE } from "@/lib/store";

/** Reference-фото стримера для ИИ-обложек: загрузка, получение, удаление. */

export async function GET() {
  if (!hasFace()) return NextResponse.json({ exists: false }, { status: 404 });
  return new NextResponse(fs.createReadStream(FACE_FILE) as any, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Файл не передан" }, { status: 400 });
  if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: "Фото больше 10 МБ" }, { status: 400 });
  fs.writeFileSync(FACE_FILE, Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ exists: true });
}

export async function DELETE() {
  try {
    fs.rmSync(FACE_FILE, { force: true });
  } catch {}
  return NextResponse.json({ exists: false });
}
