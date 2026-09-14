import { registerHandler } from "../index.js";
import { translateImageForDraft } from "../../services/images/pipeline.js";
import { query } from "../../db/pool.js";
import { enqueue } from "../../queue/queues.js";

registerHandler("media", "media:translate", async (job) => {
  const { draftId, sourcePostId } = job.data as { draftId: string; sourcePostId: string };
  return translateImageForDraft(draftId, sourcePostId);
});

/** Re-run assets that are allowed another attempt (RENDERED after a failed QA within the retry budget). */
registerHandler("media", "media:sweep", async () => {
  const rows = await query<{ id: string; draft_id: string; source_post_id: string }>(
    `SELECT id, draft_id, source_post_id FROM media_assets WHERE status = 'RENDERED' AND draft_id IS NOT NULL AND source_post_id IS NOT NULL AND updated_at < now() - interval '2 minutes' LIMIT 5`,
  );
  for (const r of rows) await enqueue("media", "media:translate", { draftId: r.draft_id, sourcePostId: r.source_post_id }, { jobId: `media-${r.draft_id}-retry-${Date.now()}` });
  return { requeued: rows.length };
});
