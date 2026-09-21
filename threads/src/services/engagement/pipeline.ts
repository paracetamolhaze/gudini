import { loadSettings, type Settings } from "../../config/settings.js";
import { one, query } from "../../db/pool.js";
import { insertInteraction, updateInteraction, type InteractionDelivery } from "../../db/repos/interactions.js";
import { activePlatforms, type FoundPost, type PlatformAdapter } from "../../platforms/index.js";
import { audit } from "../audit.js";
import { errorMessage } from "../../shared/logger.js";
import { getActivePrompt } from "../promptVersions.js";
import { personaBlock } from "../persona.js";
import { REPLY_PROMPT_NAME, REPLY_SYSTEM_PROMPT } from "../replies/prompts.js";
import { replyLanguageFor, writeReply } from "../replies/writer.js";
import { ownUsername, sendInteraction } from "../replies/pipeline.js";
import { publicRepliesLimit } from "../limits.js";
import { scorePosts, type DiscoveredPost } from "./scoring.js";

/**
 * Public engagement: find other people's posts → score → say something of substance.
 *   Threads — keyword search, replies through the API (hard caps enforced at send time).
 *   X       — the API refuses cold replies, so a found post becomes either a prepared reply the owner
 *             posts by hand (manual) or a quote post (quote). Every found post is billed, so X is
 *             searched a few times a day within the read budget, not on every tick.
 */
async function cursor<T>(key: string): Promise<T | null> {
  const row = await one<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  return row?.value ?? null;
}

