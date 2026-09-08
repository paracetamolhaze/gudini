import { NextRequest, NextResponse } from "next/server";
import { getProject, updateProject } from "@/lib/store";
import { processProject } from "@/lib/pipeline";
import { workerActive, WORKER_QUEUED_STEP } from "@/lib/workerState";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  let project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });
  if (!project.rawVideo) return NextResponse.json({ error: "Сначала загрузите видео" }, { status: 400 });

  if (project.processing.state === "running") {
    // Проверяем до изменения фазы: повторный запрос не должен менять активное задание.
    const age = Date.now() - new Date(project.processing.at ?? 0).getTime();
    if (age < 15 * 60 * 1000) return NextResponse.json(project);
  }

  // AI-фильм идёт в две фазы: план (без Veo) → подтверждение пользователем → генерация.
  // Платная генерация без плана не запускается — это правило, а не настройка.
  const body = await req.json().catch(() => ({}));
  if (project.montageStyle === "ai_film") {
    const request = body?.request === "generate" ? "generate" : "plan";
    if (request === "generate" && !project.aiFilm?.plan) {
      return NextResponse.json({ error: "Сначала соберите план фильма и подтвердите его" }, { status: 400 });
    }
    project = updateProject(id, { aiFilm: { ...(project.aiFilm ?? {}), request, error: undefined } })!;
  }

  if (workerActive()) {
    // ПК владельца в сети — монтаж уйдёт на него
    updateProject(id, { processing: { state: "running", step: WORKER_QUEUED_STEP, progress: 2 } });
    return NextResponse.json(getProject(id));
  }

  // В докер-сборке монтаж только на воркере: серверный запуск здесь означал бы
  // второй конвейер в контейнере сайта (без yt-dlp и с двойной оплатой запросов)
  if (process.env.WORKER_ONLY === "1") {
    return NextResponse.json(
      { error: "Воркер монтажа не в сети — на этом сервере монтаж отключён. Запустите контейнер gudini-worker и нажмите ещё раз" },
      { status: 503 },
    );
  }

  updateProject(id, { processing: { state: "running", step: "Запуск", progress: 1 } });
  // запускаем монтаж на сервере в фоне; клиент опрашивает статус
  processProject(id);
  return NextResponse.json(getProject(id));
}
