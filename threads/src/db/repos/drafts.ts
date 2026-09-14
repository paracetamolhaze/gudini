import { one, query } from "../pool.js";

export type DraftStatus = "DRAFT" | "NEEDS_REVIEW" | "APPROVED" | "SCHEDULED" | "PUBLISHING" | "PUBLISHED" | "REJECTED" | "FAILED" | "EXPIRED";

export interface DraftRow {
  id: string;
  candidate_id: string | null;
  type: string;
  text: string;
  hook: string | null;
  body: string | null;
  source_summary: string | null;
  source_urls_json: string[];
  confidence: number | null;
  risk_score: number | null;
  status: DraftStatus;
  review_reason: string | null;
  scheduled_at: Date | null;
  priority: "P0" | "P1" | "P2" | "P3";
  prompt_version: string | null;
  model: string | null;
  validation_json: unknown;
  variants_json: unknown;
  image_asset_id: string | null;
  expires_at: Date | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function insertDraft(input: {
  candidateId: string | null;
  type: string;
  text: string;
  hook: string | null;
  body: string | null;
  sourceSummary: string | null;
  sourceUrls: string[];
  confidence: number | null;
  riskScore: number | null;
  status: DraftStatus;
  reviewReason: string | null;
  priority: DraftRow["priority"];
  promptVersion: string | null;
  model: string | null;
  validation: unknown;
  variants: unknown;
  expiresAt: Date | null;
}): Promise<DraftRow> {
  const row = await one<DraftRow>(
    `INSERT INTO drafts (candidate_id, type, text, hook, body, source_summary, source_urls_json, confidence, risk_score, status, review_reason, priority, prompt_version, model, validation_json, variants_json, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17) RETURNING *`,
    [
      input.candidateId,
      input.type,
      input.text,
      input.hook,
      input.body,
      input.sourceSummary,
      JSON.stringify(input.sourceUrls),
      input.confidence,
      input.riskScore,
      input.status,
      input.reviewReason,
      input.priority,
      input.promptVersion,
      input.model,
      JSON.stringify(input.validation ?? null),
      JSON.stringify(input.variants ?? null),
      input.expiresAt,
    ],
  );
  if (!row) throw new Error("insert draft returned no row");
  return row;
}

export async function getDraft(id: string): Promise<DraftRow | null> {
  return one<DraftRow>(`SELECT * FROM drafts WHERE id = $1`, [id]);
}

export async function listDrafts(opts: { status?: string | string[]; limit?: number; before?: string }): Promise<DraftRow[]> {
  const params: unknown[] = [];
  const conds: string[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (opts.status) {
    const list = Array.isArray(opts.status) ? opts.status : opts.status.split(",");
    conds.push(`status = ANY(${push(list)}::text[])`);
  }
  if (opts.before) conds.push(`created_at < ${push(opts.before)}`);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return query<DraftRow>(`SELECT * FROM drafts ${where} ORDER BY created_at DESC LIMIT ${push(Math.min(200, opts.limit ?? 50))}`, params);
}

export async function updateDraft(
  id: string,
  patch: Partial<{
    text: string;
    hook: string | null;
    body: string | null;
    status: DraftStatus;
    review_reason: string | null;
    scheduled_at: Date | null;
    validation_json: unknown;
    image_asset_id: string | null;
    error: string | null;
    confidence: number | null;
    priority: DraftRow["priority"];
  }>,
): Promise<DraftRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, v: unknown, cast = "") => {
    params.push(v);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (patch.text !== undefined) add("text", patch.text);
  if (patch.hook !== undefined) add("hook", patch.hook);
  if (patch.body !== undefined) add("body", patch.body);
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.review_reason !== undefined) add("review_reason", patch.review_reason);
  if (patch.scheduled_at !== undefined) add("scheduled_at", patch.scheduled_at);
  if (patch.validation_json !== undefined) add("validation_json", JSON.stringify(patch.validation_json), "::jsonb");
  if (patch.image_asset_id !== undefined) add("image_asset_id", patch.image_asset_id);
  if (patch.error !== undefined) add("error", patch.error);
  if (patch.confidence !== undefined) add("confidence", patch.confidence);
  if (patch.priority !== undefined) add("priority", patch.priority);
  if (!sets.length) return getDraft(id);
  params.push(id);
  return one<DraftRow>(`UPDATE drafts SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
}

/** Atomic status transition: returns the row only if it was in one of `from`. */
export async function transitionDraft(id: string, from: DraftStatus[], to: DraftStatus, extra: { review_reason?: string | null; error?: string | null } = {}): Promise<DraftRow | null> {
  return one<DraftRow>(
    `UPDATE drafts SET status = $3, review_reason = COALESCE($4, review_reason), error = $5, updated_at = now()
     WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
    [id, from, to, extra.review_reason ?? null, extra.error ?? null],
  );
}

export async function draftsForCandidate(candidateId: string): Promise<DraftRow[]> {
  return query<DraftRow>(`SELECT * FROM drafts WHERE candidate_id = $1 ORDER BY created_at DESC`, [candidateId]);
}

export async function recentPublishedTexts(limit = 10): Promise<string[]> {
  const rows = await query<{ text: string }>(
    `SELECT published_text AS text FROM publications ORDER BY published_at DESC LIMIT $1`,
    [limit],
  );
  const drafts = await query<{ text: string }>(`SELECT text FROM drafts WHERE status IN ('DRAFT','NEEDS_REVIEW','APPROVED','SCHEDULED') ORDER BY created_at DESC LIMIT $1`, [limit]);
  return [...rows.map((r) => r.text), ...drafts.map((d) => d.text)];
}

export async function expireDrafts(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `UPDATE drafts SET status = 'EXPIRED', updated_at = now() WHERE expires_at < now() AND status IN ('DRAFT','NEEDS_REVIEW','APPROVED','SCHEDULED') RETURNING id`,
  );
  return rows.map((r) => r.id);
}
