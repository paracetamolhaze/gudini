import { NextRequest, NextResponse } from "next/server";
import { fail, guard } from "@/lib/carousel/http";
import { readBrandFile } from "@/lib/carousel/design";
import { sniffImage } from "@/lib/carousel/imageFile";
import { notFound } from "@/lib/carousel/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ file: string }> };

/** Логотип или референс аккаунта для предпросмотра — только со входом на сайт. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { file } = await params;
    const data = readBrandFile(file);
    if (!data) throw notFound();
    return new NextResponse(new Uint8Array(data), {
      headers: { "Content-Type": sniffImage(data) ?? "application/octet-stream", "Content-Length": String(data.length), "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
    });
  } catch (e) {
    return fail(e);
  }
}
