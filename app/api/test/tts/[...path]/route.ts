import { NextRequest, NextResponse } from "next/server";

/**
 * Прокси стенда озвучки в контейнер tts (см. docker-compose.yml, сервис tts).
 * Через сайт, а не напрямую: так стенд закрыт тем же паролем, что и всё остальное,
 * а порт 8600 не нужно открывать наружу.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const base = (
  process.env.TTS_URL || (process.env.NODE_ENV === "production" ? "http://tts:8600" : "http://127.0.0.1:8600")
).replace(/\/$/, "");

// генерация минуты речи на 3060 Ti идёт десятки секунд, а первая ещё и качает веса модели
const TIMEOUT_MS = 20 * 60 * 1000;

async function proxy(req: NextRequest, path: string[]) {
  const url = `${base}/${path.join("/")}${req.nextUrl.search}`;
  const headers = new Headers();
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "DELETE" ? undefined : await req.arrayBuffer(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  } catch (e: any) {
    // контейнер не поднят или ещё грузится — на стенде это обычное состояние, не ошибка сайта
    return NextResponse.json(
      { error: `Стенд озвучки не отвечает (${base}): ${String(e?.message ?? e)}` },
      { status: 502 },
    );
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path);
}
export async function POST(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path);
}
export async function DELETE(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path);
}
