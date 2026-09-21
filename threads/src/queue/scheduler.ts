import { loadSettings } from "../config/settings.js";
import { logger } from "../shared/logger.js";
import { getQueue, type QueueName } from "./queues.js";

/**
 * Repeatable jobs (BullMQ job schedulers) — the server-side replacement for Electron timers.
 * Each tick enqueues one job; the worker decides what to do based on Postgres state, so a
 * restart of either process never re-runs a side effect.
 */
export interface RepeatableSpec {
  queue: QueueName;
  name: string;
  everyMs: number;
  data?: Record<string, unknown>;
}

export async function repeatableSpecs(): Promise<RepeatableSpec[]> {
  const s = await loadSettings();
  const minutes = (n: number) => Math.max(1, n) * 60_000;
  return [
    { queue: "source", name: "source:poll", everyMs: minutes(Math.min(s.sources.defaultPollMinutes, 5)) },
    { queue: "analysis", name: "analysis:sweep", everyMs: minutes(2) },
    { queue: "content", name: "content:sweep", everyMs: minutes(2) },
    { queue: "media", name: "media:sweep", everyMs: minutes(3) },
    { queue: "publisher", name: "publisher:tick", everyMs: minutes(1) },
    { queue: "publisher", name: "publisher:expire", everyMs: minutes(10) },
    { queue: "replies", name: "replies:poll", everyMs: minutes(s.replies.pollMinutes) },
    { queue: "engagement", name: "engagement:poll", everyMs: minutes(s.engagement.pollMinutes) },
    { queue: "analytics", name: "analytics:insights", everyMs: minutes(s.analytics.insightsPollMinutes) },
    { queue: "analytics", name: "analytics:recommend", everyMs: minutes(24 * 60) },
    { queue: "trades", name: "trades:sync", everyMs: minutes(s.trades.pollMinutes) },
    { queue: "market", name: "market:scan", everyMs: minutes(s.movers.pollMinutes) },
  ];
}

export async function installRepeatableJobs(): Promise<void> {
  const specs = await repeatableSpecs();
  for (const spec of specs) {
    const q = getQueue(spec.queue);
    // upsertJobScheduler replaces an existing schedule with the same id (interval changes apply).
    await q.upsertJobScheduler(spec.name, { every: spec.everyMs }, { name: spec.name, data: spec.data ?? {}, opts: { removeOnComplete: 50, removeOnFail: 100, attempts: 1 } });
  }
  logger().info({ count: specs.length }, "repeatable jobs installed");
}
