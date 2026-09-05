import { NextRequest, NextResponse } from "next/server";
import { recordSiteSpend } from "@/lib/spendLog";
import { createProject, listProjects, updateProject } from "@/lib/store";
import { generateScript } from "@/lib/ai";

export async function GET() {
  return NextResponse.json(listProjects());
}

export async function POST(req: NextRequest) {
  const { topic } = await req.json();
  if (!topic || typeof topic !== "string" || !topic.trim()) {
    return NextResponse.json({ error: "Укажите тему видео" }, { status: 400 });
  }
  const project = createProject(topic.trim());
  try {
    const { script, demo } = await recordSiteSpend({ projectId: project.id, topic: project.topic, label: "Сценарий" }, () =>
      generateScript(project.topic),
    );
    return NextResponse.json(updateProject(project.id, { script, scriptDemo: demo }));
  } catch (e: any) {
    // проект создан, сценарий можно перегенерировать позже
    return NextResponse.json({ ...project, scriptError: String(e?.message ?? e) });
  }
}
