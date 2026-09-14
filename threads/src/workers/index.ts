import { Worker, type Job } from "bullmq";
import { redisConnection } from "../queue/connection.js";
import { QUEUE_NAMES, type QueueName } from "../queue/queues.js";
import { logger } from "../shared/logger.js";
import { query } from "../db/pool.js";
import { audit } from "../services/audit.js";
import { scrubSecrets } from "../shared/logger.js";

/**
 * Worker registry. A handler receives the job and a child logger bound to jobId; every handler
 * must be idempotent (re-reads state from Postgres before acting). Job outcomes are mirrored to
 * the `jobs` table so the dashboard can show them without Redis access.
 */
export type JobHandler = (job: Job, ctx: { log: ReturnType<typeof logger> }) => Promise<unknown>;

const handlers = new Map<QueueName, Map<string, JobHandler>>();
const workers: Worker[] = [];

export function registerHandler(queue: QueueName, jobName: string, handler: JobHandler): void {
  let byName = handlers.get(queue);
  if (!byName) {
    byName = new Map();
    handlers.set(queue, byName);
  }
  byName.set(jobName, handler);
}

async function recordJob(job: Job, status: "active" | "completed" | "failed", result: unknown, error: string | null): Promise<void> {
  try {
    await query(
      `INSERT INTO jobs (queue, job_id, name, status, payload, result, error, attempts, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8, to_timestamp($9 / 1000.0), $10)
       ON CONFLICT (queue, job_id, attempts) DO UPDATE SET status = EXCLUDED.status, result = EXCLUDED.result, error = EXCLUDED.error, finished_at = EXCLUDED.finished_at`,
      [
        job.queueName,
        String(job.id),
        job.name,
        status,
        JSON.stringify(job.data ?? {}),
        result === undefined ? null : JSON.stringify(result),
        error,
        job.attemptsMade,
        job.processedOn ?? Date.now(),
        status === "active" ? null : new Date(),
      ],
    );
  } catch (err) {
    logger().warn({ err }, "job record failed");
  }
}

export async function startWorkers(concurrency: Partial<Record<QueueName, number>> = {}): Promise<void> {
  // Handlers are registered by the phase modules; import them here so the worker binary is self-contained.
  await import("./handlers/index.js");
  for (const name of QUEUE_NAMES) {
    const worker = new Worker(
      name,
      async (job) => {
        const log = logger().child({ queue: name, jobName: job.name, jobId: job.id, attempt: job.attemptsMade + 1 });
        const handler = handlers.get(name)?.get(job.name);
        if (!handler) {
          log.warn("no handler registered for job");
          return { skipped: true, reason: "no handler" };
        }
        await recordJob(job, "active", undefined, null);
        try {
          const result = await handler(job, { log });
          await recordJob(job, "completed", result ?? null, null);
          return result;
        } catch (err) {
          const message = scrubSecrets(err instanceof Error ? err.message : String(err));
          log.error({ err }, "job failed");
          await recordJob(job, "failed", null, message);
          if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
            await audit("JOB_FAILED", `Задача ${name}/${job.name} провалилась после ${job.attemptsMade + 1} попыток: ${message}`, { jobId: String(job.id) }, { data: job.data }, "error");
          }
          throw err;
        }
      },
      {
        connection: redisConnection().duplicate(),
        concurrency: concurrency[name] ?? (name === "publisher" || name === "replies" || name === "engagement" ? 1 : 2),
        lockDuration: 10 * 60_000,
        stalledInterval: 60_000,
      },
    );
    worker.on("error", (err) => logger().error({ err, queue: name }, "worker error"));
    workers.push(worker);
  }
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close().catch(() => undefined)));
  workers.length = 0;
}
