import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";
import { pingRedis } from "../queue/connection.js";
import { threadsClient } from "../threads/index.js";
import { llm } from "../llm/index.js";
import { env } from "../config/env.js";
import { defaultSettings, loadSettings } from "../config/settings.js";
import { errorMessage, scrubSecrets } from "../shared/logger.js";
import { PLATFORM_LABEL, platform, type PlatformId } from "../platforms/index.js";

/**
 * /health          liveness + summary of every dependency
 * /health/db       Postgres round trip
 * /health/redis    Redis PING
 * /health/threads  GET /me with the configured token (reports username, never the token)
 * /health/llm      provider connectivity per configured task model
 * Health never requires auth: it reports status, not content.
 */
export async function checkDb(): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
  const started = Date.now();
  try {
    await getPool().query("SELECT 1");
    return { ok: true, message: "postgres ok", latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, message: scrubSecrets(errorMessage(err)) };
  }
}

export async function checkThreads(): Promise<{ ok: boolean; message: string; username?: string; userId?: string }> {
  const client = threadsClient();
  if (!client.hasToken) return { ok: false, message: "THREADS_ACCESS_TOKEN is not set" };
  try {
    const me = await client.me();
    return { ok: true, message: `connected as @${me.username}`, username: me.username, userId: me.id };
  } catch (err) {
    return { ok: false, message: scrubSecrets(errorMessage(err)) };
  }
}

/** Identity check on any platform: reports the handle, never a key. */
export async function checkPlatform(id: PlatformId): Promise<{ ok: boolean; message: string; username?: string; userId?: string }> {
  if (id === "threads") return checkThreads();
  const adapter = platform(id);
  if (!adapter.configured()) {
    // Two different asks, so two different sentences: sign in once in the window, or set four keys.
    return env().X_TRANSPORT === "browser"
      ? { ok: false, message: "X не подключён: нажмите «Подключить X» и войдите в аккаунт в окне браузера" }
      : { ok: false, message: "ключи X не заданы (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET)" };
  }
  try {
    const me = await adapter.me();
    return { ok: true, message: `connected as @${me.username}`, username: me.username, userId: me.id };
  } catch (err) {
    return { ok: false, message: scrubSecrets(errorMessage(err)) };
  }
}

export async function checkLlm(): Promise<{ ok: boolean; message: string; tasks: Array<{ task: string; model: string; ok: boolean; message: string }> }> {
  const tasks = await llm().test();
  const ok = tasks.length > 0 && tasks.every((t) => t.ok);
  return { ok, message: ok ? "all task models reachable" : tasks.filter((t) => !t.ok).map((t) => `${t.task}: ${t.message}`).join("; "), tasks };
}

export function registerHealthRoutes(app: FastifyInstance, prefix: string): void {
  app.get(`${prefix}/health`, async () => {
    // Mode and dry run live in the settings table — the dashboard buttons write them there, so the
    // environment only holds the first-boot defaults. With Postgres down we fall back to those
    // defaults instead of failing the page whose whole job is to say Postgres is down, and we ask
    // alongside the db probe so that outage costs one connection timeout here, not two in a row.
    const [db, redis, settings] = await Promise.all([checkDb(), pingRedis(), loadSettings().catch(() => defaultSettings())]);
    return {
      status: db.ok && redis.ok ? "ok" : "degraded",
      service: "gudini-threads",
      version: "0.2.0",
      platforms: Object.keys(PLATFORM_LABEL),
      mode: settings.mode,
      dryRun: settings.dryRun,
      db,
      redis,
      threadsConfigured: threadsClient().hasToken,
      // Ask whichever X we actually publish through (browser by default), not the legacy paid client.
      xConfigured: platform("x").configured(),
      uptimeSec: Math.round(process.uptime()),
    };
  });
  app.get(`${prefix}/health/db`, async (_req, reply) => {
    const r = await checkDb();
    return reply.code(r.ok ? 200 : 503).send(r);
  });
  app.get(`${prefix}/health/redis`, async (_req, reply) => {
    const r = await pingRedis();
    return reply.code(r.ok ? 200 : 503).send(r);
  });
  app.get(`${prefix}/health/threads`, async (_req, reply) => {
    const r = await checkThreads();
    return reply.code(r.ok ? 200 : 503).send(r);
  });
  app.get(`${prefix}/health/x`, async (_req, reply) => {
    const r = await checkPlatform("x");
    return reply.code(r.ok ? 200 : 503).send(r);
  });
  app.get(`${prefix}/health/llm`, async (_req, reply) => {
    const r = await checkLlm();
    return reply.code(r.ok ? 200 : 503).send(r);
  });
}
