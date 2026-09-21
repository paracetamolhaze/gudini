import { loadSettings, type Settings } from "../../config/settings.js";
import { env } from "../../config/env.js";
import { getCandidate, setCandidateStatus, updateCandidateJson, expireCandidates } from "../../db/repos/candidates.js";
import { expireDrafts, getDraft, listDrafts, transitionDraft, updateDraft, type DraftRow } from "../../db/repos/drafts.js";
import { draftAttemptKey, insertPublication, lastPublishedAt, postsPublishedToday, publicationsForDraft } from "../../db/repos/publishing.js";
import { getAsset } from "../images/pipeline.js";
import { publicMediaUrl } from "../../api/routes/media.js";
import { enqueue, PRIORITY } from "../../queue/queues.js";
import { query } from "../../db/pool.js";
import { PLATFORM_LABEL, PublishUnknownStateError, platform, type PlatformId, type PlatformImage } from "../../platforms/index.js";
import { NetworkError, RateLimitError, ServerError, TimeoutError } from "../../threads/errors.js";
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
 * publisher:publish — one draft to every target platform, re-checking the kill switch and
 * freshness right before the send. Platforms succeed or fail independently: a post that reached
 * Threads but not X is PARTIAL, and a retry only sends what is still missing.
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
  if (settings.mode === "AUTO") {
    for (const d of await listDrafts({ status: "DRAFT", limit: 50 })) {
      if (!autoPublishAllowed(settings, d)) continue;
      const cand = d.candidate_id ? await getCandidate(d.candidate_id) : null;
      const gate = decidePublish({
        mode: settings.mode,
        killSwitch: settings.killSwitch,
        autoPostEnabled: true,
        manual: false,
        draft: { status: d.status, riskScore: d.risk_score, confidence: d.confidence, totalScore: gateScore(d, cand?.total_score ?? null), expiresAt: d.expires_at, reviewReason: d.review_reason },
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

/** News and market moves follow the autoPost flag; trade posts have their own switch; the owner's topics always wait for the owner. */
function autoPublishAllowed(settings: Settings, d: DraftRow): boolean {
  if (d.kind === "TRADE") return settings.trades.autoPublish;
  if (d.kind === "NEWS" || d.kind === "MOVER") return settings.flags.autoPost;
  return false;
}

/** Trades and market moves are built from verified numbers, not from a scored source: there is no source score to weigh. */
function gateScore(d: DraftRow, candidateScore: number | null): number | null {
  return d.kind === "TRADE" || d.kind === "MOVER" ? 100 : candidateScore;
}

export type PlatformOutcome = { platform: PlatformId; status: "published" | "already" | "failed" | "skipped"; postId?: string; permalink?: string | null; reason?: string };

export type PublishOutcome =
  | { kind: "published"; publicationId: string; platformPostId: string; dryRun: boolean; partial: boolean; platforms: PlatformOutcome[] }
  | { kind: "skipped"; reason: string }
  | { kind: "review"; reason: string }
  | { kind: "failed"; reason: string; platforms?: PlatformOutcome[] };

/** X has its own, shorter text; when nobody wrote one the main text goes out (as a thread if it is long). */
export function textFor(draft: Pick<DraftRow, "text" | "text_x">, p: PlatformId): string {
  return p === "x" && draft.text_x?.trim() ? draft.text_x.trim() : draft.text;
}

export async function publishDraft(draftId: string, opts: { manual: boolean }): Promise<PublishOutcome> {
  const settings = await loadSettings(true);
  const draft = await getDraft(draftId);
  if (!draft) return { kind: "skipped", reason: "draft not found" };
  const candidate = draft.candidate_id ? await getCandidate(draft.candidate_id) : null;
  const gate = decidePublish({
    mode: settings.mode,
    killSwitch: settings.killSwitch,
    autoPostEnabled: autoPublishAllowed(settings, draft),
    manual: opts.manual,
    draft: { status: draft.status, riskScore: draft.risk_score, confidence: draft.confidence, totalScore: gateScore(draft, candidate?.total_score ?? null), expiresAt: draft.expires_at, reviewReason: draft.review_reason },
    thresholds: settings.scoring.autoPublish,
  });
  if (gate.route !== "PUBLISH") {
    if (gate.route === "BLOCK" && settings.killSwitch) await audit("KILL_SWITCH", `Публикация остановлена kill switch: ${draft.text.slice(0, 80)}`, { draftId }, null, "warn");
    if (gate.route === "REVIEW") await updateDraft(draftId, { status: "NEEDS_REVIEW", review_reason: gate.reason });
    return { kind: gate.route === "REVIEW" ? "review" : "skipped", reason: gate.reason };
  }
  const already = await publicationsForDraft(draftId);
  if (!already.length) {
    const limit = await postsLimit(settings);
    if (!limit.allowed) {
      await audit("LIMIT_REACHED", limit.reason, { draftId }, null, "warn");
      return { kind: "skipped", reason: limit.reason };
    }
  }
  const locked = await transitionDraft(draftId, ["APPROVED", "SCHEDULED", "FAILED", "DRAFT", "NEEDS_REVIEW", "PARTIAL"], "PUBLISHING");
  if (!locked) return { kind: "skipped", reason: `draft is ${draft.status} (already publishing?)` };

  try {
    // Dynamic numbers are re-checked seconds before the send; stale ones never go out as-is.
    const facts = candidate?.facts_json?.facts ?? draft.facts_json?.facts ?? [];
    if (!already.length && facts.some((f) => f.isDynamic)) {
      const fresh = await recheckDynamicFacts(`${draft.text}\n${draft.text_x ?? ""}`, facts, marketData());
      await audit("FRESHNESS_RECHECK", fresh.fresh ? "Динамические числа актуальны" : `Числа устарели: ${fresh.drifted.map((d) => `${d.asset} ${d.textValue} → ${d.liveValue} (${d.driftPct}%)`).join(", ")}`, { draftId, candidateId: draft.candidate_id }, { drifted: fresh.drifted, providerErrors: fresh.providerErrors }, fresh.fresh ? "info" : "warn");
      if (!fresh.fresh && candidate) {
        await updateCandidateJson(candidate.id, { facts: { facts: fresh.updatedFacts, summary: candidate.facts_json!.summary, checkedAt: fresh.checkedAt } });
        await updateDraft(draftId, { status: "REJECTED", review_reason: `числа устарели перед публикацией: ${fresh.drifted.map((d) => d.asset).join(", ")}; создан новый черновик` });
        await enqueue("content", "content:generate", { candidateId: candidate.id, force: true }, { priority: PRIORITY[draft.priority], jobId: `generate-${candidate.id}-fresh-${Date.now()}` });
        await audit("POST_REGENERATED", "Черновик отправлен на повторную генерацию с актуальными числами", { draftId, candidateId: candidate.id }, null, "warn");
        return { kind: "review", reason: "stale dynamic numbers; regenerating" };
      }
      if (!fresh.fresh) {
        // A market move without a source candidate: the moment has passed, a human decides what to do with the text.
        const reason = `числа устарели перед публикацией: ${fresh.drifted.map((d) => `${d.asset} ${d.textValue} → ${d.liveValue}`).join(", ")}`;
        await updateDraft(draftId, { status: "NEEDS_REVIEW", review_reason: reason, facts_json: { facts: fresh.updatedFacts } });
        return { kind: "review", reason };
      }
    }

    // Image: only a QA-passed (or manually approved) final image is attached.
    const image: PlatformImage = { path: null, url: null, altText: candidate?.topic ?? draft.source_summary?.slice(0, 120) ?? undefined };
    let mediaAssetId: string | null = null;
    if (draft.image_asset_id) {
      const asset = await getAsset(draft.image_asset_id);
      if (asset?.status === "QA_PASSED" && asset.final_path) {
        image.path = asset.final_path;
        image.url = env().PUBLIC_BASE_URL ? publicMediaUrl(asset.id) : null;
        mediaAssetId = asset.id;
      } else if (asset && asset.status !== "SKIPPED") {
        await audit("IMAGE_QA_FAILED", `Картинка в статусе ${asset.status} не прикреплена — пост уходит текстом`, { draftId, mediaAssetId: asset.id }, null, "warn");
      }
    }

    // Kill switch is re-read right before the send: a stop pressed during the job wins.
    const latest = await loadSettings(true);
    if (latest.killSwitch) {
      await transitionDraft(draftId, ["PUBLISHING"], already.length ? "PARTIAL" : "APPROVED");
      await audit("KILL_SWITCH", "Kill switch сработал перед отправкой — публикация отменена", { draftId }, null, "warn");
      return { kind: "skipped", reason: "kill switch" };
    }

    const dryRun = latest.dryRun;
    const targets: PlatformId[] = draft.platforms.length ? draft.platforms : ["threads"];
    const outcomes: PlatformOutcome[] = [];
    let firstPublication: { id: string; postId: string } | null = already[0] ? { id: already[0].id, postId: already[0].platform_post_id } : null;
    // Rate limits and network trouble are worth a queue retry; the retry only sends what is still missing.
    let retryable: Error | null = null;
    let unknownState = false;

    for (const p of targets) {
      const done = already.find((r) => r.platform === p);
      if (done) {
        outcomes.push({ platform: p, status: "already", postId: done.platform_post_id, permalink: done.permalink });
        continue;
      }
      if (!latest.platforms[p].enabled) {
        outcomes.push({ platform: p, status: "skipped", reason: "платформа выключена в настройках" });
        continue;
      }
      const adapter = platform(p);
      const text = textFor(draft, p);
      try {
        let postId: string;
        let permalink: string | null = null;
        let parts = 1;
        if (dryRun) {
          postId = `dryrun:${draftId}`;
          await audit("DRY_RUN", `DRY_RUN: пост не отправлен в ${PLATFORM_LABEL[p]}${image.path ? " (с картинкой)" : ""}:\n${text}`, { draftId, candidateId: draft.candidate_id }, { platform: p, imageUrl: image.url });
        } else {
          if (!adapter.configured()) throw new Error(`${PLATFORM_LABEL[p]} не подключён: добавьте ключи в threads/.env`);
          if (draft.kind === "TRADE" && draft.image_asset_id && p === "threads" && !image.url) throw new Error("PUBLIC_BASE_URL не задан — Threads не сможет скачать карточку сделки");
          if (p === "threads" && image.path && !image.url) await audit("IMAGE_FAILED", "PUBLIC_BASE_URL не задан — Threads не сможет скачать картинку, пост уходит без неё", { draftId, mediaAssetId }, null, "warn");
          const res = await adapter.publishPost({ key: draftAttemptKey(draftId, p), text, image: image.path ? image : undefined });
          postId = res.id;
          permalink = res.permalink;
          parts = res.parts;
        }
        const publication = await insertPublication({
          draftId,
          candidateId: draft.candidate_id,
          sourcePostId: candidate?.source_post_id ?? null,
          mediaAssetId,
          platform: p,
          platformPostId: postId,
          permalink,
          text,
          promptVersion: draft.prompt_version,
          model: draft.model,
          dryRun,
          meta: { parts, manual: opts.manual, imageUrl: image.url, type: draft.type, kind: draft.kind, priority: draft.priority },
        });
        firstPublication ??= { id: publication.id, postId };
        outcomes.push({ platform: p, status: "published", postId, permalink });
        await audit(
          "POST_PUBLISHED",
          `${dryRun ? "[DRY_RUN] " : ""}${PLATFORM_LABEL[p]}: опубликовано${parts > 1 ? ` тредом из ${parts} частей` : ""}${image.path ? " с картинкой" : ""}: ${text.slice(0, 120)}`,
          { draftId, candidateId: draft.candidate_id, publicationId: publication.id },
          { platform: p, platformPostId: postId, permalink, manual: opts.manual },
        );
      } catch (err) {
        const message = errorMessage(err);
        if (err instanceof RateLimitError || err instanceof TimeoutError || err instanceof NetworkError || err instanceof ServerError) retryable = err;
        if (err instanceof PublishUnknownStateError) unknownState = true;
        outcomes.push({ platform: p, status: "failed", reason: message });
        await audit("POST_PUBLISH_FAILED", `${PLATFORM_LABEL[p]}: ${err instanceof PublishUnknownStateError ? "неизвестное состояние публикации — нужна проверка вручную" : "публикация не удалась"}: ${message}`, { draftId, candidateId: draft.candidate_id }, { platform: p }, "error");
      }
    }

    const ok = outcomes.filter((o) => o.status === "published" || o.status === "already");
    const failed = outcomes.filter((o) => o.status === "failed");
    const problems = [...failed, ...outcomes.filter((o) => o.status === "skipped")].map((o) => `${PLATFORM_LABEL[o.platform]}: ${o.reason}`).join("; ");
    if (ok.length && firstPublication) {
      const partial = failed.length > 0;
      await updateDraft(draftId, { status: partial ? "PARTIAL" : "PUBLISHED", error: partial ? problems : null });
      if (candidate) await setCandidateStatus(candidate.id, "PUBLISHED");
      if (draft.trade_id) await query(`UPDATE hl_trades SET post_status = 'POSTED', updated_at = now() WHERE id = $1`, [draft.trade_id]);
      if (retryable) throw retryable;
      return { kind: "published", publicationId: firstPublication.id, platformPostId: firstPublication.postId, dryRun, partial, platforms: outcomes };
    }
    await updateDraft(draftId, { status: "FAILED", error: problems || "нет платформ для публикации" });
    if (retryable && !unknownState) throw retryable;
    if (unknownState) return { kind: "failed", reason: problems, platforms: outcomes }; // never auto-retry an unknown state
    return { kind: "failed", reason: problems || "нет платформ для публикации", platforms: outcomes };
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof TimeoutError || err instanceof NetworkError || err instanceof ServerError) throw err; // state is already recorded above
    const message = errorMessage(err);
    await updateDraft(draftId, { status: "FAILED", error: message });
    await audit("POST_PUBLISH_FAILED", `Публикация не удалась: ${message}`, { draftId, candidateId: draft.candidate_id }, null, "error");
    throw err;
  }
}

export const publisherIdempotencyKey = (draftId: string): string => `draft:${draftId}`;
export const replyIdempotencyKey = (interactionId: string): string => `interaction:${interactionId}`;
export { newId };
