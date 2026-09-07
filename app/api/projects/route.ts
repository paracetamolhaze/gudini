import { NextRequest, NextResponse } from "next/server";
import { recordSiteSpend } from "@/lib/spendLog";
import { createProject, listProjects, updateProject } from "@/lib/store";
import { generateScript } from "@/lib/ai";
import { buildStoryResearchPack } from "@/lib/storyResearch";

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
    // Исследование по свежим источникам идёт до сценария: модель не знает сегодняшней
    // даты и писала о вышедшем фильме как о будущем. Без источников — сценарий по
    // памяти, но с явной пометкой в ответе (scriptNote), а не молча.
    if (process.env.STORY_RESEARCH_SCRIPT !== "off") {
      const research = await recordSiteSpend({ projectId: project.id, topic: project.topic, label: "Исследование" }, () =>
        buildStoryResearchPack(project.topic),
      );
      if (research) {
        // прежний сценарист + дата и справка на сегодня из исследования (без пересказа выдачи)
        const { script, demo } = await recordSiteSpend({ projectId: project.id, topic: project.topic, label: "Сценарий" }, () =>
          generateScript(project.topic, research),
        );
        return NextResponse.json(updateProject(project.id, { script, scriptDemo: demo, research }));
      }
      console.warn(`Проект ${project.id}: исследование не удалось — сценарий по памяти модели`);
      const { script, demo } = await recordSiteSpend({ projectId: project.id, topic: project.topic, label: "Сценарий" }, () =>
        generateScript(project.topic),
      );
      return NextResponse.json({
        ...updateProject(project.id, { script, scriptDemo: demo }),
        scriptNote: "Исследование не удалось (нет источников или ключа поиска): сценарий написан по памяти модели, проверьте актуальность",
      });
    }
    const { script, demo } = await recordSiteSpend({ projectId: project.id, topic: project.topic, label: "Сценарий" }, () =>
      generateScript(project.topic),
    );
    return NextResponse.json(updateProject(project.id, { script, scriptDemo: demo }));
  } catch (e: any) {
    // проект создан, сценарий можно перегенерировать позже
    return NextResponse.json({ ...project, scriptError: String(e?.message ?? e) });
  }
}
