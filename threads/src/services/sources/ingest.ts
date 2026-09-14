import { contentHash, simhash, hammingDistance } from "../dedup/hash.js";
import { textSimilarity } from "../dedup/similarity.js";
import type { NormalizedPost } from "./normalize.js";
import type { NewSourcePost, SourcePostRow } from "../../db/repos/sourcePosts.js";

/**
 * Ingest decision for one normalized post, with storage injected so the logic is testable
 * without Postgres. Steps: window check → exact hash → insert-once → near-duplicate vs recent.
 */
export interface IngestDeps {
  insert(post: NewSourcePost): Promise<SourcePostRow | null>;
  findByContentHash(hash: string): Promise<SourcePostRow | null>;
  recentPosts(windowHours: number, excludeId: string): Promise<SourcePostRow[]>;
  markDuplicate(id: string, duplicateOf: string): Promise<void>;
  /** Optional embedding similarity: returns the best (similarity, row) among recent posts. */
  embeddingMatch?(text: string, excludeId: string): Promise<{ similarity: number; row: SourcePostRow } | null>;
}

export interface IngestOptions {
  sourceId: string | null;
  windowHours: number;
  similarityThreshold: number;
  /** Posts older than this are ignored (breaking news from a week ago is not news). */
  maxAgeHours: number;
  now?: Date;
}

export type IngestOutcome =
  | { kind: "inserted"; row: SourcePostRow }
  | { kind: "already_stored" }
  | { kind: "too_old"; ageHours: number }
  | { kind: "empty" }
  | { kind: "duplicate"; row: SourcePostRow; duplicateOf: SourcePostRow; similarity: number; method: "exact" | "near" | "embedding" };

export async function ingestPost(post: NormalizedPost, opts: IngestOptions, deps: IngestDeps): Promise<IngestOutcome> {
  const text = post.text.trim();
  if (!text && post.media.length === 0) return { kind: "empty" };
  const now = opts.now ?? new Date();
  if (post.publishedAt) {
    const ageHours = (now.getTime() - post.publishedAt.getTime()) / 3_600_000;
    if (ageHours > opts.maxAgeHours) return { kind: "too_old", ageHours };
  }
  const hash = contentHash(text || post.media.map((m) => m.url).join(" "));
  const sem = text ? simhash(text) : null;
  const inserted = await deps.insert({
    sourceId: opts.sourceId,
    platform: post.platform,
    platformPostId: post.platformPostId,
    authorUsername: post.authorUsername,
    text,
    permalink: post.permalink,
    publishedAt: post.publishedAt,
    media: post.media,
    raw: post.raw,
    contentHash: hash,
    semanticHash: sem,
  });
  if (!inserted) return { kind: "already_stored" };

  // Exact duplicate: same canonical text seen before (retweet-style copies, cross-posted feeds).
  const exact = await deps.findByContentHash(hash);
  if (exact && exact.id !== inserted.id) {
    await deps.markDuplicate(inserted.id, exact.id);
    return { kind: "duplicate", row: inserted, duplicateOf: exact, similarity: 1, method: "exact" };
  }

  if (!text) return { kind: "inserted", row: inserted };

  // Near duplicate: cheap simhash prefilter, then shingle/word similarity against the recent window.
  const recent = await deps.recentPosts(opts.windowHours, inserted.id);
  let best: { row: SourcePostRow; similarity: number } | null = null;
  for (const r of recent) {
    if (!r.text) continue;
    if (sem && r.semantic_hash && hammingDistance(sem, r.semantic_hash) > 24) continue;
    const s = textSimilarity(text, r.text);
    if (!best || s > best.similarity) best = { row: r, similarity: s };
  }
  if (best && best.similarity >= opts.similarityThreshold) {
    await deps.markDuplicate(inserted.id, best.row.id);
    return { kind: "duplicate", row: inserted, duplicateOf: best.row, similarity: best.similarity, method: "near" };
  }

  if (deps.embeddingMatch) {
    const m = await deps.embeddingMatch(text, inserted.id);
    if (m && m.similarity >= Math.max(0.9, opts.similarityThreshold + 0.25)) {
      await deps.markDuplicate(inserted.id, m.row.id);
      return { kind: "duplicate", row: inserted, duplicateOf: m.row, similarity: m.similarity, method: "embedding" };
    }
  }
  return { kind: "inserted", row: inserted };
}