async function setCursor(key: string, value: unknown): Promise<void> {
  await query(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
}

/** Threads rotates three keywords per tick; X runs one owner-defined query a few times a day. */
async function keywordsFor(adapter: PlatformAdapter, settings: Settings, force: boolean): Promise<string[] | null> {
  if (adapter.id === "x") {
    if (settings.platforms.x.engagementMode === "off") return null;
    // Half of the read budget is kept for comments under own posts; each search returns at least 10 posts.
    const searchesPerDay = Math.max(1, Math.floor(settings.platforms.x.dailyReadBudget / 20));
    const minGapMs = Math.max(3_600_000, Math.floor(86_400_000 / searchesPerDay));
    const last = await cursor<{ at?: number }>("x_search_cursor");
    if (!force && last?.at && Date.now() - last.at < minGapMs) return null;
    await setCursor("x_search_cursor", { at: Date.now() });
    return ["x:search"];
  }
  const keywords = settings.engagement.watchKeywords.map((k) => k.trim()).filter(Boolean);
  if (!keywords.length) return null;
  const start = (await cursor<{ i?: number }>("engagement_cursor"))?.i ?? 0;
  const pick = [0, 1, 2].map((n) => keywords[(start + n) % keywords.length]!).filter((v, i, a) => a.indexOf(v) === i);
  await setCursor("engagement_cursor", { i: (start + pick.length) % keywords.length });
  return pick;
}

function deliveryFor(adapter: PlatformAdapter, settings: Settings): InteractionDelivery {
  if (adapter.publicReplyChannel() === "api") return "api";
  return settings.platforms.x.engagementMode === "quote" ? "quote" : "manual";
}

export async function pollEngagement(opts: { force?: boolean } = {}): Promise<{ discovered: number; queued: number; sent: number; error: string | null }> {
  const settings = await loadSettings(true);
  const total = { discovered: 0, queued: 0, sent: 0, error: null as string | null };
  if (settings.mode === "OFF" || settings.killSwitch) return total;
  const errors: string[] = [];
  for (const adapter of activePlatforms(settings)) {
    const r = await pollPlatform(adapter, settings, opts.force === true).catch((err) => ({ discovered: 0, queued: 0, sent: 0, error: `${adapter.label}: ${errorMessage(err)}` }));
    total.discovered += r.discovered;
    total.queued += r.queued;
    total.sent += r.sent;
    if (r.error) errors.push(r.error);
  }
  total.error = errors.length ? errors.join("; ") : null;
  return total;
}

async function pollPlatform(adapter: PlatformAdapter, settings: Settings, force: boolean): Promise<{ discovered: number; queued: number; sent: number; error: string | null }> {
  const empty = { discovered: 0, queued: 0, sent: 0, error: null as string | null };
  const p = adapter.id;
  const delivery = deliveryFor(adapter, settings);
  if (delivery !== "manual" && settings.mode === "AUTO" && settings.flags.autoPublicReplies && !(await publicRepliesLimit(settings)).allowed) return empty;
  const keywords = await keywordsFor(adapter, settings, force);
  if (!keywords) return empty;

  const { found, error } = await adapter.searchPosts({ keywords, lookbackHours: 24, perKeyword: p === "x" ? 10 : 25, ownUsername: await ownUsername(p) });
  if (error) await audit("ENGAGEMENT_SKIPPED", error, {}, { platform: p }, "warn");
  const fresh: FoundPost[] = [];
  for (const f of found) {
    const inserted = await one<{ id: string }>(
      `INSERT INTO discovered_posts (platform, platform_post_id, username, text, permalink, published_at, keyword, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'FOUND') ON CONFLICT (platform, platform_post_id) DO NOTHING RETURNING id`,
      [p, f.id, f.username, f.text, f.permalink, f.publishedAt, f.keyword],
    );
    if (inserted) fresh.push(f);
  }
  if (!fresh.length) return { ...empty, error };
  const byId = new Map(fresh.map((f) => [f.id, f]));
  const scored = await scorePosts(fresh.map((f): DiscoveredPost => ({ id: f.id, username: f.username, text: f.text, publishedAt: f.publishedAt, keyword: f.keyword })), { minimumScore: settings.engagement.minimumScore });
  let queued = 0;
  let sent = 0;
  for (const s of scored) {
    await query(`UPDATE discovered_posts SET scores_json = $3::jsonb, total_score = $4, status = $5, reason = $6, updated_at = now() WHERE platform = $1 AND platform_post_id = $2`, [p, s.id, JSON.stringify({ ...s.scores, angle: s.angle }), s.scores.total, s.worth ? "QUEUED" : "SKIPPED", s.reason]);
    if (!s.worth) {
      await audit("ENGAGEMENT_SKIPPED", `${adapter.label} @${s.username}: ${s.reason}`, {}, { platform: p, postId: s.id, scores: s.scores });
      continue;
    }
    const row = await insertInteraction({ platform: p, delivery, type: "PUBLIC_POST_REPLY", targetPostId: s.id, targetReplyId: null, rootPostId: s.id, publicationId: null, targetUsername: s.username, targetText: s.text, targetPermalink: byId.get(s.id)?.permalink ?? null, targetPublishedAt: s.publishedAt });
    if (!row) continue;
    await query(`UPDATE discovered_posts SET interaction_id = $3 WHERE platform = $1 AND platform_post_id = $2`, [p, s.id, row.id]);
    await audit("ENGAGEMENT_FOUND", `${adapter.label}: релевантный пост @${s.username} (балл ${s.scores.total}): ${s.text.slice(0, 100)}\nЧто добавить: ${s.angle}`, { interactionId: row.id }, { platform: p, scores: s.scores });
    queued++;
    const prompt = await getActivePrompt(REPLY_PROMPT_NAME, REPLY_SYSTEM_PROMPT);
    let written;
    try {
      written = await writeReply({ ourPost: `Контекст: ${s.angle}`, comment: s.text, commenter: s.username, chain: [], kind: "public", wantQuestion: false, refs: { interactionId: row.id }, promptOverride: { prompt: prompt.prompt, label: prompt.label }, persona: personaBlock(settings), platformLabel: adapter.label, maxChars: Math.min(300, adapter.maxChars()), language: replyLanguageFor(s.text) });
    } catch (err) {
      await updateInteraction(row.id, { status: "FAILED", error: errorMessage(err) });
      await audit("ENGAGEMENT_SKIPPED", `Не удалось написать ответ @${s.username}: ${errorMessage(err)}`, { interactionId: row.id }, null, "error");
      continue;
    }
    const blocking = written.violations.some((v) => v.severity === "block");
    await updateInteraction(row.id, { our_text: written.text, decision: "REPLY", reason: s.reason, decision_json: { scores: s.scores, angle: s.angle, violations: written.violations }, prompt_version: written.promptVersion, model: written.model });
    if (blocking) {
      await updateInteraction(row.id, { status: "NEEDS_REVIEW", reason: written.violations.map((v) => v.message).join("; ") });
      await audit("ENGAGEMENT_GENERATED", `Ответ @${s.username} не прошёл валидацию: ${written.violations.map((v) => v.message).join("; ")}`, { interactionId: row.id }, null, "warn");
      continue;
    }
    const autoAllowed = delivery !== "manual" && settings.mode === "AUTO" && settings.flags.autoPublicReplies && written.confidence >= settings.replies.minConfidence && written.violations.length === 0;
    if (!autoAllowed) {
      await updateInteraction(row.id, { status: "DRAFT", reason: delivery === "manual" ? "X не принимает ответы чужим авторам через API — отправьте подготовленный текст кнопкой «Открыть в X»" : s.reason });
      await audit("ENGAGEMENT_GENERATED", `${adapter.label}: ответ на пост @${s.username} готов${delivery === "manual" ? " к ручной отправке" : " к проверке"}: ${written.text}`, { interactionId: row.id });
      continue;
    }
    await updateInteraction(row.id, { status: "APPROVED" });
    if ((await sendInteraction(row.id, { manual: false })) === "sent") sent++;
  }
  return { discovered: fresh.length, queued, sent, error };
}
