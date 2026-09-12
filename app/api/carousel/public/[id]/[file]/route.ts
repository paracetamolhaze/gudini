import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getCarousel, slideFilePath, verifyMedia } from "@/lib/carousel/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; file: string }> };

/**
 * Слайд для Instagram: Meta скачивает картинку по ссылке без входа на сайт. Открыт только
 * JPEG слайда, который стоит в незавершённой или прошедшей публикации этой карусели, и
 * только по ссылке с действующей подписью (HMAC, срок 6 часов). Всё прочее — 404 без
 * подробностей: ни хранилища, ни других каруселей и проектов отсюда не видно.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const missing = () => new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    const { id, file } = await params;
    const sp = req.nextUrl.searchParams;
    if (!verifyMedia(id, file, sp.get("exp"), sp.get("sig"))) return missing();
    const c = getCarousel(id);
    if (!c || !c.publish.items.some((i) => i.file === file)) return missing();
    const full = slideFilePath(id, file);
    if (!fs.existsSync(full)) return missing();
    const data = fs.readFileSync(full);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(data.length),
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch {
    return missing();
  }
}
