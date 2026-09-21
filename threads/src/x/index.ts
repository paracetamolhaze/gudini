import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { recordUsage, xUnitPrice } from "../platforms/usage.js";
import { XClient } from "./client.js";

/**
 * Process-wide X client built from env. Keys never leave this module; every billable call lands in
 * the platform_usage ledger. Tests construct XClient directly with a fake fetch.
 */
let client: XClient | null = null;

export function xClient(): XClient {
  if (!client) {
    const e = env();
    client = new XClient({
      credentials: { consumerKey: e.X_API_KEY, consumerSecret: e.X_API_SECRET, accessToken: e.X_ACCESS_TOKEN, accessSecret: e.X_ACCESS_SECRET },
      apiHost: e.X_API_HOST,
      logger: logger().child({ module: "x" }),
      onUsage: (kind, units, meta) => recordUsage("x", kind, units, xUnitPrice(kind), meta),
    });
  }
  return client;
}

export function setXClientForTests(next: XClient | null): void {
  client = next;
}

export { XClient, XReplyNotAllowedError, XDuplicateContentError, containsUrl } from "./client.js";
export type { XPost, XUser } from "./client.js";
