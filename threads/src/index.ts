import { env } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { closePool } from "./db/pool.js";
import { buildServer } from "./api/server.js";
import { logger } from "./shared/logger.js";
import { closeQueues } from "./queue/queues.js";
import { closeRedis } from "./queue/connection.js";
import { installRepeatableJobs } from "./queue/scheduler.js";
import { wireLlm } from "./services/llmWiring.js";
import { syncAccounts } from "./services/account.js";

/**
 * App process: migrations → HTTP API + dashboard → repeatable job schedule.
 * Workers run in a separate process (src/worker.ts) so a slow LLM call never blocks the API.
 */
async function main(): Promise<void> {
  const e = env();
  const log = logger();
  await runMigrations();
  wireLlm();
  const app = await buildServer();
  await app.listen({ port: e.PORT, host: e.HOST });
  log.info({ port: e.PORT, prefix: e.THREADS_URL_PREFIX || "/", mode: e.AUTOPILOT_MODE, dryRun: e.DRY_RUN }, "gudini-threads app listening");

  await installRepeatableJobs().catch((err) => log.error({ err }, "could not install repeatable jobs"));
  syncAccounts().catch((err) => log.warn({ err: err instanceof Error ? err.message : String(err) }, "account sync skipped"));

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    await app.close().catch(() => undefined);
    await closeQueues();
    await closeRedis();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger().error({ err }, "app failed to start");
  process.exit(1);
});
