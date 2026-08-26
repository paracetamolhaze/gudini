import { NextRequest, NextResponse } from "next/server";
import { deleteProject, getProject, updateProject } from "@/lib/store";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });
  return NextResponse.json(project);
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json();
  const patch: any = {};
  if (typeof body.script === "string") patch.script = body.script;
  if (body.meta && typeof body.meta === "object") {
    patch.meta = {
      title: String(body.meta.title ?? ""),
      description: String(body.meta.description ?? ""),
      hashtags: Array.isArray(body.meta.hashtags) ? body.meta.hashtags.map(String) : [],
    };
  }
  const project = updateProject(id, patch);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });
  return NextResponse.json(project);
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  deleteProject(id);
  return NextResponse.json({ ok: true });
}
