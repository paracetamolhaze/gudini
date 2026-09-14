import { query } from "../db/pool.js";
import { logger, scrubSecrets } from "../shared/logger.js";

/**
 * Audit log: every decision the AI or the system makes, with the reason, so the dashboard can
 * answer "why did it do that". Written to Postgres and echoed to structured logs.
 */
export const AUDIT_EVENTS = [
  "SOURCE_CHECKED",
  "SOURCE_ERROR",
  "SOURCE_DISCOVERED",
  "SOURCE_DUPLICATE",
  "SOURCE_REJECTED",
  "EVENT_CLUSTERED",
  "CANDIDATE_ANALYZED",
  "CANDIDATE_REJECTED",
  "CANDIDATE_APPROVED",
  "CANDIDATE_EXPIRED",
  "FACT_CHECKED",
  "FACT_CHECK_FAILED",
  "POST_GENERATED",
  "POST_VALIDATION_FAILED",
  "POST_NEEDS_REVIEW",
  "POST_APPROVED",
  "POST_SCHEDULED",
  "POST_PUBLISHED",
  "POST_PUBLISH_FAILED",
  "POST_REJECTED",
  "POST_EXPIRED",
  "POST_REGENERATED",
  "FRESHNESS_RECHECK",
  "IMAGE_DOWNLOADED",
  "IMAGE_TRANSLATED",
  "IMAGE_QA_FAILED",
  "IMAGE_FAILED",
  "REPLY_FOUND",
  "REPLY_SKIPPED",
  "REPLY_GENERATED",
  "REPLY_NEEDS_REVIEW",
  "REPLY_PUBLISHED",
  "REPLY_FAILED",
  "ENGAGEMENT_FOUND",
  "ENGAGEMENT_SKIPPED",
  "ENGAGEMENT_GENERATED",
  "ENGAGEMENT_PUBLISHED",
  "LIMIT_REACHED",
  "KILL_SWITCH",
  "MODE_CHANGED",
  "SETTINGS_CHANGED",
  "DRY_RUN",
  "INSIGHTS_CAPTURED",
  "RECOMMENDATION",
  "PROMPT_ACTIVATED",
  "TOKEN_REFRESHED",
  "JOB_FAILED",
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export type AuditLevel = "info" | "warn" | "error";

export interface AuditRefs {
  sourceId?: string | null;
  sourcePostId?: string | null;
  candidateId?: string | null;
  draftId?: string | null;
  interactionId?: string | null;
  publicationId?: string | null;
  mediaAssetId?: string | null;
  jobId?: string | null;
}

export async function audit(
  event: AuditEvent,
  message: string,
  refs: AuditRefs = {},
  details: Record<string, unknown> | null = null,
  level: AuditLevel = "info",
): Promise<void> {
  const clean = scrubSecrets(message).slice(0, 4000);
  logger()[level]({ event, ...refs, details }, clean);
  try {
    await query(
      `INSERT INTO audit_logs (event, level, message, details, source_id, source_post_id, candidate_id, draft_id, interaction_id, publication_id, media_asset_id, job_id)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        event,
        level,
        clean,
        details ? JSON.stringify(details) : null,
        refs.sourceId ?? null,
        refs.sourcePostId ?? null,
        refs.candidateId ?? null,
        refs.draftId ?? null,
        refs.interactionId ?? null,
        refs.publicationId ?? null,
        refs.mediaAssetId ?? null,
        refs.jobId ?? null,
      ],
    );
  } catch (err) {
    logger().error({ err, event }, "audit write failed");
  }
}
