import { NextRequest } from "next/server";
import { fail, guard, ok, readBody } from "@/lib/carousel/http";
import { readDesign, updateDesign } from "@/lib/carousel/design";

export const dynamic = "force-dynamic";

/** Оформление аккаунта для карточек с иллюстрациями: цвета, шрифт, подпись автора, стиль иллюстраций. */
export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  return ok({ design: readDesign() });
}

export async function PATCH(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    return ok({ design: updateDesign(await readBody(req)) });
  } catch (e) {
    return fail(e);
  }
}
