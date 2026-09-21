import { loadSettings } from "../../config/settings.js";
import { env } from "../../config/env.js";
import { getCandidate, setCandidateStatus, updateCandidateJson, expireCandidates } from "../../db/repos/candidates.js";
import { expireDrafts, getDraft, listDrafts, transitionDraft, updateDraft, type DraftRow } from "../../db/repos/drafts.js";
import { attemptStore, insertPublication, lastPublishedAt, postsPublishedToday } from "../../db/repos/publishing.js";
import { getAsset } from "../images/pipeline.js";
import { publicMediaUrl } from "../../api/routes/media.js";
import { enqueue, PRIORITY } from "../../queue/queues.js";
import { threadsClient } from "../../threads/index.js";
import { PublishUnknownStateError, ThreadsPublisher } from "../../threads/publisher.js";
import { RateLimitError } from "../../threads/errors.js";
import { audit } from "../audit.js";
import { postsLimit } from "../limits.js";
import { errorMessage } from "../../shared/logger.js";
import { marketData } from "../facts/marketData/coingecko.js";
import { decidePublish } from "./gate.js";
import { recheckDynamicFacts } from "./freshness.js";
import { decideSlot } from "./schedule.js";
import { newId } from "../../shared/ids.js";

/**
 * publisher:tick — every minute: expire, route AUTO drafts through the gate, schedule approved
 * drafts into slots, and publish what is due (respecting caps and the minimum gap).
 * publisher:publish — one draft, re-checking the kill switch and freshness right before the send.
 */
export async function publisherTick(): Promise<{ published: number; scheduled: number; reviewed: number; blocked: string | null }> {
  const settings = await loadSettings(true);
  const expiredDrafts = await expireDrafts();
  for (const id of expiredDrafts) await audit("POST_EXPIRED", "Черновик просрочен и не будет опубликован", { draftId: id });
  await expireCandidates();
  if (settings.killSwitch) return { published: 0, scheduled: 0, reviewed: 0, blocked: "kill switch" };
  if (settings.mode === "OFF") return { published: 0, scheduled: 0, reviewed: 0, blocked: "mode OFF" };

  let reviewed = 0;
  let scheduled = 0;
  // AUTO: clean drafts go through the risk gate; failures become human work, never silent holds.
  if (settings.mode === "AUTO" && settings.flags.autoPost) {
    for (const d of await listDrafts({ status: "DRAFT", limit: 50 })) {
      const cand = d.candidate_id ? await getCandidate(d.candidate_id) : null;
      const gate = decidePublish({
        mode: settings.mode,
        killSwitch: settings.killSwitch,
        autoPostEnabled: settings.flags.autoPost,
        manual: false,
        draft: { status: d.status, riskScore: d.risk_score, confidence: d.confidence, totalScore: cand?.total_score ?? null, expiresAt: d.expires_at, reviewReason: d.review_reason },
        thresholds: settings.scoring.autoPublish,
      });
      if (gate.route === "PUBLISH") {
        await updateDraft(d.id, { status: "APPROVED" });
        await audit("POST_APPROVED", `AUTO: черновик допущен к публикации (${gate.reason})`, { draftId: d.id, candidateId: d.candidate_id });
      } else if (gate.route === "REVIEW") {
        await updateDraft(d.id, { status: "NEEDS_REVIEW", review_reason: gate.reason });
        await audit("POST_NEEDS_REVIEW", `AUTO: черновик отправлен на проверку — ${gate.reason}`, { draftId: d.id, candidateId: d.candidate_id }, null, "warn");
        reviewed++;
      }
    }
  }

  // Approved drafts get a slot; due slots are published in priority order.
  const now = new Date();
  const approved = await listDrafts({ status: ["APPROVED", "SCHEDULED"], limit: 100 });
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
  approved.sort((a, b) => order[a.priority] - order[b.priority] || (a.scheduled_at?.getTime() ?? 0) - (b.scheduled_at?.getTime() ?? 0));
  let published = 0;
  let lastAt = await lastPublishedAt();
  let postsToday = await postsPublishedToday(settings.schedule.timezone);
  for (const d of approved) {
    if (d.status === "SCHEDULED" && d.scheduled_at && d.scheduled_at > now) continue;
    const slot = decideSlot({
      now,
      lastPublishedAt: lastAt,
      postsToday,
      maxPostsPerDay: settings.schedule.maximumPostsPerDay,
      minimumMinutesBetweenPosts: settings.schedule.minimumMinutesBetweenPosts,
      preferredHours: settings.schedule.preferredHours,
      timezone: settings.schedule.timezone,
      priority: d.priority,
    });
    if (slot.kind === "blocked") {
      if (d.status !== "SCHEDULED") {
        await updateDraft(d.id, { status: "SCHEDULED", scheduled_at: new Date(now.getTime() + 60 * 60_000) });
        await audit("LIMIT_REACHED", `${slot.reason}; черновик подождёт`, { draftId: d.id }, null, "warn");
      }
      continue;
    }
    if (slot.kind === "at") {
      if (!d.scheduled_at || Math.abs(d.scheduled_at.getTime() - slot.at.getTime()) > 60_000 || d.status !== "SCHEDULED") {
        await updateDraft(d.id, { status: "SCHEDULED", scheduled_at: slot.at });
        await audit("POST_SCHEDULED", `Слот ${slot.at.toISOString()} — ${slot.reason}`, { draftId: d.id, candidateId: d.candidate_id });
        scheduled++;
      }
      continue;
    }
    const result = await publishDraft(d.id, { manual: d.approved_by_user });
    if (result.kind === "published") {
      published++;
      lastAt = new Date();
      postsToday++;
    }
  }
  return { published, scheduled, reviewed, blocked: null };
}

