import { registerHandler } from "../index.js";
import { publishDraft, publisherTick } from "../../services/publishing/pipeline.js";
import { expireCandidates } from "../../db/repos/candidates.js";
import { expireDrafts } from "../../db/repos/drafts.js";
import { audit } from "../../services/audit.js";

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
