import { registerHandler } from "../index.js";
import { publishDraft, publisherTick } from "../../services/publishing/pipeline.js";
import { expireCandidates } from "../../db/repos/candidates.js";
import { expireDrafts } from "../../db/repos/drafts.js";
import { audit } from "../../services/audit.js";
import { pruneHistory } from "../../db/repos/retention.js";
import { loadSettings } from "../../config/settings.js";

registerHandler("publisher", "publisher:tick", async () => publisherTick());

registerHandler("publisher", "publisher:publish", async (job) => {
  const { draftId, manual } = job.data as { draftId: string; manual?: boolean };
  return publishDraft(draftId, { manual: manual === true });
});

registerHandler("publisher", "publisher:expire", async () => {
  const drafts = await expireDrafts();
  for (const id of drafts) await audit("POST_EXPIRED", "Черновик просрочен и не будет опубликован", { draftId: id });
  const candidates = await expireCandidates();
  return { drafts: drafts.length, candidates };
});

/**
 * Housekeeping, once a day. Job records, the audit trail and the LLM ledger are written on every tick and
 * never removed, so they are aged out here in batches. Insight snapshots keep the newest row per post.
 */
registerHandler("publisher", "publisher:retention", async (_job, { log }) => {
  const s = await loadSettings();
  const results = await pruneHistory({
    jobs: s.retention.jobDays,
    audit: s.retention.auditDays,
    llmCalls: s.retention.llmCallDays,
    insights: s.analytics.snapshotDays,
  });
  const removed: Record<string, number> = {};
  for (const r of results) if (r.removed > 0) removed[r.table] = r.removed;
  const total = results.reduce((n, r) => n + r.removed, 0);
  const truncated = results.filter((r) => r.truncated).map((r) => r.table);
  // Quiet by design: a run that found nothing to delete says nothing at all.
  if (total > 0) log.info({ removed, total }, "retention sweep");
  if (truncated.length) log.warn({ truncated }, "retention sweep hit its per-run limit, the rest goes tomorrow");
  return { removed, total, truncated };
});
