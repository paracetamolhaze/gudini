import { NextRequest, NextResponse } from "next/server";
import { checkCarouselAccess } from "./auth";
import { CarouselError } from "./store";

export const NO_STORE = { "Cache-Control": "no-store" };

/** null — доступ есть; иначе готовый ответ с отказом. */
export function guard(req: NextRequest): NextResponse | null {
  const access = checkCarouselAccess(req);
  if (access.ok) return null;
  return NextResponse.json({ error: access.error, code: access.code }, { status: access.status, headers: NO_STORE });
}

export function ok(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

export function fail(e: unknown): NextResponse {
  if (e instanceof CarouselError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status, headers: NO_STORE });
  const message = String((e as any)?.message ?? e).slice(0, 400);
  console.error("Карусели:", message);
  return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE });
}

export async function readBody(req: NextRequest): Promise<Record<string, any>> {
  const text = await req.text().catch(() => "");
  if (text.length > 200_000) throw new CarouselError("Слишком большой запрос", 413, "too_large");
  if (!text) return {};
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    throw new CarouselError("Тело запроса — не JSON", 400, "bad_json");
  }
}
