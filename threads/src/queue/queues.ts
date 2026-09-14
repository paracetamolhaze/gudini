import { Queue, type JobsOptions } from "bullmq";
import { redisConnection } from "./connection.js";

/**
 * One BullMQ queue per worker role. Priorities: P0 breaking = 1 … P3 evergreen = 4 (lower runs first).
 * Every job is retryable (exponential backoff) and idempotent by construction: handlers re-read
 * state from Postgres and skip work already done.
 */
export const QUEUE_NAMES = [
  "source",
  "analysis",
  "content",
  "media",
  "publisher",
  "replies",
  "engagement",
  "analytics",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const PRIORITY: Record<"P0" | "P1" | "P2" | "P3", number> = { P0: 1, P1: 2, P2: 3, P3: 4 };
export type Priority = keyof typeof PRIORITY;

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 4,
  backoff: { type: "exponential", delay: 15_000 },
  removeOnComplete: { age: 24 * 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 2000 },
};

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redisConnection(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
    queues.set(name, q);
  }
  return q;
}

export async function enqueue(
  name: QueueName,
  jobName: string,
  data: Record<string, unknown>,
  opts: JobsOptions & { priority?: number; jobId?: string } = {},
): Promise<string> {
  const job = await getQueue(name).add(jobName, data, { ...DEFAULT_JOB_OPTIONS, ...opts });
  return String(job.id);
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close().catch(() => undefined)));
  queues.clear();
}

export async function queueCounts(): Promise<Record<string, { waiting: number; active: number; delayed: number; failed: number }>> {
  const out: Record<string, { waiting: number; active: number; delayed: number; failed: number }> = {};
  for (const name of QUEUE_NAMES) {
    const c = await getQueue(name).getJobCounts("waiting", "active", "delayed", "failed");
    out[name] = {
      waiting: c.waiting ?? 0,
      active: c.active ?? 0,
      delayed: c.delayed ?? 0,
      failed: c.failed ?? 0,
    };
  }
  return out;
}
