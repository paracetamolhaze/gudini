import { NextRequest } from "next/server";
import { fail, guard, ok } from "@/lib/carousel/http";
import { clearBrandAsset, saveBrandAsset } from "@/lib/carousel/design";
import { CarouselError } from "@/lib/carousel/store";
import { DESIGN_LIMITS } from "@/lib/carousel/designShared";

export const dynamic = "force-dynamic";

const kindOf = (v: string | null): "logo" | "reference" => {
  if (v === "logo" || v === "reference") return v;
  throw new CarouselError("kind: logo | reference", 400, "bad_kind");
};

/** Логотип или визуальный референс аккаунта: multipart/form-data, поле file, ?kind=logo|reference. */
export async function POST(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const kind = kindOf(req.nextUrl.searchParams.get("kind"));
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > DESIGN_LIMITS.referenceMaxBytes + 64 * 1024) throw new CarouselError("Файл слишком большой", 413, "too_large");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new CarouselError("Нет файла", 400, "no_file");
    const buffer = Buffer.from(await file.arrayBuffer());
    return ok({ design: saveBrandAsset(kind, buffer) });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    return ok({ design: clearBrandAsset(kindOf(req.nextUrl.searchParams.get("kind"))) });
  } catch (e) {
    return fail(e);
  }
}
