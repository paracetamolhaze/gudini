import { one, query } from "../pool.js";

export type SourceType = "THREADS_PROFILE" | "THREADS_SEARCH" | "RSS" | "NEWS" | "MANUAL";

export interface SourceRow {
  id: string;
  type: SourceType;
  platform: string;
  username: string | null;
  name: string;
  url: string | null;
  language: string;
  priority: number;
  enabled: boolean;
  trust_score: number;
  copy_mode: string;
  translate_images: boolean;
  minimum_score: number | null;
  keywords: string[];
  poll_minutes: number;
  last_checked_at: Date | null;
  last_post_at: Date | null;
  last_error: string | null;
  last_status: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SourceInput {
  type: SourceType;
  username?: string | null;
  name?: string;
  url?: string | null;
  language?: string;
  priority?: number;
  enabled?: boolean;
  trust_score?: number;
  translate_images?: boolean;
  minimum_score?: number | null;
  keywords?: string[];
  poll_minutes?: number;
}

export async function listSources(): Promise<SourceRow[]> {
  return query<SourceRow>(`SELECT * FROM sources ORDER BY priority ASC, created_at DESC`);
}

export async function getSource(id: string): Promise<SourceRow | null> {
  return one<SourceRow>(`SELECT * FROM sources WHERE id = $1`, [id]);
}

export async function insertSource(input: SourceInput): Promise<SourceRow> {
  const username = input.username?.trim().replace(/^@/, "") || null;
  const name = input.name?.trim() || (username ? `@${username}` : input.url?.trim() || input.type);
  const row = await one<SourceRow>(
    `INSERT INTO sources (type, username, name, url, language, priority, enabled, trust_score, translate_images, minimum_score, keywords, poll_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      input.type,
      username,
      name,
      input.url?.trim() || null,
      input.language ?? "en",
      input.priority ?? 2,
      input.enabled ?? true,
      input.trust_score ?? 60,
      // Картинка из публикации — нормальная часть поста; выключается галочкой у источника.
      input.translate_images ?? true,
      input.minimum_score ?? null,
      input.keywords ?? [],
      input.poll_minutes ?? 15,
    ],
  );
  if (!row) throw new Error("insert source returned no row");
  return row;
}

export async function updateSource(id: string, patch: Partial<SourceInput>): Promise<SourceRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.username !== undefined) add("username", patch.username?.trim().replace(/^@/, "") || null);
  if (patch.name !== undefined) add("name", patch.name);
  if (patch.url !== undefined) add("url", patch.url?.trim() || null);
  if (patch.language !== undefined) add("language", patch.language);
  if (patch.priority !== undefined) add("priority", patch.priority);
  if (patch.enabled !== undefined) add("enabled", patch.enabled);
  if (patch.trust_score !== undefined) add("trust_score", patch.trust_score);
  if (patch.translate_images !== undefined) add("translate_images", patch.translate_images);
  if (patch.minimum_score !== undefined) add("minimum_score", patch.minimum_score);
  if (patch.keywords !== undefined) add("keywords", patch.keywords);
  if (patch.poll_minutes !== undefined) add("poll_minutes", patch.poll_minutes);
  if (!sets.length) return getSource(id);
  params.push(id);
  return one<SourceRow>(`UPDATE sources SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
}

export async function deleteSource(id: string): Promise<boolean> {
  const rows = await query(`DELETE FROM sources WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

export async function markSourceChecked(id: string, result: { status: string; error: string | null; lastPostAt?: Date | null }): Promise<void> {
  await query(
    `UPDATE sources SET last_checked_at = now(), last_status = $2, last_error = $3,
       last_post_at = CASE WHEN $4::timestamptz IS NULL THEN last_post_at ELSE GREATEST(COALESCE(last_post_at, $4::timestamptz), $4::timestamptz) END,
       updated_at = now()
     WHERE id = $1`,
    [id, result.status, result.error, result.lastPostAt ?? null],
  );
}

/** Enabled sources whose poll interval has elapsed; priority 0 sources are polled twice as often. */
export async function dueSources(): Promise<SourceRow[]> {
  return query<SourceRow>(
    `SELECT * FROM sources WHERE enabled
       AND (last_checked_at IS NULL OR last_checked_at < now() - make_interval(mins => CASE WHEN priority = 0 THEN GREATEST(2, poll_minutes / 2) ELSE poll_minutes END))
     ORDER BY priority ASC, last_checked_at ASC NULLS FIRST
     LIMIT 25`,
  );
}
