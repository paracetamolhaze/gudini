import { one } from "../db/pool.js";
import type { Settings } from "../config/settings.js";
import { postsPublishedLast24h } from "../db/repos/publishing.js";

/** Hard caps computed from what was actually sent (publications / interactions), never from counters that can drift. */
export interface LimitCheck {
  allowed: boolean;
  reason: string;
  used: number;
  cap: number;
}

export async function ownRepliesLimit(settings: Settings): Promise<LimitCheck> {
  const hour = await one<{ n: number }>(`SELECT count(*)::int AS n FROM interactions WHERE status = 'SENT' AND type <> 'PUBLIC_POST_REPLY' AND sent_at >= now() - interval '1 hour'`);
  const day = await one<{ n: number }>(`SELECT count(*)::int AS n FROM interactions WHERE status = 'SENT' AND type <> 'PUBLIC_POST_REPLY' AND sent_at >= now() - interval '24 hours'`);
  const h = hour?.n ?? 0;
  const d = day?.n ?? 0;
  if (h >= settings.limits.maxOwnRepliesPerHour) return { allowed: false, reason: `лимит ответов в час ${h}/${settings.limits.maxOwnRepliesPerHour}`, used: h, cap: settings.limits.maxOwnRepliesPerHour };
  if (d >= settings.limits.maxOwnRepliesPerDay) return { allowed: false, reason: `лимит ответов в сутки ${d}/${settings.limits.maxOwnRepliesPerDay}`, used: d, cap: settings.limits.maxOwnRepliesPerDay };
  return { allowed: true, reason: "", used: d, cap: settings.limits.maxOwnRepliesPerDay };
}

export async function publicRepliesLimit(settings: Settings): Promise<LimitCheck> {
  const hour = await one<{ n: number }>(`SELECT count(*)::int AS n FROM interactions WHERE status = 'SENT' AND type = 'PUBLIC_POST_REPLY' AND sent_at >= now() - interval '1 hour'`);
  const day = await one<{ n: number }>(`SELECT count(*)::int AS n FROM interactions WHERE status = 'SENT' AND type = 'PUBLIC_POST_REPLY' AND sent_at >= now() - interval '24 hours'`);
  const h = hour?.n ?? 0;
  const d = day?.n ?? 0;
  if (h >= settings.limits.maxPublicRepliesPerHour) return { allowed: false, reason: `лимит публичных ответов в час ${h}/${settings.limits.maxPublicRepliesPerHour}`, used: h, cap: settings.limits.maxPublicRepliesPerHour };
  if (d >= settings.limits.maxPublicRepliesPerDay) return { allowed: false, reason: `лимит публичных ответов в сутки ${d}/${settings.limits.maxPublicRepliesPerDay}`, used: d, cap: settings.limits.maxPublicRepliesPerDay };
  return { allowed: true, reason: "", used: d, cap: settings.limits.maxPublicRepliesPerDay };
}

export async function postsLimit(settings: Settings): Promise<LimitCheck> {
  // A post that went to both platforms counts once.
  const d = await postsPublishedLast24h();
  const cap = Math.min(settings.limits.maxPostsPerDay, settings.schedule.maximumPostsPerDay);
  if (d >= cap) return { allowed: false, reason: `лимит постов за 24 часа ${d}/${cap}`, used: d, cap };
  return { allowed: true, reason: "", used: d, cap };
}
