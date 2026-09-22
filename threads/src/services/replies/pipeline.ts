import { loadSettings } from "../../config/settings.js";
import { one, query, getPool } from "../../db/pool.js";
import { replyHold } from "./policy.js";
import { reviewReply, passesReview } from "./review.js";
import {
  conversationChain,
  getInteraction,
  insertInteraction,
  knownTargetIds,
  pendingInteractions,
  repliesFromUserInThread,
  updateInteraction,
  upsertConversationMessages,
  type InteractionRow,
} from "../../db/repos/interactions.js";
import { interactionAttemptKey } from "../../db/repos/publishing.js";
import { PLATFORM_LABEL, PublishUnknownStateError, activePlatforms, platform, type PlatformAdapter, type PlatformId } from "../../platforms/index.js";
import { RateLimitError } from "../../threads/errors.js";
import { XReplyNotAllowedError } from "../../x/client.js";
import { audit } from "../audit.js";
import { ownRepliesLimit, publicRepliesLimit } from "../limits.js";
import { errorMessage } from "../../shared/logger.js";
import { getActivePrompt } from "../promptVersions.js";
import { personaBlock } from "../persona.js";
import { decideReply } from "./decision.js";
import { REPLY_DECISION_PROMPT_NAME, REPLY_DECISION_SYSTEM_PROMPT, REPLY_PROMPT_NAME, REPLY_SYSTEM_PROMPT } from "./prompts.js";
import { replyLanguageFor, writeReply } from "./writer.js";

/**
 * OWN POST → new comments → decision → writer → (auto) send / draft for review, on every connected
 * platform. Every side effect is gated by mode, kill switch, feature flag and hard caps, and the
 * send is idempotent per interaction.
 */
export async function ownUsername(p: PlatformId = "threads"): Promise<string> {
  const row = await one<{ username: string }>(`SELECT username FROM accounts WHERE platform = $1 ORDER BY updated_at DESC LIMIT 1`, [p]);
  return row?.username ?? "";
}

async function ourPostFor(p: PlatformId, rootPostId: string | null): Promise<{ text: string; publicationId: string | null; factsText: string }> {
  if (!rootPostId) return { text: "", publicationId: null, factsText: "" };
  const pub = await one<{ id: string; published_text: string; candidate_id: string | null; draft_id: string | null }>(`SELECT id, published_text, candidate_id, draft_id FROM publications WHERE platform = $1 AND platform_post_id = $2`, [p, rootPostId]);
  if (!pub) {
    const msg = await one<{ text: string }>(`SELECT text FROM conversation_messages WHERE platform = $1 AND message_id = $2`, [p, rootPostId]);
    return { text: msg?.text ?? "", publicationId: null, factsText: "" };
  }
  type Facts = { facts?: Array<{ claim: string; status: string }> } | null;
  let facts: Facts = null;
  if (pub.candidate_id) facts = (await one<{ facts_json: Facts }>(`SELECT facts_json FROM content_candidates WHERE id = $1`, [pub.candidate_id]))?.facts_json ?? null;
  else if (pub.draft_id) facts = (await one<{ facts_json: Facts }>(`SELECT facts_json FROM drafts WHERE id = $1`, [pub.draft_id]))?.facts_json ?? null;
  return { text: pub.published_text, publicationId: pub.id, factsText: (facts?.facts ?? []).map((f) => `- (${f.status}) ${f.claim}`).join("\n") };
}

export async function pollReplies(): Promise<{ found: number; processed: number; sent: number; skipped: number; mentionError: string | null }> {
  const settings = await loadSettings(true);
  const empty = { found: 0, processed: 0, sent: 0, skipped: 0, mentionError: null as string | null };
  if (settings.mode === "OFF" || settings.killSwitch) return empty;
  let found = 0;
  const notices: string[] = [];
  for (const adapter of activePlatforms(settings)) {
    try {
      const r = await pollPlatformInbox(adapter, settings.replies);
      found += r.found;
      if (r.notice) notices.push(r.notice);
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      const message = `${adapter.label}: не удалось прочитать комментарии — ${errorMessage(err)}`;
      notices.push(message);
      await audit("REPLY_FAILED", message, {}, null, "error");
    }
  }

  let processed = 0;
  let sent = 0;
  let skipped = 0;
  for (const row of await pendingInteractions(30)) {
    if (row.type === "PUBLIC_POST_REPLY") continue;
    const r = await processInteraction(row.id);
    processed++;
    if (r === "sent") sent++;
    if (r === "skipped") skipped++;
  }
  return { found, processed, sent, skipped, mentionError: notices.length ? notices.join("; ") : null };
}

