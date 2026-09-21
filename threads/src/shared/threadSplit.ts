/**
 * Split long post text into Threads-sized parts with 1/n … n/n labels.
 * Adapted from eisenjimmy/autoTHREADS (MIT) — see THIRD_PARTY_NOTICES.md.
 */

export const THREADS_MAX_CHARS = 500;
export const THREADS_MAX_PARTS = 5;
export const THREADS_MAX_THREAD_CHARS = THREADS_MAX_CHARS * THREADS_MAX_PARTS;

const LABEL = (i: number, n: number) => `${i}/${n} `;

/** `maxChars` is the platform limit of one post (Threads 500, X 280 without Premium). */
export function splitIntoThreadParts(text: string, maxChars: number = THREADS_MAX_CHARS): string[] {
  const raw = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!raw) return [];
  if (raw.length <= maxChars) return [raw];

  const labelReserve = 6;
  const bodyBudget = maxChars - labelReserve;
  let n = Math.min(THREADS_MAX_PARTS, Math.max(2, Math.ceil(raw.length / bodyBudget)));

  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = packParts(raw, n, bodyBudget);
    if (parts && parts.every((p) => p.length <= maxChars)) return parts;
    n = Math.min(THREADS_MAX_PARTS, n + 1);
  }
  return hardSlice(raw, Math.min(THREADS_MAX_PARTS, n), bodyBudget);
}

function packParts(raw: string, n: number, bodyBudget: number): string[] | null {
  const chunks: string[] = [];
  let rest = raw;
  for (let i = 1; i <= n; i++) {
    const isLast = i === n;
    if (!rest) break;
    if (isLast) {
      let body = rest.trim();
      if (body.length > bodyBudget) {
        body = body.slice(0, bodyBudget - 1).replace(/\s+\S*$/, "").trimEnd() + "…";
      }
      chunks.push(LABEL(i, n) + body);
      rest = "";
      break;
    }
    const remainingParts = n - i + 1;
    const ideal = Math.min(bodyBudget, Math.ceil(rest.length / remainingParts));
    const take = takeChunk(rest, Math.min(bodyBudget, Math.max(ideal, Math.floor(bodyBudget * 0.55))));
    if (!take) return null;
    chunks.push(LABEL(i, n) + take.chunk);
    rest = take.rest;
  }
  if (rest.trim()) return null;
  return chunks;
}

function takeChunk(text: string, maxBody: number): { chunk: string; rest: string } | null {
  if (text.length <= maxBody) return { chunk: text.trim(), rest: "" };
  const window = text.slice(0, maxBody);
  let cut = window.lastIndexOf("\n\n");
  if (cut >= Math.floor(maxBody * 0.4)) return { chunk: text.slice(0, cut).trim(), rest: text.slice(cut).trim() };
  cut = window.lastIndexOf("\n");
  if (cut >= Math.floor(maxBody * 0.45)) return { chunk: text.slice(0, cut).trim(), rest: text.slice(cut).trim() };
  const sentence = window.match(/^[\s\S]*?[.!?…](?:\s|$)/);
  if (sentence && sentence[0].length >= Math.floor(maxBody * 0.4)) {
    const len = sentence[0].trimEnd().length;
    return { chunk: text.slice(0, len).trim(), rest: text.slice(len).trim() };
  }
  cut = window.lastIndexOf(" ");
  if (cut >= Math.floor(maxBody * 0.35)) return { chunk: text.slice(0, cut).trim(), rest: text.slice(cut).trim() };
  return { chunk: window.trim(), rest: text.slice(maxBody).trim() };
}

function hardSlice(raw: string, n: number, bodyBudget: number): string[] {
  const out: string[] = [];
  let rest = raw;
  for (let i = 1; i <= n; i++) {
    const isLast = i === n;
    if (!rest) break;
    if (isLast || rest.length <= bodyBudget) {
      let body = rest.trim();
      if (body.length > bodyBudget) body = body.slice(0, bodyBudget - 1) + "…";
      out.push(LABEL(i, n) + body);
      break;
    }
    const { chunk, rest: next } = takeChunk(rest, bodyBudget)!;
    out.push(LABEL(i, n) + chunk);
    rest = next;
  }
  return out;
}

export function needsThreadSplit(text: string): boolean {
  return text.trim().length > THREADS_MAX_CHARS;
}
