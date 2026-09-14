/**
 * Cost estimation per model (USD per 1M tokens). Provider-reported cost (OpenRouter) wins;
 * otherwise the first pricing entry whose key is a substring of the model id is used.
 * Unknown models are recorded with tokens and a null cost, never a made-up number.
 */
export type PricingTable = Record<string, { input: number; output: number }>;

export const DEFAULT_PRICING: PricingTable = {
  "claude-fable-5-1": { input: 15, output: 75 },
  "claude-opus-5": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5": { input: 1.25, output: 10 },
  "gemini-3.5-flash": { input: 0.3, output: 2.5 },
  "gemini-3.1-flash": { input: 0.3, output: 2.5 },
  "gemini-3-pro": { input: 2, output: 12 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
};

export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; costUsd?: number },
  pricing: PricingTable = DEFAULT_PRICING,
): number | null {
  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd)) return usage.costUsd;
  const id = model.toLowerCase();
  const key = Object.keys(pricing)
    .filter((k) => id.includes(k.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  const p = pricing[key]!;
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
}
