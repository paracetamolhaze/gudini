import { NextRequest } from "next/server";
import { fail, guard, ok, readBody } from "@/lib/carousel/http";
import { attachJob, CarouselError, deleteCarousel, getCarousel, isJobPending, notFound, updateCarousel } from "@/lib/carousel/store";
import { applyManualEdit } from "@/lib/carousel/edit";
import { toClient } from "@/lib/carousel/view";
import { ensureRunner } from "@/lib/carousel/runnerControl";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const c = getCarousel(id);
    if (!c) throw notFound();
    if (isJobPending(c.job)) ensureRunner();
    return ok(toClient(c));
  } catch (e) {
    return fail(e);
  }
}

/** Ручные правки: тексты слайдов, порядок, подпись, хэштеги, стиль, подпись внизу карточек. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await readBody(req);
    let render = false;
    const c = updateCarousel(id, (x) => {
      if (isJobPending(x.job)) throw new CarouselError("Идёт задание — правки можно сохранить после его окончания", 409, "busy");
      const { contentChanged, renderNeeded } = applyManualEdit(x, body);
      if (contentChanged) x.revision += 1;
      if (renderNeeded) {
        attachJob(x, "render");
        render = true;
      }
    });
    if (render) ensureRunner();
    return ok(toClient(c));
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    deleteCarousel(id);
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
