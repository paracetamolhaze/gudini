import { registerHandler } from "../index.js";
import { generateDraftForCandidate } from "../../services/writer/pipeline.js";
import { query } from "../../db/pool.js";
import { enqueue, PRIORITY } from "../../queue/queues.js";
import { expireDrafts } from "../../db/repos/drafts.js";
import { audit } from "../../services/audit.js";
import { writeTopic } from "../../services/writer/topic.js";

registerHandler("content", "content:topic", async job => writeTopic((job.data as { draftId: string }).draftId));

registerHandler("content", "content:generate", async (job) => {
  const { candidateId, force } = job.data as { candidateId: string; force?: boolean };
  return generateDraftForCandidate(candidateId, { force: force === true });
});

/** Safety net: approved candidates that never got a draft, plus expiring drafts. */
registerHandler("content", "content:sweep", async () => {
  const stuck = await query<{ id: string; priority: "P0" | "P1" | "P2" | "P3" }>(
    `SELECT c.id, c.priority FROM content_candidates c
     WHERE c.status IN ('APPROVED_FOR_GENERATION') AND c.updated_at < now() - interval '5 minutes'
       AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.candidate_id = c.id AND d.status NOT IN ('REJECTED','FAILED','EXPIRED'))
     ORDER BY c.priority ASC, c.created_at ASC LIMIT 10`,
  );
  for (const c of stuck) await enqueue("content", "content:generate", { candidateId: c.id }, { priority: PRIORITY[c.priority], jobId: `generate-${c.id}` });
  const expired = await expireDrafts();
  for (const id of expired) await audit("POST_EXPIRED", "Черновик просрочен и не будет опубликован", { draftId: id });
  return { requeued: stuck.length, expired: expired.length };
});
