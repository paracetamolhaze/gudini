import { env } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { closePool } from "./db/pool.js";
import { logger } from "./shared/logger.js";
import { closeRedis } from "./queue/connection.js";
import { closeQueues } from "./queue/queues.js";
import { startWorkers, stopWorkers } from "./workers/index.js";
import { wireLlm } from "./services/llmWiring.js";

/** Worker process: consumes every BullMQ queue. Safe to run more than one instance. */
async function main(): Promise<void> {
  const e = env();
  const log = logger();
  await runMigrations();
  wireLlm();
  await startWorkers();
  log.info({ mode: e.AUTOPILOT_MODE, dryRun: e.DRY_RUN }, "gudini-threads worker started");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "worker shutting down");
    await stopWorkers();
    await closeQueues();
    await closeRedis();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger().error({ err }, "worker failed to start");
  process.exit(1);
});
