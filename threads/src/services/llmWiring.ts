import { llm } from "../llm/index.js";
import { cachedSettings } from "../config/settings.js";
import { query } from "../db/pool.js";

/** Connect the LLM router to runtime settings (models, pricing) and the llm_calls ledger. */
export function wireLlm(): void {
  const router = llm();
  router.setModelsSource(() => cachedSettings().models);
  router.setPricingSource(() => cachedSettings().pricing);
  router.setLedger(async (rec) => {
    await query(
      `INSERT INTO llm_calls (provider, model, operation, input_tokens, output_tokens, estimated_cost, duration_ms, ok, error, candidate_id, draft_id, interaction_id, media_asset_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        rec.provider,
        rec.model,
        rec.operation,
        rec.inputTokens,
        rec.outputTokens,
        rec.estimatedCost,
        rec.durationMs,
        rec.ok,
        rec.error ? rec.error.slice(0, 2000) : null,
        rec.refs?.candidateId ?? null,
        rec.refs?.draftId ?? null,
        rec.refs?.interactionId ?? null,
        rec.refs?.mediaAssetId ?? null,
      ],
    );
  });
}
