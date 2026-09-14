import { Redis } from "ioredis";
import { env } from "../config/env.js";

/**
 * Redis connections. BullMQ needs `maxRetriesPerRequest: null` on blocking connections;
 * one shared instance per process for queues/schedulers, a fresh one per Worker (BullMQ duplicates it).
 */
let shared: Redis | null = null;

export function redisConnection(): Redis {
  if (!shared) {
    const conn = new Redis(env().REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    conn.on("error", (err) => {
      console.error("[redis] connection error", err.message);
    });
    shared = conn;
  }
  return shared;
}

export async function closeRedis(): Promise<void> {
  if (shared) {
    await shared.quit().catch(() => undefined);
    shared = null;
  }
}

export async function pingRedis(): Promise<{ ok: boolean; message: string }> {
  try {
    const pong = await redisConnection().ping();
    return { ok: pong === "PONG", message: pong };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