async function pollPlatformInbox(adapter: PlatformAdapter, opts: { lookbackHours: number; maxUnansweredPerPost: number }): Promise<{ found: number; notice: string | null }> {
  const p = adapter.id;
  const own = await ownUsername(p);
  const inbox = await adapter.fetchInbox({ ownUsername: own, lookbackHours: opts.lookbackHours, maxPerPost: opts.maxUnansweredPerPost });
  if (inbox.notice) await audit("REPLY_FOUND", inbox.notice, {}, { platform: p }, "warn");

  // Persist conversations (memory) and mark which targets we already answered on-platform.
  for (const [rootId, msgs] of inbox.conversations) {
    await upsertConversationMessages(
      msgs.map((m) => ({ platform: p, message_id: m.id, root_post_id: rootId, parent_id: m.parentId, username: m.username, text: m.text, is_ours: m.username.toLowerCase() === own.toLowerCase(), platform_timestamp: m.timestamp, media: [], raw: m.raw ?? null })),
    );
  }
  const known = await knownTargetIds(p, inbox.items.map((i) => i.id));
  let found = 0;
  for (const it of inbox.items) {
    if (known.has(it.id)) continue;
    // Already answered on-platform (e.g. manually in the app)? Then just remember it.
    const conv = it.rootPostId ? inbox.conversations.get(it.rootPostId) ?? [] : [];
    const answered = conv.some((m) => m.username.toLowerCase() === own.toLowerCase() && m.parentId === it.id);
    const our = await ourPostFor(p, it.rootPostId);
    const type = it.kind === "mention" ? "MENTION" : it.parentId && it.parentId !== it.rootPostId ? "NESTED_REPLY" : "OWN_POST_REPLY";
    const row = await insertInteraction({
      platform: p,
      type,
      targetPostId: it.rootPostId,
      targetReplyId: it.id,
      rootPostId: it.rootPostId,
      publicationId: our.publicationId,
      targetUsername: it.username,
      targetText: it.text,
      targetPermalink: it.permalink,
      targetPublishedAt: it.timestamp,
    });
    if (!row) continue;
    found++;
    if (answered) {
      await updateInteraction(row.id, { status: "SKIPPED", decision: "SKIP", reason: "уже отвечено на платформе" });
      continue;
    }
    await audit("REPLY_FOUND", `${adapter.label}: новый ${type === "MENTION" ? "mention" : "комментарий"} от @${it.username}: ${it.text.slice(0, 120)}`, { interactionId: row.id, publicationId: our.publicationId }, { platform: p, permalink: it.permalink });
  }
  return { found, notice: inbox.notice };
}

