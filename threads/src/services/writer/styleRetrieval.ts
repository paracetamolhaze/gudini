import { tokens } from "../dedup/hash.js";

/**
 * Pick the few style examples most relevant to the topic instead of pasting the whole voice
 * library into every prompt. Lexical overlap + rating; embeddings can replace the scorer later.
 */
export interface StyleExample {
  id: string;
  text: string;
  rating: number;
  tags: string[];
  enabled: boolean;
}

export function rankStyleExamples(examples: StyleExample[], context: { topic: string; category: string; summary: string }, limit: number): StyleExample[] {
  if (limit <= 0) return [];
  const ctxTokens = new Set([...tokens(`${context.topic} ${context.summary}`), context.category.toLowerCase()]);
  const scored = examples
    .filter((e) => e.enabled && e.text.trim().length > 0)
    .map((e) => {
      const et = tokens(e.text);
      let overlap = 0;
      for (const w of et) if (ctxTokens.has(w)) overlap++;
      const tagHit = e.tags.some((t) => t.toLowerCase() === context.category.toLowerCase()) ? 1 : 0;
      const score = (overlap / Math.max(6, et.length)) * 2 + tagHit + (e.rating - 3) * 0.25 + Math.random() * 0.05;
      return { e, score };
    })
    .sort((a, b) => b.score - a.score);
  // Keep variety: never more than half from identical length bucket.
  const out: StyleExample[] = [];
  for (const s of scored) {
    if (out.length >= limit) break;
    out.push(s.e);
  }
  return out;
}
