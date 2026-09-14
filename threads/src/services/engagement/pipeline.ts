import { loadSettings } from "../../config/settings.js";
import { one, query } from "../../db/pool.js";
import { insertInteraction, updateInteraction } from "../../db/repos/interactions.js";
import { threadsClient } from "../../threads/index.js";
import { PermissionError } from "../../threads/errors.js";
import { audit } from "../audit.js";
import { errorMessage } from "../../shared/logger.js";
import { getActivePrompt } from "../promptVersions.js";
import { REPLY_PROMPT_NAME, REPLY_SYSTEM_PROMPT } from "../replies/prompts.js";
import { writeReply } from "../replies/writer.js";
import { sendInteraction } from "../replies/pipeline.js";
import { scorePosts, type DiscoveredPost } from "./scoring.js";
import { normalizeThreadsMedia } from "../sources/normalize.js";

/**
 * Public engagement: keyword search → score → reply where we can add value. Hard caps are enforced
 * at send time; discovery itself rotates a few keywords per tick to stay far below the 2,200/day
 * search budget.
 */
async function ownUsername(): Promise<string> {
  const row = await one<{ username: string }>(`SELECT username FROM accounts ORDER BY updated_at DESC LIMIT 1`);
  return row?.username ?? "";
}

export async function discoverPosts(keywords: string[], opts: { lookbackHours: number; perKeyword: number }): Promise<{ found: DiscoveredPost[]; error: string | null }> {
  const client = threadsClient();
  const own = (await ownUsername()).toLowerCase();
  const sinceSec = Math.max(1688540400, Math.floor((Date.now() - opts.lookbackHours * 3_600_000) / 1000));
  const found: DiscoveredPost[] = [];
  let error: string | null = null;
  for (const q of keywords) {
    try {
      const page = await client.keywordSearch({ q, searchType: "RECENT", since: sinceSec, limit: Math.min(50, opts.perKeyword) });
      for (const m of page.data ?? []) {
        if (m.is_reply === true || !m.id) continue;
        if ((m.username ?? "").toLowerCase() === own) continue;
        const p = normalizeThreadsMedia(m);
        if (!p || !p.text) continue;
        found.push({ id: m.id, username: p.authorUsername, text: p.text, publishedAt: p.publishedAt, keyword: q });
      }
    } catch (err) {
      error = err instanceof PermissionError ? `keyword_search: нужно разрешение ${err.scope ?? "threads_keyword_search"} (без Advanced Access поиск ограничен своими постами)` : errorMessage(err);
      break;
    }
  }
  return { found, error };
}

export async function pollEngagement(): Promise<{ discovered: number; queued: number; sent: number; error: string | null }> {
  const settings = await loadSettings(true);
  const empty = { discovered: 0, queued: 0, sent: 0, error: null as string | null };
  if (settings.mode === "OFF" || settings.killSwitch) return empty;
  if (!threadsClient().hasToken) return empty;
  const keywords = settings.engagement.watchKeywords.map((k) => k.trim()).filter(Boolean);
  if (!keywords.length) return empty;
  // Rotate: three keywords per tick, starting where the last tick stopped.
  const cursorRow = await one<{ value: { i?: number } }>(`SELECT value FROM settings WHERE key = 'engagement_cursor'`);
  const start = cursorRow?.value?.i ?? 0;
  const pick = [0, 1, 2].map((n) => keywords[(start + n) % keywords.length]!).filter((v, i, a) => a.indexOf(v) === i);
  await query(`INSERT INTO settings (key, value) VALUES ('engagement_cursor', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ i: (start + pick.length) % keywords.length })]);

  const { found, error } = await discoverPosts(pick, { lookbackHours: 24, perKeyword: 25 });
  if (error) await audit("ENGAGEMENT_SKIPPED", error, {}, null, "warn");
  const fresh: DiscoveredPost[] = [];
  for (const p of found) {
    const inserted = await one<{ id: string }>(
      `INSERT INTO discovered_posts (threads_post_id, username, text, permalink, published_at, keyword, status) VALUES ($1,$2,$3,$4,$5,$6,'FOUND') ON CONFLICT (threads_post_id) DO NOTHING RETURNING id`,
      [p.id, p.username, p.text, null, p.publishedAt, p.keyword],
    );
    if (inserted) fresh.push(p);
  }
  if (!fresh.length) return { ...empty, error };
  const scored = await scorePosts(fresh, { minimumScore: settings.engagement.minimumScore });
  let queued = 0;
  let sent = 0;
  for (const s of scored) {
    await query(`UPDATE discovered_posts SET scores_json = $2::jsonb, total_score = $3, status = $4, reason = $5, updated_at = now() WHERE threads_post_id = $1`, [s.id, JSON.stringify({ ...s.scores, angle: s.angle }), s.scores.total, s.worth ? "QUEUED" : "SKIPPED", s.reason]);
    if (!s.worth) {
      await audit("ENGAGEMENT_SKIPPED", `@${s.username}: ${s.reason}`, {}, { postId: s.id, scores: s.scores });
      continue;
    }
    const row = await insertInteraction({ type: "PUBLIC_POST_REPLY", targetPostId: s.id, targetReplyId: null, rootPostId: s.id, publicationId: null, targetUsername: s.username, targetText: s.text, targetPermalink: null, targetPublishedAt: s.publishedAt });
    if (!row) continue;
    await query(`UPDATE discovered_posts SET interaction_id = $2 WHERE threads_post_id = $1`, [s.id, row.id]);
    await audit("ENGAGEMENT_FOUND", `Релевантный пост @${s.username} (балл ${s.scores.total}): ${s.text.slice(0, 100)}\nЧто добавить: ${s.angle}`, { interactionId: row.id }, { scores: s.scores });
    queued++;
    const prompt = await getActivePrompt(REPLY_PROMPT_NAME, REPLY_SYSTEM_PROMPT);
    let written;
    try {
      written = await writeReply({ ourPost: `Контекст: ${s.angle}`, comment: s.text, commenter: s.username, chain: [], kind: "public", wantQuestion: false, refs: { interactionId: row.id }, promptOverride: { prompt: prompt.prompt, label: prompt.label } });
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
    const autoAllowed = settings.mode === "AUTO" && settings.flags.autoPublicReplies && written.confidence >= settings.replies.minConfidence && written.violations.length === 0;
    if (!autoAllowed) {
      await updateInteraction(row.id, { status: "DRAFT" });
      await audit("ENGAGEMENT_GENERATED", `Ответ на пост @${s.username} готов к проверке: ${written.text}`, { interactionId: row.id });
      continue;
    }
    await updateInteraction(row.id, { status: "APPROVED" });
    if ((await sendInteraction(row.id, { manual: false })) === "sent") sent++;
  }
  return { discovered: fresh.length, queued, sent, error };
}
