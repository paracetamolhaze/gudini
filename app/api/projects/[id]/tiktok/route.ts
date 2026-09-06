import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { tiktokCreatorInfo, tiktokDirectPostEnabled } from "@/lib/publish";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Данные для экрана публикации в TikTok: режим (черновик или прямая публикация),
 * автор и разрешённые ему настройки из creator_info, подпись по умолчанию и кадр обложки.
 * TikTok требует показывать это перед публикацией — иначе аудит Direct Post не пройти.
 */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  const direct = tiktokDirectPostEnabled();
  const caption = [project.meta?.title ?? project.topic, project.meta?.description ?? "", (project.meta?.hashtags ?? []).join(" ")]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 2200);
  const coverSec = project.coverOffsetSec ?? 1;
  if (!direct) return NextResponse.json({ direct, connected: false, creator: null, caption, coverSec });

  try {
    const creator = await tiktokCreatorInfo();
    return NextResponse.json({ direct, connected: Boolean(creator), creator, caption, coverSec });
  } catch (e: any) {
    return NextResponse.json({ direct, connected: false, creator: null, caption, coverSec, error: String(e?.message ?? e) });
  }
}
