import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Same protection as the Gudini site (middleware.ts) and Clipy: with SITE_PASSWORD set, the request
 * must carry the site cookie gudini_auth = sha256("gudini:<password>") or Basic auth; without a
 * password everything is open. Browser requests are redirected to the site's /login page.
 */
export function authCookieValue(password: string): string {
  return createHash("sha256").update(`gudini:${password}`).digest("hex");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function isAuthorized(req: FastifyRequest, password: string): boolean {
  if (!password) return true;
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.gudini_auth === authCookieValue(password)) return true;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (decoded.slice(idx + 1) === password || decoded.slice(0, idx) === password) return true;
    } catch {
      // malformed header → unauthorized
    }
  }
  return false;
}

export function makeAuthHook(opts: { password: string; prefix: string; publicPaths: string[] }) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!opts.password) return;
    const url = req.url.split("?")[0] ?? "";
    if (opts.publicPaths.some((p) => url === p || url.startsWith(`${p}/`))) return;
    if (isAuthorized(req, opts.password)) return;
    const wantsHtml = (req.headers.accept ?? "").includes("text/html") && !url.includes("/api/");
    if (wantsHtml) {
      const next = encodeURIComponent(url || `${opts.prefix}/`);
      await reply.redirect(`/login?next=${next}`, 302);
      return;
    }
    await reply.code(401).send({ error: "Требуется вход: откройте /login" });
  };
}
