import { registerHandler } from "../index.js";
import { createTradeDraft, syncTrades } from "../../services/trades/pipeline.js";
import { createMoverDraft, scanMovers } from "../../services/market/movers.js";

registerHandler("trades", "trades:sync", async () => syncTrades());
registerHandler("trades", "trades:draft", async (job) => {
  const { tradeId, manual } = job.data as { tradeId: string; manual?: boolean };
  return createTradeDraft(tradeId, { manual: manual === true });
});
registerHandler("market", "market:scan", async () => scanMovers());
registerHandler("market", "market:draft", async (job) => createMoverDraft((job.data as { moveId: string }).moveId));
