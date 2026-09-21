import { one, query } from "../pool.js";
import type { AttemptRecord, AttemptStore } from "../../platforms/attempts.js";
import type { PlatformId } from "../../platforms/types.js";

export interface PublicationRow {
  id: string;
  draft_id: string | null;
  candidate_id: string | null;
  source_post_id: string | null;
  media_asset_id: string | null;
  platform: PlatformId;
  platform_post_id: string;
  permalink: string | null;
  published_text: string;
  published_at: Date;
  prompt_version: string | null;
  model: string | null;
  dry_run: boolean;
  meta_json: unknown;
  created_at: Date;
}

interface AttemptRow {
  idempotency_key: string;
  status: AttemptRecord["status"];
  container_id: string | null;
  platform_post_id: string | null;
  error: string | null;
  created_at: Date;
}

/** Keys look like `draft:<uuid>` (Threads, historic), `draft:<uuid>:x`, `interaction:<uuid>[:x]`, plus `:partN`. */
function platformOfKey(key: string): PlatformId {
  return /:x(:|$)/.test(key) ? "x" : "threads";
}

/** Postgres-backed attempt store; `start` relies on the unique idempotency key. */
export const attemptStore: AttemptStore = {
  async get(key) {
    const row = await one<AttemptRow>(`SELECT idempotency_key, status, container_id, platform_post_id, error, created_at FROM publication_attempts WHERE idempotency_key = $1`, [key]);
    return row ? { idempotencyKey: row.idempotency_key, status: row.status, containerId: row.container_id, postId: row.platform_post_id, error: row.error, createdAt: row.created_at } : null;
  },
  async start(key, kind) {
    const m = key.match(/^(draft|interaction):([0-9a-f-]{36})/);
    const rows = await query(
      `INSERT INTO publication_attempts (idempotency_key, kind, draft_id, interaction_id, platform, status) VALUES ($1,$2,$3,$4,$5,'STARTED') ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [key, kind, m?.[1] === "draft" ? m[2] : null, m?.[1] === "interaction" ? m[2] : null, platformOfKey(key)],
    );
    return rows.length > 0;
  },
  async update(key, patch) {
    await query(
      `UPDATE publication_attempts SET status = COALESCE($2, status), container_id = COALESCE($3, container_id), platform_post_id = COALESCE($4, platform_post_id), error = $5, updated_at = now() WHERE idempotency_key = $1`,
      [key, patch.status ?? null, patch.containerId ?? null, patch.postId ?? null, patch.error === undefined ? null : patch.error],
    );
  },
};

export const draftAttemptKey = (draftId: string, platform: PlatformId): string => (platform === "threads" ? `draft:${draftId}` : `draft:${draftId}:${platform}`);
export const interactionAttemptKey = (interactionId: string, platform: PlatformId): string => (platform === "threads" ? `interaction:${interactionId}` : `interaction:${interactionId}:${platform}`);

export async function insertPublication(input: {
  draftId: string | null;
  candidateId: string | null;
  sourcePostId: string | null;
  mediaAssetId: string | null;
  platform: PlatformId;
  platformPostId: string;
  permalink: string | null;
  text: string;
  promptVersion: string | null;
  model: string | null;
  dryRun: boolean;
  meta: unknown;
}): Promise<PublicationRow> {
  const row = await one<PublicationRow>(
    `INSERT INTO publications (draft_id, candidate_id, source_post_id, media_asset_id, platform, platform_post_id, permalink, published_text, prompt_version, model, dry_run, meta_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT (platform, platform_post_id) DO UPDATE SET permalink = COALESCE(EXCLUDED.permalink, publications.permalink)
     RETURNING *`,
    [input.draftId, input.candidateId, input.sourcePostId, input.mediaAssetId, input.platform, input.platformPostId, input.permalink, input.text, input.promptVersion, input.model, input.dryRun, JSON.stringify(input.meta ?? null)],
  );
  if (!row) throw new Error("insert publication failed");
  return row;
}

export async function publicationsForDraft(draftId: string): Promise<PublicationRow[]> {
  return query<PublicationRow>(`SELECT * FROM publications WHERE draft_id = $1 ORDER BY published_at ASC`, [draftId]);
}

/** One post that went to two platforms is still one post for caps and spacing. */
const DISTINCT_POST = `count(DISTINCT COALESCE(draft_id::text, id::text))::int`;

export async function postsPublishedToday(timezone: string): Promise<number> {
  const row = await one<{ n: number }>(`SELECT ${DISTINCT_POST} AS n FROM publications WHERE (published_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`, [timezone]);
  return row?.n ?? 0;
}

export async function postsPublishedLast24h(): Promise<number> {
  const row = await one<{ n: number }>(`SELECT ${DISTINCT_POST} AS n FROM publications WHERE published_at >= now() - interval '24 hours'`);
  return row?.n ?? 0;
}

export async function lastPublishedAt(): Promise<Date | null> {
  const row = await one<{ published_at: Date }>(`SELECT published_at FROM publications ORDER BY published_at DESC LIMIT 1`);
  return row?.published_at ?? null;
}

export async function listPublications(
  limit = 50,
  before?: string,
  platform?: PlatformId,
): Promise<Array<PublicationRow & { views: number | null; likes: number | null; replies: number | null; reposts: number | null; quotes: number | null; captured_at: Date | null; topic: string | null; category: string | null }>> {
  return query(
    `SELECT p.*, s.views, s.likes, s.replies, s.reposts, s.quotes, s.captured_at, c.topic, c.category
     FROM publications p
     LEFT JOIN LATERAL (SELECT * FROM insight_snapshots i WHERE i.publication_id = p.id ORDER BY captured_at DESC LIMIT 1) s ON true
     LEFT JOIN content_candidates c ON c.id = p.candidate_id
     WHERE ($2::timestamptz IS NULL OR p.published_at < $2) AND ($3::text IS NULL OR p.platform = $3)
     ORDER BY p.published_at DESC LIMIT $1`,
    [limit, before ?? null, platform ?? null],
  );
}
