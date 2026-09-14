import type { ThreadsClient } from "../../threads/client.js";
import { PermissionError } from "../../threads/errors.js";
import type { ThreadsMedia } from "../../threads/types.js";
import { normalizeThreadsMedia, type NormalizedPost } from "./normalize.js";

/**
 * Watch a public Threads profile through the official API only.
 *
 *   1. GET /profile_posts?username=…      needs threads_profile_discovery (public, 100+ followers)
 *   2. GET /keyword_search?author_username=… per niche keyword — needs threads_keyword_search
 *
 * When both are refused the error names the missing scopes so the UI can show
 * "API permission required" instead of an empty list. No HTML scraping, no headless browser.
 */
export class SourceAccessError extends Error {
  readonly scopes: string[];
  constructor(message: string, scopes: string[]) {
    super(message);
    this.name = "SourceAccessError";
    this.scopes = scopes;
  }
}

export interface ProfileFetchResult {
  posts: NormalizedPost[];
  method: "profile_posts" | "keyword_search";
  /** Requests spent (keyword fallback costs one per keyword). */
  requests: number;
  notes: string[];
}

export async function fetchProfilePosts(
  client: ThreadsClient,
  username: string,
  opts: { sinceSec?: number; fallbackKeywords: string[]; limit?: number },
): Promise<ProfileFetchResult> {
  const user = username.replace(/^@/, "").trim().toLowerCase();
  const notes: string[] = [];
  let profileError: PermissionError | null = null;
  try {
    const page = await client.profilePosts(user, { since: opts.sinceSec, limit: opts.limit ?? 25 });
    const posts = collect(page.data ?? [], user);
    return { posts, method: "profile_posts", requests: 1, notes };
  } catch (err) {
    if (!(err instanceof PermissionError)) throw err;
    profileError = err;
    notes.push(`profile_posts refused: ${err.scope ?? "threads_profile_discovery"}`);
  }

  const keywords = opts.fallbackKeywords.map((k) => k.trim()).filter(Boolean).slice(0, 12);
  if (keywords.length === 0) {
    throw new SourceAccessError(`profile_posts needs threads_profile_discovery and no fallback keywords are configured for @${user}`, ["threads_profile_discovery"]);
  }
  const byId = new Map<string, ThreadsMedia>();
  let requests = 1;
  let searchError: PermissionError | null = null;
  for (const q of keywords) {
    try {
      requests++;
      const page = await client.keywordSearch({ q, authorUsername: user, since: opts.sinceSec, searchType: "RECENT", limit: 50 });
      for (const m of page.data ?? []) if (m.id) byId.set(m.id, m);
    } catch (err) {
      if (err instanceof PermissionError) {
        searchError = err;
        break;
      }
      throw err;
    }
  }
  if (searchError) {
    throw new SourceAccessError(
      `Cannot read @${user}: profile_posts needs threads_profile_discovery (${profileError?.detail || "refused"}) and keyword_search needs threads_keyword_search (${searchError.detail || "refused"}). Add the permissions to the app, regenerate the token, and request Advanced Access for non-tester profiles.`,
      ["threads_profile_discovery", "threads_keyword_search"],
    );
  }
  const posts = collect([...byId.values()], user);
  notes.push(`keyword_search fallback: ${keywords.length} keyword(s), ${posts.length} post(s)`);
  return { posts, method: "keyword_search", requests, notes };
}

function collect(items: ThreadsMedia[], user: string): NormalizedPost[] {
  const out: NormalizedPost[] = [];
  for (const m of items) {
    if (m.is_reply === true) continue;
    const author = typeof m.username === "string" ? m.username.toLowerCase() : "";
    if (author && author !== user) continue; // author_username is exact-match but be defensive
    const p = normalizeThreadsMedia(m);
    if (p) out.push(p);
  }
  return out.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
}
