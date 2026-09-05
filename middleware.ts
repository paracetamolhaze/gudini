import { NextRequest, NextResponse } from "next/server";

/**
 * Защита сайта паролем (SITE_PASSWORD). Вход — страница /login, сессия — httpOnly-cookie.
 * Без пароля открыты /terms и /privacy (их проверяют модераторы платформ)
 * и отдача видео (Instagram скачивает ролик по ссылке без авторизации).
 */

const PUBLIC_PATHS = new Set(["/terms", "/privacy", "/login", "/api/login"]);

async function authCookieValue(password: string): Promise<string> {
  const data = new TextEncoder().encode(`gudini:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Файл подтверждения домена TikTok: содержимое кладётся в переменную TIKTOK_VERIFY_CONTENT
  if (/^\/tiktok[\w.-]*\.txt$/i.test(pathname) && process.env.TIKTOK_VERIFY_CONTENT) {
    return new NextResponse(process.env.TIKTOK_VERIFY_CONTENT, {
      headers: { "Content-Type": "text/plain" },
    });
  }

  const password = process.env.SITE_PASSWORD;
  if (!password) return NextResponse.next();

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  // Готовый ролик и обложка открыты (их тянут Instagram/TikTok при публикации),
  // исходник (?which=raw) — только со входом: раньше он отдавался всем
  if (/^\/api\/projects\/[^/]+\/video$/.test(pathname) && req.nextUrl.searchParams.get("which") !== "raw") {
    return NextResponse.next();
  }

  const expected = await authCookieValue(password);
  if (req.cookies.get("gudini_auth")?.value === expected) return NextResponse.next();

  // Basic Auth оставлен как запасной вариант для скриптов
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const idx = decoded.indexOf(":");
      if (decoded.slice(idx + 1) === password || decoded.slice(0, idx) === password) {
        return NextResponse.next();
      }
    } catch {}
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Требуется вход: откройте /login" }, { status: 401 });
  }
  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/|favicon).*)"],
};
