import { NextRequest } from "next/server";

/**
 * Публичный адрес сайта с точки зрения пользователя.
 * За прокси (Railway) req.nextUrl.origin превращается в localhost:PORT,
 * поэтому берём адрес из заголовков x-forwarded-*.
 */
export function requestOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  if (host) return `${proto}://${host}`;
  return req.nextUrl.origin;
}
