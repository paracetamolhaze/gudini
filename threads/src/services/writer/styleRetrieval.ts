import { tokens } from "../dedup/hash.js";

/**
 * Pick the few style examples most relevant to the topic instead of pasting the whole voice
 * library into every prompt. Lexical overlap + rating; embeddings can replace the scorer later.
 *
 * Relevance alone is not enough. Anthropic's guidance asks for examples that are relevant AND
 * diverse, because a set that looks the same teaches the model that sameness — which is exactly
 * the failure we already had to patch elsewhere, when every post started ending the same way.
 * So each pick after the first is penalised for resembling what is already chosen.
 */
export interface StyleExample {
  id: string;
  text: string;
  rating: number;
  tags: string[];
  enabled: boolean;
}

/** Share of the shorter text's words that both texts have. 0 = nothing in common, 1 = the same words. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

/** Short, medium, long — three examples of one length teach one rhythm. */
const lengthBucket = (text: string): number => (text.length < 220 ? 0 : text.length < 600 ? 1 : 2);

export function rankStyleExamples(examples: StyleExample[], context: { topic: string; category: string; summary: string }, limit: number): StyleExample[] {
  if (limit <= 0) return [];
  const ctxTokens = new Set([...tokens(`${context.topic} ${context.summary}`), context.category.toLowerCase()]);
  const scored = examples
    .filter((e) => e.enabled && e.text.trim().length > 0)
    .map((e) => {
      const words = new Set(tokens(e.text));
      let overlap = 0;
      for (const w of words) if (ctxTokens.has(w)) overlap++;
      const tagHit = e.tags.some((t) => t.toLowerCase() === context.category.toLowerCase()) ? 1 : 0;
      const score = (overlap / Math.max(6, words.size)) * 2 + tagHit + (e.rating - 3) * 0.25 + Math.random() * 0.05;
      return { e, words, score };
    })
    .sort((a, b) => b.score - a.score);

  const out: StyleExample[] = [];
  const takenWords: Array<Set<string>> = [];
  const takenBuckets: number[] = [];
  const pool = [...scored];
  while (out.length < limit && pool.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      const closest = takenWords.reduce((max, w) => Math.max(max, similarity(c.words, w)), 0);
      const bucket = lengthBucket(c.e.text);
      const crowded = takenBuckets.filter((b) => b === bucket).length;
      // Relevance pulls up, resemblance to what is already chosen pulls down.
      const adjusted = c.score - closest * 1.5 - crowded * 0.3;
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestIndex = i;
      }
    }
    const [picked] = pool.splice(bestIndex, 1);
    if (!picked) break;
    out.push(picked.e);
    takenWords.push(picked.words);
    takenBuckets.push(lengthBucket(picked.e.text));
  }
  return out;
}
