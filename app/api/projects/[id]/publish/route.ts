import { NextRequest, NextResponse } from "next/server";
import { getProject, Platform } from "@/lib/store";
import { publish } from "@/lib/publish";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  const { platform, tiktok, mode, style } = await req.json();
  if (!["tiktok", "youtube", "instagram"].includes(platform)) {
    return NextResponse.json({ error: "Неизвестная платформа" }, { status: 400 });
  }
  try {
    const publication = await publish(id, platform as Platform, {
      ...(tiktok && typeof tiktok === "object" ? { tiktok } : {}),
      mode: mode === "draft" ? "draft" : "live",
      ...(style === "cards" || style === "ai_film" ? { style } : {}),
    });
    return NextResponse.json({ publication, project: getProject(id) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
