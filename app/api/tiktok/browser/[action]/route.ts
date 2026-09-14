import { NextRequest, NextResponse } from "next/server";
import { tikTokBrowserRequest } from "@/lib/tiktok/client";
import { browserTikTokEnabled } from "@/lib/tiktok/state";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ action: string }> };
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { action } = await params;
  if (!["status", "frame"].includes(action)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return forward(action);
}
export async function POST(req: NextRequest, { params }: Ctx) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const { action } = await params;
  if (!["login", "finish", "close", "input", "disconnect", "settings", "cancel", "resolve"].includes(action)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (Number(req.headers.get("content-length") || 0) > 16_384) return NextResponse.json({ error: "Too large" }, { status: 413 });
  return forward(action, await req.json().catch(() => ({})));
}
async function forward(action: string, body?: unknown) {
  if (!browserTikTokEnabled()) return NextResponse.json({ error: "Фоновый TikTok не включён на этом сервере." }, { status: 409 });
  try { return NextResponse.json(await tikTokBrowserRequest(action, body), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Ошибка TikTok" }, { status: 503 }); }
}
