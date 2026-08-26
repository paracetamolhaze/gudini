import { NextRequest, NextResponse } from "next/server";
import { getProject, Platform } from "@/lib/store";
import { publish } from "@/lib/publish";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  const { platform } = await req.json();
  if (!["tiktok", "youtube", "instagram"].includes(platform)) {
    return NextResponse.json({ error: "Неизвестная платформа" }, { status: 400 });
  }
  try {
    const publication = await publish(id, platform as Platform);
    return NextResponse.json({ publication, project: getProject(id) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
