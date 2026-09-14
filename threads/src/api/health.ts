import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";
import { pingRedis } from "../queue/connection.js";
import { threadsClient } from "../threads/index.js";
import { llm } from "../llm/index.js";
import { env } from "../config/env.js";
import { errorMessage, scrubSecrets } from "../shared/logger.js";

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

export async function checkLlm(): Promise<{ ok: boolean; message: string; tasks: Array<{ task: string; model: string; ok: boolean; message: string }> }> {
  const tasks = await llm().test();
  const ok = tasks.length > 0 && tasks.every((t) => t.ok);
  return { ok, message: ok ? "all task models reachable" : tasks.filter((t) => !t.ok).map((t) => `${t.task}: ${t.message}`).join("; "), tasks };
}

export function registerHealthRoutes(app: FastifyInstance, prefix: string): void {
  app.get(`${prefix}/health`, async () => {
    const [db, redis] = await Promise.all([checkDb(), pingRedis()]);
    return {
      status: db.ok && redis.ok ? "ok" : "degraded",
      service: "gudini-threads",
      version: "0.1.0",
      mode: env().AUTOPILOT_MODE,
      dryRun: env().DRY_RUN,
      db,
      redis,
      threadsConfigured: threadsClient().hasToken,
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
  app.get(`${prefix}/health/llm`, async (_req, reply) => {
    const r = await checkLlm();
    return reply.code(r.ok ? 200 : 503).send(r);
  });
}
