import { NextRequest } from "next/server";
import { fail, guard, ok, readBody } from "@/lib/carousel/http";
import { attachJob, CarouselError, updateCarousel } from "@/lib/carousel/store";
import { CAROUSEL_LIMITS } from "@/lib/carousel/limits";
import { cleanText } from "@/lib/carousel/text";
import { toClient } from "@/lib/carousel/view";
import { ensureRunner } from "@/lib/carousel/runnerControl";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const TYPES = ["generate", "render", "regenerate_slide", "instruct"] as const;

/**
 * Фоновые задания над каруселью: повтор генерации, рендер, перегенерация слайда,
 * правка по текстовому поручению. Публикация — отдельным маршрутом.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await readBody(req);
    const type = body.type as (typeof TYPES)[number];
    if (!TYPES.includes(type)) return ok({ error: "Неизвестное задание" }, 400);

    const c = updateCarousel(id, (x) => {
      if (x.publish.status === "queued" || x.publish.status === "running") throw new CarouselError("Идёт публикация — дождитесь её окончания", 409, "publishing");

      if (type === "generate") {
        // только повтор неудавшейся генерации: готовые тексты второй раз не заказываются
        const planned = x.slides.length > 0;
        if (planned && !(x.job?.type === "generate" && x.job.state === "error")) {
          throw new CarouselError("Карусель уже сгенерирована — правьте слайды или дайте поручение Claude", 409, "already_generated");
        }
        attachJob(x, "generate", planned ? { stage: "planned" } : {});
        return;
      }

      if (typeof body.revision !== "number" || body.revision !== x.revision) {
        throw new CarouselError("Карусель изменилась после загрузки страницы — обновите страницу", 409, "stale_revision");
      }
      if (!x.slides.length) throw new CarouselError("Сначала дождитесь генерации слайдов", 409, "no_slides");

      if (type === "render") attachJob(x, "render");
      else if (type === "regenerate_slide") {
        if (!x.slides.some((s) => s.id === body.slideId)) throw new CarouselError("Слайд не найден — обновите страницу", 404, "slide_missing");
        attachJob(x, "regenerate_slide", { slideId: body.slideId, hint: cleanText(body.hint, { max: CAROUSEL_LIMITS.hintMax }) });
      } else {
        const instruction = cleanText(body.instruction, { multiline: true });
        if (instruction.length < 3) throw new CarouselError("Напишите поручение, например «сократи третий слайд»", 400, "bad_instruction");
        if (instruction.length > CAROUSEL_LIMITS.instructionMax) throw new CarouselError(`Поручение длиннее ${CAROUSEL_LIMITS.instructionMax} символов`, 400, "bad_instruction");
        attachJob(x, "instruct", { instruction });
      }
    });
    ensureRunner();
    return ok(toClient(c), 202);
  } catch (e) {
    return fail(e);
  }
}