export async function processInteraction(id: string): Promise<"sent" | "draft" | "review" | "skipped" | "noop"> {
  const settings = await loadSettings(true);
  const row = await getInteraction(id);
  if (!row || row.status !== "PENDING") return "noop";
  const p = row.platform;
  const our = await ourPostFor(p, row.root_post_id);
  const chainRows = row.root_post_id && row.target_reply_id ? await conversationChain(p, row.root_post_id, row.target_reply_id) : [];
  const chain = chainRows.filter((m) => m.message_id !== row.target_reply_id).map((m) => ({ username: m.username, text: m.text, isOurs: m.is_ours }));
  const prior = row.root_post_id ? (await repliesFromUserInThread(p, row.root_post_id, row.target_username)).filter((t) => t !== row.target_text) : [];
  const kind = row.type === "MENTION" ? "mention" : "reply";
  const decisionPrompt = await getActivePrompt(REPLY_DECISION_PROMPT_NAME, REPLY_DECISION_SYSTEM_PROMPT);
  let decision;
  try {
    decision = await decideReply({ ourPost: our.text, comment: row.target_text, commenter: row.target_username, chain, priorFromSameUser: prior, kind, refs: { interactionId: id }, promptOverride: decisionPrompt.prompt });
  } catch (err) {
    await updateInteraction(id, { status: "FAILED", error: `decision: ${errorMessage(err)}` });
    await audit("REPLY_FAILED", `Не удалось принять решение по комментарию @${row.target_username}: ${errorMessage(err)}`, { interactionId: id }, null, "error");
    throw err;
  }
  const d = decision.decision;
  await updateInteraction(id, { decision: d.action, reason: d.reason, decision_json: { ...d, source: decision.source, model: decision.model ?? null } });
  if (d.action === "SKIP") {
    await updateInteraction(id, { status: "SKIPPED" });
    await audit("REPLY_SKIPPED", `Пропуск @${row.target_username} (${d.sentiment}, токсичность ${d.toxicityScore}): ${d.reason}`, { interactionId: id, publicationId: row.publication_id }, { decision: d, source: decision.source });
    return "skipped";
  }
  if (d.action === "NEEDS_REVIEW") {
    await updateInteraction(id, { status: "NEEDS_REVIEW" });
    await audit("REPLY_NEEDS_REVIEW", `Комментарий @${row.target_username} требует человека: ${d.reason}`, { interactionId: id, publicationId: row.publication_id }, { decision: d }, "warn");
    return "review";
  }
  const writerPrompt = await getActivePrompt(REPLY_PROMPT_NAME, REPLY_SYSTEM_PROMPT);
  const styleRows = await query<{ text: string }>(`SELECT text FROM style_examples WHERE enabled ORDER BY rating DESC, created_at DESC LIMIT 3`);
  let written;
  try {
    written = await writeReply({
      ourPost: our.text,
      ourFactsText: our.factsText,
      comment: row.target_text,
      commenter: row.target_username,
      chain,
      kind,
      wantQuestion: d.action === "REPLY_AND_QUESTION",
      styleExamples: styleRows.map((s) => s.text),
      refs: { interactionId: id },
      promptOverride: { prompt: writerPrompt.prompt, label: writerPrompt.label },
      persona: personaBlock(settings),
      platformLabel: PLATFORM_LABEL[p],
      maxChars: Math.min(300, platform(p).maxChars()),
      language: replyLanguageFor(row.target_text),
    });
  } catch (err) {
    await updateInteraction(id, { status: "FAILED", error: `writer: ${errorMessage(err)}` });
    await audit("REPLY_FAILED", `Не удалось написать ответ @${row.target_username}: ${errorMessage(err)}`, { interactionId: id }, null, "error");
    throw err;
  }
  const blocking = written.violations.some((v) => v.severity === "block");
  const warnings = written.violations.filter((v) => v.severity === "warn");
  await updateInteraction(id, { our_text: written.text, prompt_version: written.promptVersion, model: written.model });
  const autoAllowed = settings.mode === "AUTO" && settings.flags.autoOwnReplies && row.delivery === "api" && !blocking && warnings.length === 0 && written.confidence >= settings.replies.minConfidence && d.confidence >= settings.replies.minConfidence;
  if (blocking) {
    await updateInteraction(id, { status: "NEEDS_REVIEW", reason: `${d.reason}; валидация: ${written.violations.map((v) => v.message).join("; ")}` });
    await audit("REPLY_NEEDS_REVIEW", `Ответ @${row.target_username} не прошёл валидацию: ${written.violations.map((v) => v.message).join("; ")}\n${written.text}`, { interactionId: id, publicationId: row.publication_id }, null, "warn");
    return "review";
  }
  if (!autoAllowed) {
    await updateInteraction(id, { status: "DRAFT", reason: [d.reason, ...warnings.map((w) => w.message)].join("; ") });
    await audit("REPLY_GENERATED", `Ответ @${row.target_username} готов (уверенность ${written.confidence}): ${written.text}`, { interactionId: id, publicationId: row.publication_id }, { decision: d, warnings });
    return "draft";
  }
  await updateInteraction(id, { status: "APPROVED" });
  await audit("REPLY_GENERATED", `AUTO: ответ @${row.target_username} одобрен автоматически (${written.confidence}): ${written.text}`, { interactionId: id, publicationId: row.publication_id }, { decision: d });
  const result = await sendInteraction(id, { manual: false });
  return result === "sent" ? "sent" : "draft";
}

export async function sendInteraction(id: string, opts: { manual: boolean }): Promise<"sent" | "skipped" | "failed"> {
  // Account-wide lock: both queues and manual sends share caps and cooldowns.
  const client = await getPool().connect();
  let locked = false;
  try {
    const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(73120491) AS ok");
    locked = lock.rows[0]?.ok === true;
    if (!locked) return "skipped";
    return await sendLocked(id, opts);
  } finally {
    let broken = false;
    if (locked) await client.query("SELECT pg_advisory_unlock(73120491)").catch(() => { broken = true; });
    client.release(broken);
  }
}

