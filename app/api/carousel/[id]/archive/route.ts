import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { fail, guard } from "@/lib/carousel/http";
import { CarouselError, getCarousel, notFound, slideFilePath } from "@/lib/carousel/store";
import { composeCaption } from "@/lib/carousel/text";
import { isStale } from "@/lib/carousel/view";
import { buildZip } from "@/lib/carousel/zip";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Вся карусель одним архивом: слайды по порядку и подпись с хэштегами. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const c = getCarousel(id);
    if (!c) throw notFound();
    if (!c.slides.length) throw new CarouselError("Слайдов ещё нет", 409, "no_slides");
    const notReady = c.slides.map((s, i) => (isStale(c, i) || !s.render?.file ? i + 1 : 0)).filter(Boolean);
    if (notReady.length) throw new CarouselError(`Не отрендерены слайды: ${notReady.join(", ")}`, 409, "not_rendered");

    const files = c.slides.map((s, i) => {
      const full = slideFilePath(id, s.render!.file!);
      if (!fs.existsSync(full)) throw new CarouselError(`Файл слайда ${i + 1} не найден — запустите рендер заново`, 409, "file_missing");
      return { name: `${String(i + 1).padStart(2, "0")}.jpg`, data: fs.readFileSync(full) };
    });
    files.push({ name: "caption.txt", data: Buffer.from(`${composeCaption(c.caption, c.hashtags)}\n`, "utf8") });
    const zip = buildZip(files);

    const slug = c.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "carousel";
    return new NextResponse(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(zip.length),
        "Content-Disposition": `attachment; filename="carousel-${c.createdAt.slice(0, 10)}.zip"; filename*=UTF-8''${encodeURIComponent(`${slug}.zip`)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return fail(e);
  }
}
