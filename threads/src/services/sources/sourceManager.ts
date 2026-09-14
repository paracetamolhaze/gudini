import { loadSettings } from "../../config/settings.js";
import { dueSources, getSource, markSourceChecked, type SourceRow } from "../../db/repos/sources.js";
import { findByContentHash, insertSourcePost, recentSourcePosts, setSourcePostStatus } from "../../db/repos/sourcePosts.js";
import { one } from "../../db/pool.js";
import { enqueue, PRIORITY, type Priority } from "../../queue/queues.js";
import { threadsClient } from "../../threads/index.js";
import { PermissionError, RateLimitError } from "../../threads/errors.js";
import { audit } from "../audit.js";
import { logger, errorMessage } from "../../shared/logger.js";
import { ingestPost, type IngestOutcome } from "./ingest.js";
import { fetchFeed, feedItemToPost } from "./rssSource.js";
import { fetchProfilePosts, SourceAccessError } from "./threadsProfileSource.js";
import { fetchSearchPosts } from "./threadsSearchSource.js";
import type { NormalizedPost } from "./normalize.js";

/**
 * Polls sources, normalizes what they return, stores each post once, marks duplicates and
 * queues the survivors for analysis. Every run is idempotent: re-polling the same source
 * inserts nothing new and queues nothing twice.
 */
export interface SourceCheckResult {
  sourceId: string;
  status: "OK" | "PERMISSION_REQUIRED" | "RATE_LIMITED" | "ERROR" | "DISABLED";
  fetched: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  method?: string;
  error?: string;
}

const priorityFor = (source: SourceRow): Priority => (["P0", "P1", "P2", "P3"][Math.min(3, Math.max(0, source.priority))] ?? "P2") as Priority;

async function ownUsername(): Promise<string> {
  const row = await one<{ username: string }>(`SELECT username FROM accounts ORDER BY updated_at DESC LIMIT 1`);
  return row?.username ?? "";
}

async function fetchForSource(source: SourceRow, sinceSec: number): Promise<{ posts: NormalizedPost[]; method: string; notes: string[] }> {
  const settings = await loadSettings();
  switch (source.type) {
    case "THREADS_PROFILE": {
      if (!source.username) throw new Error("profile source has no username");
      const keywords = source.keywords.length ? source.keywords : settings.sources.profileFallbackKeywords;
      const r = await fetchProfilePosts(threadsClient(), source.username, { sinceSec, fallbackKeywords: keywords });
      return { posts: r.posts, method: r.method, notes: r.notes };
    }
    case "THREADS_SEARCH": {
      const q = (source.url || source.name).trim();
      if (!q) throw new Error("search source has no query");
      const posts = await fetchSearchPosts(threadsClient(), q, { sinceSec, ownUsername: await ownUsername() });
      return { posts, method: "keyword_search", notes: [] };
    }
    case "RSS":
    case "NEWS": {
      if (!source.url) throw new Error("feed source has no url");
      const items = await fetchFeed(source.url);
      return { posts: items.map((i) => feedItemToPost(i, source.name)), method: "rss", notes: [] };
    }
    case "MANUAL":
      return { posts: [], method: "manual", notes: [] };
  }
}

export async function checkSource(source: SourceRow, opts: { force?: boolean } = {}): Promise<SourceCheckResult> {
  const settings = await loadSettings();
  const log = logger().child({ sourceId: source.id, source: source.name });
  if (!source.enabled && !opts.force) return { sourceId: source.id, status: "DISABLED", fetched: 0, inserted: 0, duplicates: 0, skipped: 0 };
  const windowHours = settings.dedup.windowHours;
  const sinceSec = Math.max(1688540400, Math.floor((Date.now() - windowHours * 3_600_000) / 1000));
  let fetched: { posts: NormalizedPost[]; method: string; notes: string[] };
  try {
    fetched = await fetchForSource(source, sinceSec);
  } catch (err) {
    const message = errorMessage(err);
    let status: SourceCheckResult["status"] = "ERROR";
    if (err instanceof SourceAccessError || err instanceof PermissionError) status = "PERMISSION_REQUIRED";
    else if (err instanceof RateLimitError) status = "RATE_LIMITED";
    await markSourceChecked(source.id, { status, error: message });
    await audit("SOURCE_ERROR", `Источник ${source.name}: ${message}`, { sourceId: source.id }, { status, scopes: err instanceof SourceAccessError ? err.scopes : undefined }, "warn");
    return { sourceId: source.id, status, fetched: 0, inserted: 0, duplicates: 0, skipped: 0, error: message };
  }

  const result: SourceCheckResult = { sourceId: source.id, status: "OK", fetched: fetched.posts.length, inserted: 0, duplicates: 0, skipped: 0, method: fetched.method };
  let newest: Date | null = null;
  for (const post of fetched.posts) {
    if (post.publishedAt && (!newest || post.publishedAt > newest)) newest = post.publishedAt;
    let outcome: IngestOutcome;
    try {
      outcome = await ingestPost(
        post,
        { sourceId: source.id, windowHours, similarityThreshold: settings.dedup.similarityThreshold, maxAgeHours: windowHours },
        {
          insert: insertSourcePost,
          findByContentHash: (h) => findByContentHash(h),
          recentPosts: (hours, excludeId) => recentSourcePosts(hours, excludeId),
          markDuplicate: (id, dup) => setSourcePostStatus(id, "DUPLICATE", dup),
        },
      );
    } catch (err) {
      log.error({ err, postId: post.platformPostId }, "ingest failed");
      result.skipped++;
      continue;
    }
    switch (outcome.kind) {
      case "inserted": {
        result.inserted++;
        await audit("SOURCE_DISCOVERED", `Новый пост от @${post.authorUsername || source.name}: ${post.text.slice(0, 120)}`, { sourceId: source.id, sourcePostId: outcome.row.id }, { permalink: post.permalink, media: post.media.length, method: fetched.method });
        await enqueue("analysis", "analysis:analyze", { sourcePostId: outcome.row.id }, { priority: PRIORITY[priorityFor(source)], jobId: `analyze:${outcome.row.id}` });
        break;
      }
      case "duplicate": {
        result.duplicates++;
        await audit(
          "SOURCE_DUPLICATE",
          `Повтор (${outcome.method}, сходство ${Math.round(outcome.similarity * 100)}%) поста от @${outcome.duplicateOf.author_username}: ${post.text.slice(0, 100)}`,
          { sourceId: source.id, sourcePostId: outcome.row.id },
          { duplicateOf: outcome.duplicateOf.id, similarity: outcome.similarity },
        );
        break;
      }
      case "already_stored":
      case "too_old":
      case "empty":
        result.skipped++;
        break;
    }
  }
  await markSourceChecked(source.id, { status: "OK", error: null, lastPostAt: newest });
  await audit(
    "SOURCE_CHECKED",
    `Проверен ${source.name} (${fetched.method}): ${result.fetched} постов, новых ${result.inserted}, повторов ${result.duplicates}`,
    { sourceId: source.id },
    { ...result, notes: fetched.notes },
  );
  return result;
}

export async function pollDueSources(): Promise<SourceCheckResult[]> {
  const due = await dueSources();
  const out: SourceCheckResult[] = [];
  for (const s of due) {
    out.push(await checkSource(s));
  }
  return out;
}

export async function checkSourceById(id: string, force = false): Promise<SourceCheckResult> {
  const source = await getSource(id);
  if (!source) throw new Error(`source ${id} not found`);
  return checkSource(source, { force });
}
