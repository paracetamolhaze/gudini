import { registerHandler } from "../index.js";
import { pollDueSources, checkSourceById } from "../../services/sources/sourceManager.js";

registerHandler("source", "source:poll", async () => {
  const results = await pollDueSources();
  return { checked: results.length, inserted: results.reduce((s, r) => s + r.inserted, 0), errors: results.filter((r) => r.status !== "OK").length };
});

registerHandler("source", "source:check", async (job) => {
  const { sourceId, force } = job.data as { sourceId: string; force?: boolean };
  return checkSourceById(sourceId, force === true);
});
