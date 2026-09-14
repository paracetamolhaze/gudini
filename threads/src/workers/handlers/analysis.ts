import { registerHandler } from "../index.js";
import { analyzeSourcePostById } from "../../services/analysis/pipeline.js";
import { pendingSourcePosts } from "../../db/repos/sourcePosts.js";
import { enqueue } from "../../queue/queues.js";
import { expireCandidates } from "../../db/repos/candidates.js";
import { audit } from "../../services/audit.js";

registerHandler("analysis", "analysis:analyze", async (job) => {
  const { sourcePostId } = job.data as { sourcePostId: string };
  return analyzeSourcePostById(sourcePostId);
});

/** Safety net: posts that never got an analyze job (crash between insert and enqueue) are picked up here. */
registerHandler("analysis", "analysis:sweep", async () => {
  const pending = await pendingSourcePosts(20);
  for (const p of pending) await enqueue("analysis", "analysis:analyze", { sourcePostId: p.id }, { jobId: `analyze-${p.id}` });
  const expired = await expireCandidates();
  if (expired > 0) await audit("CANDIDATE_EXPIRED", `Просрочено кандидатов: ${expired}`, {}, { expired });
  return { queued: pending.length, expired };
});
