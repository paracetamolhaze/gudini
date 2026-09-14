import { one, query } from "../pool.js";
import type { NormalizedMedia } from "../../services/sources/normalize.js";

export type SourcePostStatus = "NEW" | "ANALYZING" | "ANALYZED" | "DUPLICATE" | "REJECTED" | "CANDIDATE" | "FAILED";

export interface SourcePostRow {
  id: string;
  source_id: string | null;
  platform: string;
  platform_post_id: string;
  author_username: string;
  text: string;
  permalink: string | null;
  published_at: Date | null;
  media_json: NormalizedMedia[];
  raw_json: unknown;
  content_hash: string;
  semantic_hash: string | null;
  status: SourcePostStatus;
  duplicate_of: string | null;
  created_at: Date;
}

export interface NewSourcePost {
  sourceId: string | null;
  platform: string;
  platformPostId: string;
  authorUsername: string;
  text: string;
  permalink: string | null;
  publishedAt: Date | null;
  media: NormalizedMedia[];
  raw: unknown;
  contentHash: string;
  semanticHash: string | null;
}

/** Insert once per (platform, platform_post_id). Returns null when the post was already stored. */
export async function insertSourcePost(p: NewSourcePost): Promise<SourcePostRow | null> {
  return one<SourcePostRow>(
    `INSERT INTO source_posts (source_id, platform, platform_post_id, author_username, text, permalink, published_at, media_json, raw_json, content_hash, semantic_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)
     ON CONFLICT (platform, platform_post_id) DO NOTHING
     RETURNING *`,
    [p.sourceId, p.platform, p.platformPostId, p.authorUsername, p.text, p.permalink, p.publishedAt, JSON.stringify(p.media), JSON.stringify(p.raw ?? null), p.contentHash, p.semanticHash],
  );
}

export async function getSourcePost(id: string): Promise<SourcePostRow | null> {
  return one<SourcePostRow>(`SELECT * FROM source_posts WHERE id = $1`, [id]);
}

export async function findByContentHash(hash: string, excludeId?: string): Promise<SourcePostRow | null> {
  return one<SourcePostRow>(`SELECT * FROM source_posts WHERE content_hash = $1 AND ($2::uuid IS NULL OR id <> $2) ORDER BY created_at ASC LIMIT 1`, [hash, excludeId ?? null]);
}

export async function recentSourcePosts(windowHours: number, excludeId?: string, limit = 400): Promise<SourcePostRow[]> {
  return query<SourcePostRow>(
    `SELECT * FROM source_posts WHERE created_at >= now() - make_interval(hours => $1) AND ($2::uuid IS NULL OR id <> $2) AND status <> 'DUPLICATE'
     ORDER BY created_at DESC LIMIT $3`,
    [windowHours, excludeId ?? null, limit],
  );
}

export async function setSourcePostStatus(id: string, status: SourcePostStatus, duplicateOf: string | null = null): Promise<void> {
  await query(`UPDATE source_posts SET status = $2, duplicate_of = COALESCE($3, duplicate_of) WHERE id = $1`, [id, status, duplicateOf]);
}

export async function listSourcePosts(opts: { sourceId?: string; status?: string; limit?: number; before?: string }): Promise<SourcePostRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (opts.sourceId) conditions.push(`source_id = ${push(opts.sourceId)}`);
  if (opts.status) conditions.push(`status = ${push(opts.status)}`);
  if (opts.before) conditions.push(`created_at < ${push(opts.before)}`);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return query<SourcePostRow>(`SELECT * FROM source_posts ${where} ORDER BY created_at DESC LIMIT ${push(Math.min(200, opts.limit ?? 50))}`, params);
}

export async function pendingSourcePosts(limit = 20): Promise<SourcePostRow[]> {
  return query<SourcePostRow>(`SELECT * FROM source_posts WHERE status = 'NEW' ORDER BY created_at ASC LIMIT $1`, [limit]);
}
