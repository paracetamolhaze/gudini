import { registerHandler } from "../index.js";
import { pollReplies, processInteraction, sendInteraction, sendWaitingReplies } from "../../services/replies/pipeline.js";
import { pollEngagement } from "../../services/engagement/pipeline.js";

registerHandler("replies", "replies:poll", async () => { await sendWaitingReplies(); return pollReplies(); });
registerHandler("replies", "replies:process", async (job) => processInteraction((job.data as { interactionId: string }).interactionId));
registerHandler("replies", "replies:send", async (job) => {
  const { interactionId, manual } = job.data as { interactionId: string; manual?: boolean };
  return sendInteraction(interactionId, { manual: manual === true });
});
registerHandler("engagement", "engagement:poll", async (job) => pollEngagement({ force: (job.data as { force?: boolean } | undefined)?.force === true }));
