import { createHash } from "node:crypto";
import { canonicalText } from "../sources/normalize.js";

/** Exact-duplicate key: sha256 over the canonical text (case, URLs, handles and punctuation removed). */
export function contentHash(text: string): string {
  return createHash("sha256").update(canonicalText(text)).digest("hex");
}

const STOP = new Set(
  "the a an and or of to in on for with is are was were be been by at as it its this that these those from into over about after before than then there here not no but if so we you they he she his her our your their what which who how why when where will would can could should may might just very more most also into via up out new".split(" "),
);

export function tokens(text: string): string[] {
  return canonicalText(text)
    .split(/[\s.,]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export function wordShingles(text: string, n = 3): Set<string> {
  const t = tokens(text);
  const out = new Set<string>();
  if (t.length < n) {
    if (t.length) out.add(t.join(" "));
    return out;
  }
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(" "));
  return out;
}

/** 64-bit simhash over unigram + bigram features, hex encoded. Near-duplicates have small Hamming distance. */
export function simhash(text: string): string {
  const t = tokens(text);
  const features: string[] = [...t];
  for (let i = 0; i + 1 < t.length; i++) features.push(`${t[i]} ${t[i + 1]}`);
  const v = new Array<number>(64).fill(0);
  for (const f of features) {
    const h = createHash("md5").update(f).digest();
    for (let bit = 0; bit < 64; bit++) {
      const byte = h[bit >> 3]!;
      const on = (byte >> (bit & 7)) & 1;
      v[bit] = v[bit]! + (on ? 1 : -1);
    }
  }
  let hi = 0;
  let lo = 0;
  for (let bit = 0; bit < 64; bit++) {
    if (v[bit]! > 0) {
      if (bit < 32) lo |= 1 << bit;
      else hi |= 1 << (bit - 32);
    }
  }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) return 64;
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) {
      d += x & 1;
      x >>>= 1;
    }
  }
  return d;
}
