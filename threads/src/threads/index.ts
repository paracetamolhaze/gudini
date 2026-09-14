import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { ThreadsClient } from "./client.js";

/**
 * Process-wide Threads client built from env. The token never leaves this module: callers get
 * the client, not the string. Tests construct ThreadsClient directly with a fake fetch.
 */
let client: ThreadsClient | null = null;

export function threadsClient(): ThreadsClient {
  if (!client) {
    const e = env();
    client = new ThreadsClient({
      accessToken: e.THREADS_ACCESS_TOKEN,
      userId: e.THREADS_USER_ID || undefined,
      graphHost: e.THREADS_GRAPH_HOST,
      logger: logger().child({ module: "threads" }),
    });
  }
  return client;
}

export function setThreadsClientForTests(next: ThreadsClient | null): void {
  client = next;
}

export { ThreadsClient } from "./client.js";
export * from "./errors.js";
export * from "./types.js";
