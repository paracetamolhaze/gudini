import crypto from "crypto";

/**
 * Доступ к разделу — тем же входом, что и весь сайт: SITE_PASSWORD, cookie gudini_auth
 * (или Basic Auth для скриптов), как в middleware.ts. Проверка повторяется в каждом
 * маршруте, чтобы раздел оставался закрытым, даже если правило middleware изменят.
 *
 * Отличие одно: при пустом SITE_PASSWORD сайт открыт всем, но генератор с платными
 * вызовами Claude и публикация в Instagram открытыми быть не должны — раздел отказывает.
 */

export type CarouselAccess =
  | { ok: true }
  | { ok: false; status: 401 | 403; code: "login_disabled" | "login_required"; error: string };

type RequestLike = {
  headers: { get(name: string): string | null };
  cookies: { get(name: string): { value: string } | undefined };
};

export const LOGIN_DISABLED_MESSAGE =
  "Раздел «Карусели» закрыт: на сайте выключен вход по паролю (SITE_PASSWORD пуст), а генерация через Claude и публикация в Instagram не должны быть доступны всем. Включите вход на сайт — раздел заработает.";

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function authCookieValue(password: string): string {
  return crypto.createHash("sha256").update(`gudini:${password}`).digest("hex");
}

export function checkCarouselAccess(req: RequestLike, password = process.env.SITE_PASSWORD ?? ""): CarouselAccess {
  if (!password) return { ok: false, status: 403, code: "login_disabled", error: LOGIN_DISABLED_MESSAGE };

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