async function sendLocked(id: string, opts: { manual: boolean }): Promise<"sent" | "skipped" | "failed"> {
  const settings = await loadSettings(true);
  const row = await getInteraction(id);
  if (!row || !row.our_text) return "skipped";
  if (settings.killSwitch || settings.mode === "OFF") {
    await audit("KILL_SWITCH", `Отправка ответа @${row.target_username} остановлена (${settings.killSwitch ? "kill switch" : "режим OFF"})`, { interactionId: id }, null, "warn");
    return "skipped";
  }
  // The owner posts these by hand; the dashboard marks them as sent.
  if (row.delivery === "manual") return "skipped";
  const isPublic = row.type === "PUBLIC_POST_REPLY";
  if (!settings.platforms[row.platform].enabled) {
    await updateInteraction(id, { reason: `Площадка ${row.platform === "x" ? "X" : "Threads"} выключена в настройках; ответ не отправлен` });
    return "skipped";
  }
  // The owner may have changed his mind about other people's posts after this answer was approved.
  // A queue written under the old setting must not keep going out under the new one.
  if (isPublic && row.platform === "x") {
    const mode = settings.platforms.x.engagementMode;
    if (mode === "off") {
      await updateInteraction(id, { status: "SKIPPED", reason: "Чужие посты в X выключены — ответ не отправлен" });
      return "skipped";
    }
    if (mode === "manual") {
      await updateInteraction(id, { status: "DRAFT", delivery: "manual", reason: "Чужие посты в X переведены в ручной режим — отправьте ответ сами" });
      return "skipped";
    }
    if (mode === "quote" && row.delivery !== "quote") {
      await updateInteraction(id, { status: "APPROVED", delivery: "quote", reason: "Чужие посты в X переведены в режим цитат" });
      return "skipped";
    }
  }
  const limit = isPublic ? await publicRepliesLimit(settings) : await ownRepliesLimit(settings);
  if (!limit.allowed) {
    await updateInteraction(id, { reason: `${limit.reason}; ответ подождёт` });
    return "skipped";
  }
  if (!opts.manual) {
    if (row.status !== "APPROVED" || settings.mode !== "AUTO" || !(isPublic ? settings.flags.autoPublicReplies : settings.flags.autoOwnReplies)) return "skipped";
    const recent = await query<{ our_text: string; target_username: string; root_post_id: string | null; type: string; sent_at: Date }>(`SELECT our_text, target_username, root_post_id, type, sent_at FROM interactions WHERE status = 'SENT' AND platform = $1 AND sent_at > now() - interval '24 hours'`, [row.platform]);
    const hold = replyHold({ text: row.our_text, username: row.target_username, rootId: row.root_post_id, public: isPublic, targetAt: row.target_published_at }, recent.map(r => ({ text: r.our_text, username: r.target_username, rootId: r.root_post_id, public: r.type === "PUBLIC_POST_REPLY", at: r.sent_at })));
    if (hold) {
      await updateInteraction(id, { status: hold.permanent ? "SKIPPED" : "APPROVED", reason: hold.reason });
      return "skipped";
    }
    const our = await ourPostFor(row.platform, row.root_post_id);
    const review = await reviewReply(id, `${our.text}\n${our.factsText}\nКомментарий: ${row.target_text}`, row.our_text);
    if (!passesReview(review)) {
      await updateInteraction(id, { status: "SKIPPED", reason: review.reason });
      return "skipped";
    }
    // Settings or text may have changed while the model was checking the answer.
    const fresh = await loadSettings(true);
    const latest = await getInteraction(id);
    if (fresh.killSwitch || fresh.mode !== "AUTO" || fresh.dryRun !== settings.dryRun || !(isPublic ? fresh.flags.autoPublicReplies : fresh.flags.autoOwnReplies) || latest?.status !== "APPROVED" || latest.our_text !== row.our_text) return "skipped";
  }
  const latestSettings = await loadSettings(true);
  if (latestSettings.killSwitch || latestSettings.mode === "OFF" || latestSettings.dryRun !== settings.dryRun) return "skipped";
  const locked = await one(`UPDATE interactions SET status = 'SENDING', updated_at = now() WHERE id = $1 AND status = ANY($2::text[]) AND our_text = $3 RETURNING id`, [id, opts.manual ? ["APPROVED", "DRAFT", "NEEDS_REVIEW", "FAILED"] : ["APPROVED"], row.our_text]);
  if (!locked) return "skipped";
  const replyTo = row.target_reply_id ?? row.target_post_id;
  if (!replyTo) {
    await updateInteraction(id, { status: "FAILED", error: "no target id" });
    return "failed";
  }
  const adapter = platform(row.platform);
  try {
    if (settings.dryRun) {
      await audit("DRY_RUN", `DRY_RUN: ответ @${row.target_username} не отправлен (${adapter.label}):\n${row.our_text}`, { interactionId: id, publicationId: row.publication_id });
      await updateInteraction(id, { status: "DRAFT", reason: "Пробный запуск: ответ подготовлен, но не отправлен" });
      return "skipped";
    }
    if (!adapter.configured()) throw new Error(`${adapter.label} не подключён`);
    const key = interactionAttemptKey(id, row.platform);
    const res = row.delivery === "quote" && adapter.publishQuote ? await adapter.publishQuote({ key, text: row.our_text, quotedId: replyTo }) : await adapter.publishReply({ key, text: row.our_text, replyToId: replyTo });
    await updateInteraction(id, { status: "SENT", published_reply_id: res.id, permalink: res.permalink, sent_at: new Date(), error: null });
    if (row.root_post_id && row.delivery !== "quote") {
      await upsertConversationMessages([{ platform: row.platform, message_id: res.id, root_post_id: row.root_post_id, parent_id: replyTo, username: await ownUsername(row.platform), text: row.our_text, is_ours: true, platform_timestamp: new Date() }]);
    }
    await audit(isPublic ? "ENGAGEMENT_PUBLISHED" : "REPLY_PUBLISHED", `${adapter.label}: ${row.delivery === "quote" ? "цитата поста" : "ответ"} @${row.target_username} отправлен${opts.manual ? " вручную" : ""}: ${row.our_text}`, { interactionId: id, publicationId: row.publication_id }, { platform: row.platform, replyId: res.id, permalink: res.permalink });
    return "sent";
  } catch (err) {
    const message = errorMessage(err);
    if (err instanceof XReplyNotAllowedError) {
      // X's rule about programmatic replies: hand the prepared text to the owner instead of failing.
      await updateInteraction(id, { status: "DRAFT", delivery: "manual", error: null, reason: "X не принял ответ через API (разрешены только ответы тем, кто упомянул или процитировал аккаунт). Отправьте вручную кнопкой «Открыть в X»." });
      await audit("REPLY_NEEDS_REVIEW", `X не принял ответ @${row.target_username} через API — ответ переведён в ручную отправку`, { interactionId: id }, { platform: row.platform }, "warn");
      return "skipped";
    }
    await updateInteraction(id, { status: "FAILED", error: message });
    await audit(isPublic ? "ENGAGEMENT_SKIPPED" : "REPLY_FAILED", `${adapter.label}: ответ @${row.target_username} не отправлен: ${message}`, { interactionId: id }, null, "error");
    if (err instanceof RateLimitError) throw err;
    if (err instanceof PublishUnknownStateError) return "failed";
    throw err;
  }
}

