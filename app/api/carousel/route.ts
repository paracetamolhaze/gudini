import { NextRequest } from "next/server";
import { fail, guard, ok, readBody } from "@/lib/carousel/http";
import { attachJob, createCarousel, deleteCarousel, isJobPending, listCarousels, updateCarousel } from "@/lib/carousel/store";
import { parseCreateRequest } from "@/lib/carousel/request";
import { toSummary } from "@/lib/carousel/view";
import { ensureRunner } from "@/lib/carousel/runnerControl";
import { configProblems, defaultImageModel, imageResolution } from "@/lib/carousel/config";
import { requestResolution } from "@/lib/carousel/models";
import { readDesign } from "@/lib/carousel/design";

export const dynamic = "force-dynamic";

/** Список каруселей. */
export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const list = listCarousels();
    if (list.some((c) => isJobPending(c.job))) ensureRunner();
    return ok({ carousels: list.map(toSummary) });
  } catch (e) {
    return fail(e);
  }
}

/** Новая карусель: сохраняется сразу с копией оформления аккаунта, генерация уходит в фоновое задание. */
export async function POST(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const parsed = parseCreateRequest(await readBody(req), { imageModel: defaultImageModel().id });
    if ("error" in parsed) return ok({ error: parsed.error }, 400);
    if (parsed.mode === "illustrated") {
      // без ключа раздела карусель с иллюстрациями не создаётся — а не создаётся и падает
      const problems = configProblems();
      if (problems.length) return ok({ error: problems.join(" "), code: "config" }, 400);
    }
    const created = createCarousel(parsed.request, {
      mode: parsed.mode,
      design: parsed.mode === "illustrated" ? readDesign() : undefined,
      imageModel: parsed.imageModel,
      imageResolution: parsed.imageModel ? requestResolution(parsed.imageModel, imageResolution()) : undefined,
    });
    try {
      updateCarousel(created.id, (c) => {
        attachJob(c, "generate");
      });
    } catch (e) {
      // очередь полна — пустую карточку без задания не оставляем
      try {
        deleteCarousel(created.id);
      } catch {}
      throw e;
    }
    ensureRunner();
    return ok({ id: created.id }, 201);
  } catch (e) {
    return fail(e);
  }
}
