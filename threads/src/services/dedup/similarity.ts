import { wordShingles, tokens } from "./hash.js";

/** Jaccard similarity of 3-word shingles: 1 = identical wording, ~0 = unrelated. */
export function shingleSimilarity(a: string, b: string): number {
  const A = wordShingles(a);
  const B = wordShingles(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const s of A) if (B.has(s)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Word-overlap similarity (autoTHREADS `postsTooSimilar`, MIT): share of the smaller vocabulary
 * found in the other text. Catches paraphrases that shingles miss.
 */
export function wordOverlap(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size < 3 || B.size < 3) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Combined text similarity in [0,1] used when no embedding model is configured:
 * max of shingle Jaccard (exact reuse) and a damped word overlap (paraphrase).
 */
export function textSimilarity(a: string, b: string): number {
  return Math.max(shingleSimilarity(a, b), wordOverlap(a, b) * 0.85);
}
