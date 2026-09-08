import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getProject, projectDir, updateProject } from "@/lib/store";
import { touchWorker } from "@/lib/workerState";
import { isAiFilmPlanResult } from "@/lib/montageStyle";

type Ctx = { params: Promise<{ id: string }> };

/** Воркер завершает задачу: метаданные и статус (файлы уже залиты через /result). */
export async function POST(req: NextRequest, { params }: Ctx) {
  touchWorker();
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  const body = await req.json();
  // исследование истории строит воркер; сайт хранит его, чтобы повторный монтаж
  // и добор материала его не оплачивали заново
  const research = body.research && typeof body.research === "object" ? body.research : undefined;
  if (body.error) {
    return NextResponse.json(
      updateProject(id, {
        ...(research ? { research } : {}),
        processing: { state: "error", step: "Ошибка", progress: 0, error: String(body.error) },
      }),
    );
  }

  // план AI-фильма: видео ещё нет, пользователь смотрит план и цену и решает
  if (isAiFilmPlanResult({ montageStyle: project.montageStyle, aiFilm: body.aiFilm })) {
    return NextResponse.json(
      updateProject(id, {
        ...(research ? { research } : {}),
        processedVideo: null,
        aiFilm: {
          ...(project.aiFilm ?? {}), ...body.aiFilm, request: "plan", status: "planned",
          generatedAt: undefined, spent: undefined, error: undefined,
        },
        processing: { state: "idle", step: "План фильма готов", progress: 0 },
      }),
    );
  }

  const hasOut = fs.existsSync(path.join(projectDir(id), "out.mp4"));
  if (!hasOut) return NextResponse.json({ error: "out.mp4 не загружен" }, { status: 400 });
  const hasCover = fs.existsSync(path.join(projectDir(id), "cover.jpg"));

  // копия итога под стиль: карточки и AI-фильм живут рядом, монтаж одного не стирает другой
  const style: "cards" | "ai_film" = body.montageStyle === "ai_film" || body.montageStyle === "cards" ? body.montageStyle : project.montageStyle ?? "cards";
  const styledFile = `out-${style}.mp4`;
  try {
    fs.copyFileSync(path.join(projectDir(id), "out.mp4"), path.join(projectDir(id), styledFile));
  } catch (e: any) {
    return NextResponse.json({ error: `не удалось сохранить копию ${styledFile}: ${String(e?.message ?? e)}` }, { status: 500 });
  }
  const subtitlesSource = body.subtitlesSource === "scribe" || body.subtitlesSource === "whisper" || body.subtitlesSource === "script" ? body.subtitlesSource : undefined;

  return NextResponse.json(
    updateProject(id, {
      processedVideo: "out.mp4",
      outputs: { ...(project.outputs ?? {}), [style]: { file: styledFile, at: new Date().toISOString(), brollCount: Number(body.brollCount) || 0, subtitlesSource } },
      cover: hasCover ? "cover.jpg" : null,
      // статус и причина отказа проверки приходят от воркера: без них отклонённая
      // обложка выглядела на сайте как «обложки нет», без объяснения
      coverStatus: body.coverStatus === "ok" || body.coverStatus === "failed" || body.coverStatus === "headline_failed"
        ? body.coverStatus
        : hasCover ? "ok" : "failed",
      coverReason: body.coverReason ? String(body.coverReason).slice(0, 300) : undefined,
      coverOffsetSec: Number(body.coverOffsetSec) || 1,
      subtitlesSource: body.subtitlesSource,
      brollCount: Number(body.brollCount) || 0,
      meta: body.meta ?? project.meta,
      ...(research ? { research } : {}),
      ...(body.aiFilm && typeof body.aiFilm === "object" ? { aiFilm: { ...(project.aiFilm ?? {}), ...body.aiFilm } } : {}),
      processing: { state: "done", step: "Готово", progress: 100 },
    }),
  );
}
