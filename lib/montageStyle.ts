import type { Project } from "./store";

/** Фаза результата определяется стилем и запросом, а не оставшимися от прошлого монтажа файлами. */
export function isAiFilmPlanResult(project: Pick<Project, "montageStyle" | "aiFilm">): boolean {
  return project.montageStyle === "ai_film" && Boolean(project.aiFilm?.plan)
    && (project.aiFilm?.request === "plan" || project.aiFilm?.status === "planned");
}
