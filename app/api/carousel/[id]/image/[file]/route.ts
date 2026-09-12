import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { fail, guard } from "@/lib/carousel/http";
import { getCarousel, isSlideFile, notFound, slideFilePath } from "@/lib/carousel/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; file: string }> };

/** Картинка слайда для предпросмотра и скачивания — только со входом на сайт. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id, file } = await params;
    const c = getCarousel(id);
    if (!c || !isSlideFile(file)) throw notFound();
    const index = c.slides.findIndex((s) => s.render?.file === file);
    if (index < 0 && !c.publish.items.some((i) => i.file === file)) throw notFound();
    const full = slideFilePath(id, file);
    if (!fs.existsSync(full)) throw notFound();
    const data = fs.readFileSync(full);
    const name = `slide-${index >= 0 ? String(index + 1).padStart(2, "0") : "old"}.jpg`;
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(data.length),
        // имя файла содержит отпечаток содержимого — картинка по этому адресу не меняется
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        ...(req.nextUrl.searchParams.get("download") === "1" ? { "Content-Disposition": `attachment; filename="${name}"` } : {}),
      },
    });
  } catch (e) {
    return fail(e);
  }
}
