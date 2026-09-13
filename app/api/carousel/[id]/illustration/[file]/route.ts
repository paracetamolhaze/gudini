import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { fail, guard } from "@/lib/carousel/http";
import { getCarousel, imageFilePath, isImageFile, notFound } from "@/lib/carousel/store";
import { sniffImage } from "@/lib/carousel/imageFile";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; file: string }> };

/** Версия иллюстрации для предпросмотра — только со входом и только файлы версий этой карусели. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id, file } = await params;
    const c = getCarousel(id);
    if (!c || !isImageFile(file)) throw notFound();
    if (!c.slides.some((s) => s.image?.versions.some((v) => v.file === file))) throw notFound();
    const full = imageFilePath(id, file);
    if (!fs.existsSync(full)) throw notFound();
    const data = fs.readFileSync(full);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": sniffImage(data) ?? "application/octet-stream",
        "Content-Length": String(data.length),
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        ...(req.nextUrl.searchParams.get("download") === "1" ? { "Content-Disposition": `attachment; filename="${file}"` } : {}),
      },
    });
  } catch (e) {
    return fail(e);
  }
}
