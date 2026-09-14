/**
 * Event clustering: several authors, one event → one candidate. Deterministic and storage-agnostic
 * so the rule ("same eventKey, or same category + strong entity overlap within the window") can be
 * unit-tested without Postgres.
 */
export interface ClusterLike {
  id: string;
  eventKey: string | null;
  entities: string[];
  category: string | null;
  lastSeenAt: Date;
  sourcePostIds: string[];
}

export interface ClusterMatchInput {
  eventKey: string;
  entities: string[];
  category: string;
  now?: Date;
  windowHours?: number;
  /** Entity Jaccard needed when event keys differ (default 0.5). */
  entityThreshold?: number;
}

export function normalizeEventKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function normalizeEntity(e: string): string {
  return e
    .toLowerCase()
    .replace(/^\$/, "")
    .replace(/[^a-z0-9а-яё]+/gi, " ")
    .trim();
}

export function entityJaccard(a: string[], b: string[]): number {
  const A = new Set(a.map(normalizeEntity).filter(Boolean));
  const B = new Set(b.map(normalizeEntity).filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Strip a trailing date from an event key so "btc-etf-inflows-2026-09-13" and "-2026-09-12" still compare on the stem. */
function stem(key: string): string {
  return key.replace(/-?\d{4}-\d{2}-\d{2}$/, "").replace(/-?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*-?\d{0,4}$/, "");
}

export function findMatchingCluster<T extends ClusterLike>(input: ClusterMatchInput, clusters: T[]): { cluster: T; reason: string; score: number } | null {
  const now = input.now ?? new Date();
  const windowMs = (input.windowHours ?? 48) * 3_600_000;
  const key = normalizeEventKey(input.eventKey);
  const threshold = input.entityThreshold ?? 0.5;
  let best: { cluster: T; reason: string; score: number } | null = null;
  for (const c of clusters) {
    if (now.getTime() - c.lastSeenAt.getTime() > windowMs) continue;
    const ck = c.eventKey ? normalizeEventKey(c.eventKey) : "";
    if (ck && ck === key) return { cluster: c, reason: `same eventKey ${key}`, score: 1 };
    const overlap = entityJaccard(input.entities, c.entities);
    const sameCategory = !c.category || c.category === input.category;
    const stemMatch = ck && stem(ck) === stem(key) && stem(key).length >= 6;
    if (stemMatch && overlap >= 0.25) {
      const score = 0.85 + overlap * 0.1;
      if (!best || score > best.score) best = { cluster: c, reason: `eventKey stem ${stem(key)} + entities ${Math.round(overlap * 100)}%`, score };
      continue;
    }
    if (sameCategory && overlap >= threshold) {
      const score = 0.5 + overlap * 0.4;
      if (!best || score > best.score) best = { cluster: c, reason: `category ${input.category} + entities ${Math.round(overlap * 100)}%`, score };
    }
  }
  return best;
}
