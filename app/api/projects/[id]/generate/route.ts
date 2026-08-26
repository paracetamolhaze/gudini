import { NextRequest, NextResponse } from "next/server";
import { getProject, updateProject } from "@/lib/store";
import { generateMeta, generateScript } from "@/lib/ai";

type Ctx = { params: Promise<{ id: string }> };

/** Перегенерация сценария или метаданных: POST { what: "script" | "meta" } */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  const { what } = await req.json();
  try {
    if (what === "meta") {
      const { meta } = await generateMeta(project.topic, project.script ?? "");
      return NextResponse.json(updateProject(id, { meta }));
    }
    const { script, demo } = await generateScript(project.topic);
    return NextResponse.json(updateProject(id, { script, scriptDemo: demo }));
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