export type PublishOutcome = { kind: "published"; publicationId: string; threadsPostId: string; dryRun: boolean } | { kind: "skipped"; reason: string } | { kind: "review"; reason: string } | { kind: "failed"; reason: string };

export async function publishDraft(draftId: string, opts: { manual: boolean }): Promise<PublishOutcome> {
  const settings = await loadSettings(true);
  const draft = await getDraft(draftId);
  if (!draft) return { kind: "skipped", reason: "draft not found" };
  const candidate = draft.candidate_id ? await getCandidate(draft.candidate_id) : null;
  const gate = decidePublish({
    mode: settings.mode,
    killSwitch: settings.killSwitch,
    autoPostEnabled: settings.flags.autoPost,
    manual: opts.manual,
    draft: { status: draft.status, riskScore: draft.risk_score, confidence: draft.confidence, totalScore: candidate?.total_score ?? null, expiresAt: draft.expires_at, reviewReason: draft.review_reason },
    thresholds: settings.scoring.autoPublish,
  });
  if (gate.route !== "PUBLISH") {
    if (gate.route === "BLOCK" && settings.killSwitch) await audit("KILL_SWITCH", `Публикация остановлена kill switch: ${draft.text.slice(0, 80)}`, { draftId }, null, "warn");
    if (gate.route === "REVIEW") await updateDraft(draftId, { status: "NEEDS_REVIEW", review_reason: gate.reason });
    return { kind: gate.route === "REVIEW" ? "review" : "skipped", reason: gate.reason };
  }
  const limit = await postsLimit(settings);
  if (!limit.allowed) {
    await audit("LIMIT_REACHED", limit.reason, { draftId }, null, "warn");
    return { kind: "skipped", reason: limit.reason };
  }
  const locked = await transitionDraft(draftId, ["APPROVED", "SCHEDULED", "FAILED", "DRAFT", "NEEDS_REVIEW"], "PUBLISHING");
  if (!locked) return { kind: "skipped", reason: `draft is ${draft.status} (already publishing?)` };

  try {
    // Dynamic numbers are re-checked seconds before the send; stale ones trigger regeneration.
    let text = draft.text;
    const facts = candidate?.facts_json?.facts ?? [];
    if (facts.some((f) => f.isDynamic)) {
      const fresh = await recheckDynamicFacts(text, facts, marketData());
      await audit("FRESHNESS_RECHECK", fresh.fresh ? "Динамические числа актуальны" : `Числа устарели: ${fresh.drifted.map((d) => `${d.asset} ${d.textValue} → ${d.liveValue} (${d.driftPct}%)`).join(", ")}`, { draftId, candidateId: draft.candidate_id }, { drifted: fresh.drifted, providerErrors: fresh.providerErrors }, fresh.fresh ? "info" : "warn");
      if (!fresh.fresh && candidate) {
        await updateCandidateJson(candidate.id, { facts: { facts: fresh.updatedFacts, summary: candidate.facts_json!.summary, checkedAt: fresh.checkedAt } });
        await updateDraft(draftId, { status: "REJECTED", review_reason: `числа устарели перед публикацией: ${fresh.drifted.map((d) => d.asset).join(", ")}; создан новый черновик` });
        await enqueue("content", "content:generate", { candidateId: candidate.id, force: true }, { priority: PRIORITY[draft.priority], jobId: `generate-${candidate.id}-fresh-${Date.now()}` });
        await audit("POST_REGENERATED", "Черновик отправлен на повторную генерацию с актуальными числами", { draftId, candidateId: candidate.id }, null, "warn");
        return { kind: "review", reason: "stale dynamic numbers; regenerating" };
      }
    }

    // Image: only a QA-passed (or manually approved) translated image is attached.
    let imageUrl: string | undefined;
    let mediaAssetId: string | null = null;
    if (draft.image_asset_id) {
      const asset = await getAsset(draft.image_asset_id);
      if (asset?.status === "QA_PASSED" && asset.final_path) {
        if (!env().PUBLIC_BASE_URL) {
          await audit("IMAGE_FAILED", "PUBLIC_BASE_URL не задан — Threads не сможет скачать картинку, пост уходит без неё", { draftId, mediaAssetId: asset.id }, null, "warn");
        } else {
          imageUrl = publicMediaUrl(asset.id);
          mediaAssetId = asset.id;
        }
      } else if (asset && asset.status !== "SKIPPED") {
        await audit("IMAGE_QA_FAILED", `Картинка в статусе ${asset.status} не прикреплена — пост уходит текстом`, { draftId, mediaAssetId: asset.id }, null, "warn");
      }
    }

    // Kill switch is re-read right before the send: a stop pressed during the job wins.
    const latest = await loadSettings(true);
    if (latest.killSwitch) {
      await transitionDraft(draftId, ["PUBLISHING"], "APPROVED");
      await audit("KILL_SWITCH", "Kill switch сработал перед отправкой — публикация отменена", { draftId }, null, "warn");
      return { kind: "skipped", reason: "kill switch" };
    }

    let threadsPostId: string;
    let permalink: string | null = null;
    let parts = 1;
    const dryRun = latest.dryRun;
    if (dryRun) {
      threadsPostId = `dryrun:${draftId}`;
      await audit("DRY_RUN", `DRY_RUN: пост не отправлен в Threads${imageUrl ? " (с картинкой)" : ""}:\n${text}`, { draftId, candidateId: draft.candidate_id }, { imageUrl: imageUrl ?? null });
    } else {
      const publisher = new ThreadsPublisher(threadsClient(), attemptStore);
      const res = await publisher.publishThread({ key: `draft:${draftId}`, kind: "post", text, imageUrl, altText: imageUrl ? candidate?.topic ?? undefined : undefined });
      threadsPostId = res.root.id;
      permalink = res.root.permalink;
      parts = res.parts;
    }
    const publication = await insertPublication({
      draftId,
      candidateId: draft.candidate_id,
      sourcePostId: candidate?.source_post_id ?? null,
      mediaAssetId,
      threadsPostId,
      permalink,
      text,
      promptVersion: draft.prompt_version,
      model: draft.model,
      dryRun,
      meta: { parts, manual: opts.manual, imageUrl: imageUrl ?? null, type: draft.type, priority: draft.priority },
    });
    await updateDraft(draftId, { status: "PUBLISHED", error: null });
    if (candidate) await setCandidateStatus(candidate.id, "PUBLISHED");
    await audit(
      "POST_PUBLISHED",
      `${dryRun ? "[DRY_RUN] " : ""}Опубликовано${parts > 1 ? ` тредом из ${parts} частей` : ""}${imageUrl ? " с картинкой" : ""}: ${text.slice(0, 120)}`,
      { draftId, candidateId: draft.candidate_id, publicationId: publication.id },
      { threadsPostId, permalink, manual: opts.manual },
    );
    return { kind: "published", publicationId: publication.id, threadsPostId, dryRun };
  } catch (err) {
    const message = errorMessage(err);
    const unknown = err instanceof PublishUnknownStateError;
    await updateDraft(draftId, { status: "FAILED", error: message });
    await audit("POST_PUBLISH_FAILED", `${unknown ? "Неизвестное состояние публикации — нужна проверка вручную" : "Публикация не удалась"}: ${message}`, { draftId, candidateId: draft.candidate_id }, null, "error");
    if (err instanceof RateLimitError) throw err; // BullMQ backoff respects Meta's limit
    if (unknown) return { kind: "failed", reason: message }; // never auto-retry an unknown state
    throw err;
  }
}

export const publisherIdempotencyKey = (draftId: string): string => `draft:${draftId}`;
export const replyIdempotencyKey = (interactionId: string): string => `interaction:${interactionId}`;
export { newId };