/** The owner posted the prepared text by hand (manual delivery): remember it as sent. */
export async function markSentManually(id: string, permalink: string | null): Promise<InteractionRow | null> {
  const row = await getInteraction(id);
  if (!row || !row.our_text || row.status === "SENT") return row;
  const updated = await updateInteraction(id, { status: "SENT", delivery: "manual", permalink, sent_at: new Date(), error: null });
  await audit(row.type === "PUBLIC_POST_REPLY" ? "ENGAGEMENT_PUBLISHED" : "REPLY_PUBLISHED", `${PLATFORM_LABEL[row.platform]}: ответ @${row.target_username} отправлен владельцем вручную: ${row.our_text}`, { interactionId: id, publicationId: row.publication_id }, { platform: row.platform, manual: true });
  return updated;
}

export type { InteractionRow };

/** Revisit only approved replies held by cooldowns; never resend ambiguous failures. */
export async function sendWaitingReplies(): Promise<void> {
  const s = await loadSettings(true);
  if (s.mode !== "AUTO" || s.killSwitch || s.dryRun) return;
  const waiting = await query<{ id: string }>(`SELECT id FROM interactions WHERE status = 'APPROVED' AND delivery <> 'manual' ORDER BY created_at ASC LIMIT 20`);
  for (const row of waiting) await sendInteraction(row.id, { manual: false });
}
