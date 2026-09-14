import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { logger, scrubSecrets } from "../shared/logger.js";
import { makeAuthHook } from "./auth.js";
import { registerHealthRoutes } from "./health.js";
import { registerApiRoutes } from "./routes/index.js";
import { projectDir } from "../shared/paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Built dashboard (vite) — served under the URL prefix with an SPA fallback. */
export const WEB_DIST = projectDir(here, "web/dist");

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const e = env();
  const prefix = e.THREADS_URL_PREFIX;
  const app = Fastify({
    loggerInstance: logger().child({ module: "http" }) as unknown as FastifyBaseLogger,
    disableRequestLogging: e.NODE_ENV === "production",
    genReqId: (req) => (typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : randomUUID()),
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("cache-control", "no-store");
  });

  app.addHook(
    "onRequest",
    makeAuthHook({
      password: e.SITE_PASSWORD,
      prefix,
      publicPaths: [`${prefix}/health`, `${prefix}/api/health`, `${prefix}/media/public`],
    }),
  );

  app.setErrorHandler((err, req, reply) => {
    const status = err instanceof HttpError ? err.status : typeof (err as { statusCode?: number }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 500;
    const message = scrubSecrets(err instanceof Error ? err.message : String(err));
    if (status >= 500) req.log.error({ err, requestId: req.id }, "request failed");
    else req.log.warn({ requestId: req.id, status, message }, "request rejected");
    void reply.code(status).send({ error: message, requestId: req.id });
  });

  app.setNotFoundHandler(async (req, reply) => {
    const url = req.url.split("?")[0] ?? "";
    // SPA fallback for dashboard routes; API paths stay 404.
    if (req.method === "GET" && url.startsWith(`${prefix}/`) && !url.startsWith(`${prefix}/api/`) && existsSync(path.join(WEB_DIST, "index.html"))) {
      return reply.type("text/html").sendFile("index.html", WEB_DIST);
    }
    return reply.code(404).send({ error: `Not found: ${req.method} ${url}` });
  });

  registerHealthRoutes(app, prefix);
  await registerApiRoutes(app, `${prefix}/api`);

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: `${prefix}/`,
      decorateReply: true,
      index: ["index.html"],
      cacheControl: false,
    });
  } else {
    app.get(`${prefix}/`, async () => ({ service: "gudini-threads", note: "dashboard is not built (web/dist missing); API is available under /api" }));
    await app.register(fastifyStatic, { root: here, serve: false, decorateReply: true });
  }

  // The bare prefix must serve the dashboard directly: the Gudini site (Next.js) redirects
  // `/threads/` → `/threads` before proxying, so a redirect back would loop.
  if (prefix) {
    app.get(prefix, async (_req, reply) => {
      if (existsSync(path.join(WEB_DIST, "index.html"))) return reply.type("text/html").sendFile("index.html", WEB_DIST);
      return { service: "gudini-threads", note: "dashboard is not built (web/dist missing); API is available under /api" };
    });
  }

  return app;
}
