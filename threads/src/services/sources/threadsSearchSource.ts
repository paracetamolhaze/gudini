import type { ThreadsClient } from "../../threads/client.js";
import { normalizeThreadsMedia, type NormalizedPost } from "./normalize.js";

/** Public keyword search as a source: recent root posts for a query, excluding our own account. */
export async function fetchSearchPosts(
  client: ThreadsClient,
  query: string,
  opts: { sinceSec?: number; ownUsername?: string; limit?: number },
): Promise<NormalizedPost[]> {
  const page = await client.keywordSearch({ q: query, since: opts.sinceSec, searchType: "RECENT", limit: opts.limit ?? 50 });
  const own = (opts.ownUsername ?? "").toLowerCase();
  const out: NormalizedPost[] = [];
  for (const m of page.data ?? []) {
    if (m.is_reply === true) continue;
    if (own && typeof m.username === "string" && m.username.toLowerCase() === own) continue;
    const p = normalizeThreadsMedia(m);
    if (p) out.push(p);
  }
  return out;
}
