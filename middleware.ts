import { NextRequest, NextResponse } from "next/server";

/**
 * Защита сайта паролем при выходе в интернет (SITE_PASSWORD в .env).
 * Без пароля открыты только /terms и /privacy (их проверяют модераторы платформ)
 * и отдача видео (Instagram скачивает ролик по ссылке без авторизации).
 */
export function middleware(req: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname === "/terms" || pathname === "/privacy") return NextResponse.next();
  if (/^\/api\/projects\/[^/]+\/video$/.test(pathname)) return NextResponse.next();

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const idx = decoded.indexOf(":");
      const user = decoded.slice(0, idx);
      const pwd = decoded.slice(idx + 1);
      if (pwd === password || user === password) return NextResponse.next();
    } catch {}
  }
  return new NextResponse("Требуется вход", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Gudini"' },
  });
}

export const config = {
  matcher: ["/((?!_next/|favicon).*)"],
};
