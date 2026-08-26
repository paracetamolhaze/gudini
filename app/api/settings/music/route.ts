import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { hasMusic, MUSIC_FILE } from "@/lib/store";

/** Фоновая музыка для монтажа: загрузка, статус, удаление. */

export async function GET() {
  return NextResponse.json({ exists: hasMusic() });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Файл не передан" }, { status: 400 });
  if (file.size > 30 * 1024 * 1024) return NextResponse.json({ error: "Файл больше 30 МБ" }, { status: 400 });
  fs.writeFileSync(MUSIC_FILE, Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ exists: true });
}

export async function DELETE() {
  try {
    fs.rmSync(MUSIC_FILE, { force: true });
  } catch {}
  return NextResponse.json({ exists: false });
}
