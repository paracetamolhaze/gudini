/**
 * Publication cadence. Breaking (P0) items skip the preferred-hours window and the minimum gap,
 * but never the hard daily cap. Everything is computed in the account's timezone.
 */
export interface SlotInput {
  now: Date;
  lastPublishedAt: Date | null;
  postsToday: number;
  maxPostsPerDay: number;
  minimumMinutesBetweenPosts: number;
  preferredHours: number[];
  timezone: string;
  priority: "P0" | "P1" | "P2" | "P3";
}

export type SlotDecision = { kind: "now" } | { kind: "at"; at: Date; reason: string } | { kind: "blocked"; reason: string };

export function hourInZone(date: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    return h === 24 ? 0 : h;
  } catch {
    return date.getUTCHours();
  }
}

/** Start of the next hour `targetHour` in the timezone, strictly after `from`. */
export function nextHourInZone(from: Date, targetHour: number, timezone: string): Date {
  // Walk forward hour by hour (max 48 steps) — simple and DST-proof.
  const t = new Date(from);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 1; i <= 48; i++) {
    const cand = new Date(t.getTime() + i * 3_600_000);
    if (hourInZone(cand, timezone) === targetHour && cand > from) return cand;
  }
  return new Date(from.getTime() + 24 * 3_600_000);
}

export function decideSlot(input: SlotInput): SlotDecision {
  if (input.postsToday >= input.maxPostsPerDay) return { kind: "blocked", reason: `дневной лимит постов ${input.postsToday}/${input.maxPostsPerDay}` };
  const breaking = input.priority === "P0";
  const gapMs = input.minimumMinutesBetweenPosts * 60_000;
  if (!breaking && input.lastPublishedAt && input.now.getTime() - input.lastPublishedAt.getTime() < gapMs) {
    const at = new Date(input.lastPublishedAt.getTime() + gapMs);
    return { kind: "at", at, reason: `минимум ${input.minimumMinutesBetweenPosts} мин между постами` };
  }
  const hours = input.preferredHours.length ? [...new Set(input.preferredHours)].sort((a, b) => a - b) : null;
  if (!breaking && hours) {
    const h = hourInZone(input.now, input.timezone);
    if (!hours.includes(h)) {
      const next = hours.find((x) => x > h) ?? hours[0]!;
      const at = nextHourInZone(input.now, next, input.timezone);
      return { kind: "at", at, reason: `вне предпочтительных часов (${h}:00 ${input.timezone})` };
    }
  }
  return { kind: "now" };
}
