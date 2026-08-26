import { NextRequest, NextResponse } from "next/server";

async function authCookieValue(password: string): Promise<string> {
  const data = new TextEncoder().encode(`gudini:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(req: NextRequest) {
  const sitePassword = process.env.SITE_PASSWORD;
  if (!sitePassword) return NextResponse.json({ ok: true });

  const { password } = await req.json().catch(() => ({}) as { password?: string });
  if (password !== sitePassword) {
    return NextResponse.json({ error: "Неверный пароль" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("gudini_auth", await authCookieValue(sitePassword), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 дней
  });
  return res;
}
