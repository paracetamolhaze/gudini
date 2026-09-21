import { one, query } from "../pool.js";
import type { PlatformId } from "../../platforms/types.js";
import type { VerifiedFact } from "../../services/analysis/schemas.js";

/** PARTIAL: out on at least one platform, still owed to another (retry publishes only what is missing). */
export type DraftStatus = "GENERATING" | "DRAFT" | "NEEDS_REVIEW" | "APPROVED" | "SCHEDULED" | "PUBLISHING" | "PUBLISHED" | "PARTIAL" | "REJECTED" | "FAILED" | "EXPIRED";

/** NEWS — from a source candidate; TOPIC — the owner's own subject; TRADE — a closed Hyperliquid trade; MOVER — a loud market move. */
export type DraftKind = "NEWS" | "TOPIC" | "TRADE" | "MOVER";

export interface DraftRow {
  id: string;
  candidate_id: string | null;
  approved_by_user: boolean;
  kind: DraftKind;
  type: string;
  /** Main text (Threads length). */
  text: string;
  /** Short variant for X; null means "use `text`". */
  text_x: string | null;
  platforms: PlatformId[];
  trade_id: string | null;
  /** Facts for drafts that have no candidate (trades, movers): validation and freshness read them. */
  facts_json: { facts: VerifiedFact[] } | null;
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
  kind?: DraftKind;
  type: string;
  text: string;
  textX?: string | null;
  platforms?: PlatformId[];
  tradeId?: string | null;
  facts?: VerifiedFact[] | null;
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
  imageAssetId?: string | null;
}): Promise<DraftRow> {
  const row = await one<DraftRow>(
    `INSERT INTO drafts (candidate_id, type, text, hook, body, source_summary, source_urls_json, confidence, risk_score, status, review_reason, priority, prompt_version, model, validation_json, variants_json, expires_at,
                         kind, text_x, platforms, trade_id, facts_json, image_asset_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,
             $18,$19,$20::text[],$21,$22::jsonb,$23) RETURNING *`,
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
      input.kind ?? (input.candidateId ? "NEWS" : "TOPIC"),
      input.textX ?? null,
      input.platforms?.length ? input.platforms : ["threads"],
      input.tradeId ?? null,
      input.facts ? JSON.stringify({ facts: input.facts }) : null,
      input.imageAssetId ?? null,
    ],
  );
  if (!row) throw new Error("insert draft returned no row");
  return row;
}

export async function getDraft(id: string): Promise<DraftRow | null> {
  return one<DraftRow>(`SELECT * FROM drafts WHERE id = $1`, [id]);
}

export async function listDrafts(opts: { status?: string | string[]; exclude?: string[]; kind?: string | string[]; platform?: string; limit?: number; before?: string }): Promise<DraftRow[]> {
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
  if (opts.exclude?.length) conds.push(`status <> ALL(${push(opts.exclude)}::text[])`);
  if (opts.kind) {
    const list = Array.isArray(opts.kind) ? opts.kind : opts.kind.split(",");
    conds.push(`kind = ANY(${push(list)}::text[])`);
  }
  if (opts.platform) conds.push(`${push(opts.platform)} = ANY(platforms)`);
  if (opts.before) conds.push(`created_at < ${push(opts.before)}`);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return query<DraftRow>(`SELECT * FROM drafts ${where} ORDER BY created_at DESC LIMIT ${push(Math.min(200, opts.limit ?? 50))}`, params);
}

export async function updateDraft(
  id: string,
  patch: Partial<{
    text: string;
    text_x: string | null;
    platforms: PlatformId[];
    facts_json: { facts: VerifiedFact[] } | null;
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
    approved_by_user: boolean;
    model: string | null;
    prompt_version: string | null;
  }>,
): Promise<DraftRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, v: unknown, cast = "") => {
    params.push(v);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (patch.text !== undefined) add("text", patch.text);
  if (patch.text_x !== undefined) add("text_x", patch.text_x);
  if (patch.platforms !== undefined) add("platforms", patch.platforms, "::text[]");
  if (patch.facts_json !== undefined) add("facts_json", patch.facts_json === null ? null : JSON.stringify(patch.facts_json), "::jsonb");
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
  if (patch.approved_by_user !== undefined) add("approved_by_user", patch.approved_by_user);
  if (patch.model !== undefined) add("model", patch.model);
  if (patch.prompt_version !== undefined) add("prompt_version", patch.prompt_version);
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
    `SELECT text FROM (SELECT DISTINCT ON (COALESCE(draft_id::text, id::text)) published_text AS text, published_at FROM publications ORDER BY COALESCE(draft_id::text, id::text), published_at DESC) t ORDER BY published_at DESC LIMIT $1`,
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

/** Dead end for a draft: it will never be published, so it lives in the archive tab and can be thrown away. */
export const ARCHIVED_STATUSES: DraftStatus[] = ["EXPIRED", "REJECTED"];

async function deleteDrafts(statuses: DraftStatus[], olderThanDays: number | null): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `DELETE FROM drafts d
      WHERE d.status = ANY($1::text[])
        AND ($2::int IS NULL OR d.updated_at < now() - make_interval(days => $2::int))
        AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.draft_id = d.id)
      RETURNING d.id`,
    [statuses, olderThanDays],
  );
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    // Trades and market moves remember their draft without a foreign key, so the dead link is cleared by hand.
    await query(`UPDATE market_moves SET draft_id = NULL, status = 'SKIPPED', reason = COALESCE(reason, 'черновик удалён') WHERE draft_id = ANY($1::uuid[])`, [ids]);
    await query(`UPDATE hl_trades SET draft_id = NULL, post_status = 'SKIPPED', skip_reason = COALESCE(skip_reason, 'черновик удалён'), updated_at = now() WHERE draft_id = ANY($1::uuid[])`, [ids]);
  }
  return ids;
}

/** "Очистить" in the archive: expired and rejected drafts that never reached a platform. Published posts stay. */
export async function deleteArchivedDrafts(): Promise<string[]> {
  return deleteDrafts(ARCHIVED_STATUSES, null);
}

/** Housekeeping: an expired draft nobody came back to within a month is dropped for good. */
export async function purgeOldExpiredDrafts(olderThanDays = 30): Promise<string[]> {
  return deleteDrafts(["EXPIRED"], olderThanDays);
}
