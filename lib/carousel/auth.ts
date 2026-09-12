import crypto from "crypto";

/**
 * Доступ к разделу — тем же входом, что и весь сайт: SITE_PASSWORD, cookie gudini_auth
 * (или Basic Auth для скриптов), как в middleware.ts. Проверка повторяется в каждом
 * маршруте, чтобы раздел оставался закрытым, даже если правило middleware изменят.
 *
 * При пустом SITE_PASSWORD раздел открыт, как и весь сайт (решение владельца 2026-09-13):
 * генерация тратит деньги на Claude, а публикация уходит в подключённый Instagram, поэтому
 * включение пароля закрывает раздел сразу, без правок кода.
 */

export type CarouselAccess = { ok: true } | { ok: false; status: 401; code: "login_required"; error: string };

type RequestLike = {
  headers: { get(name: string): string | null };
  cookies: { get(name: string): { value: string } | undefined };
};

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function authCookieValue(password: string): string {
  return crypto.createHash("sha256").update(`gudini:${password}`).digest("hex");
}

export function checkCarouselAccess(req: RequestLike, password = process.env.SITE_PASSWORD ?? ""): CarouselAccess {
  if (!password) return { ok: true };

  const cookie = req.cookies.get("gudini_auth")?.value;
  if (cookie && sameText(cookie, authCookieValue(password))) return { ok: true };

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx >= 0 && (sameText(decoded.slice(idx + 1), password) || sameText(decoded.slice(0, idx), password))) return { ok: true };
    } catch {}
  }
  return { ok: false, status: 401, code: "login_required", error: "Требуется вход: откройте /login" };
}
