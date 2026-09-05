import { NextRequest, NextResponse } from "next/server";
import { getProject, updateProject } from "@/lib/store";
import { generateMeta, generateScript, generateScriptFromResearch } from "@/lib/ai";
import { buildStoryResearchPack } from "@/lib/storyResearch";
import { recordSiteSpend } from "@/lib/spendLog";

type Ctx = { params: Promise<{ id: string }> };

/** Перегенерация сценария или метаданных: POST { what: "script" | "meta" } */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  const { what } = await req.json();
  try {
    if (what === "meta") {
      const { meta } = await recordSiteSpend({ projectId: id, topic: project.topic, label: "Описание" }, () =>
        generateMeta(project.topic, project.script ?? ""),
      );
      return NextResponse.json(updateProject(id, { meta }));
    }
    // Новый путь: сначала исследуем историю по источникам, затем пишем сценарий
    // из проверенных фактов. Пакет исследования остаётся в проекте и позже
    // становится основой медиатеки для монтажа.
    if (process.env.STORY_ASSET_PIPELINE === "true") {
      const research = await recordSiteSpend({ projectId: id, topic: project.topic, label: "Исследование" }, () =>
        buildStoryResearchPack(project.topic, project.sourceUrl),
      );
      if (!research) {
        return NextResponse.json(
          { error: "Не удалось исследовать историю: нет источников или ключа поиска" },
          { status: 502 },
        );
      }
      const written = await recordSiteSpend({ projectId: id, topic: project.topic, label: "Сценарий" }, () =>
        generateScriptFromResearch(research),
      );
      if (!written) {
        return NextResponse.json({ error: "Сценарий по исследованию не сгенерировался" }, { status: 502 });
      }
      return NextResponse.json(
        updateProject(id, {
          script: written.script,
          scriptDemo: false,
          research,
          scriptBeats: written.beats,
        }),
      );
    }

    const { script, demo } = await recordSiteSpend({ projectId: id, topic: project.topic, label: "Сценарий" }, () =>
      generateScript(project.topic),
    );
    return NextResponse.json(updateProject(id, { script, scriptDemo: demo }));
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
