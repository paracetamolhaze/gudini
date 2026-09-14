import { loadSettings } from "../../config/settings.js";
import { getCandidate, setCandidateStatus } from "../../db/repos/candidates.js";
import { draftsForCandidate, insertDraft, recentPublishedTexts, type DraftRow } from "../../db/repos/drafts.js";
import { getSourcePost } from "../../db/repos/sourcePosts.js";
import { getSource } from "../../db/repos/sources.js";
import { query } from "../../db/pool.js";
import { enqueue, PRIORITY } from "../../queue/queues.js";
import { audit } from "../audit.js";
import { errorMessage } from "../../shared/logger.js";
import { getActivePrompt } from "../promptVersions.js";
import { WRITER_PROMPT_NAME, WRITER_SYSTEM_PROMPT } from "./prompts.js";
import { composeDraft } from "./russianWriter.js";
import type { StyleExample } from "./styleRetrieval.js";

/**
 * Candidate → draft. Idempotent per candidate unless `force` (Regenerate): an existing live draft
 * means the job already ran. Images are handed to the media queue after the text exists.
 */
export type GenerateOutcome = { kind: "skipped"; reason: string } | { kind: "draft"; draftId: string; status: DraftRow["status"] } | { kind: "failed"; reason: string };

export async function generateDraftForCandidate(candidateId: string, opts: { force?: boolean } = {}): Promise<GenerateOutcome> {
  const candidate = await getCandidate(candidateId);
  if (!candidate) return { kind: "skipped", reason: "candidate not found" };
  if (candidate.status === "EXPIRED" || (candidate.expires_at && candidate.expires_at < new Date())) {
    await setCandidateStatus(candidateId, "EXPIRED");
    return { kind: "skipped", reason: "candidate expired" };
  }
  if (candidate.status === "REJECTED") return { kind: "skipped", reason: "candidate rejected" };
  if (!candidate.analysis_json) return { kind: "skipped", reason: "candidate has no analysis" };
  const existing = await draftsForCandidate(candidateId);
  const live = existing.filter((d) => !["REJECTED", "FAILED", "EXPIRED"].includes(d.status));
  if (live.length && !opts.force) return { kind: "skipped", reason: `draft ${live[0]!.id} already exists` };

  const settings = await loadSettings();
  const sourcePost = await getSourcePost(candidate.source_post_id);
  const source = sourcePost?.source_id ? await getSource(sourcePost.source_id) : null;
  const styleRows = await query<{ id: string; text: string; rating: number; tags: string[]; enabled: boolean }>(`SELECT id, text, rating, tags, enabled FROM style_examples WHERE enabled ORDER BY created_at DESC LIMIT 200`);
  const styleExamples: StyleExample[] = styleRows.map((r) => ({ id: r.id, text: r.text, rating: r.rating, tags: r.tags, enabled: r.enabled }));
  const prompt = await getActivePrompt(WRITER_PROMPT_NAME, WRITER_SYSTEM_PROMPT);
  await setCandidateStatus(candidateId, "GENERATING");

  let composed;
  try {
    composed = await composeDraft({
      analysis: candidate.analysis_json.analysis,
      facts: candidate.facts_json?.facts ?? [],
      sourcePosts: candidate.analysis_json.sourcePosts.map((s) => ({ author: s.author, text: s.text, permalink: s.permalink, publishedAt: s.publishedAt })),
      styleExamples,
      recentOwnPosts: await recentPublishedTexts(10),
      variants: settings.writer.variantsPerDraft,
      maxStyleExamples: settings.writer.maxStyleExamples,
      promptOverride: { prompt: prompt.prompt, label: prompt.label },
      refs: { candidateId },
    });
  } catch (err) {
    await setCandidateStatus(candidateId, "FAILED", `writer: ${errorMessage(err)}`);
    await audit("POST_VALIDATION_FAILED", `Writer не смог создать текст: ${errorMessage(err)}`, { candidateId }, null, "error");
    throw err;
  }

  const analysis = candidate.analysis_json.analysis;
  const sourceUrls = candidate.analysis_json.sourcePosts.map((s) => s.permalink).filter((u): u is string => Boolean(u));
  const chosen = composed.chosen ?? composed.variants[0] ?? null;
  if (!chosen) {
    await setCandidateStatus(candidateId, "FAILED", "writer returned no variants");
    return { kind: "failed", reason: "no variants" };
  }
  const needsReview = !composed.chosen || composed.reviewReasons.length > 0;
  const status: DraftRow["status"] = needsReview ? "NEEDS_REVIEW" : "DRAFT";
  const draft = await insertDraft({
    candidateId,
    type: chosen.variant.type,
    text: chosen.text,
    hook: chosen.variant.hook,
    body: chosen.variant.body || null,
    sourceSummary: analysis.summary,
    sourceUrls,
    confidence: chosen.variant.confidence,
    riskScore: candidate.risk_score,
    status,
    reviewReason: needsReview ? composed.reviewReasons.join("; ") : null,
    priority: candidate.priority,
    promptVersion: composed.promptVersion,
    model: composed.model,
    validation: chosen.validation,
    variants: composed.variants.map((v) => ({ type: v.variant.type, text: v.text, confidence: v.variant.confidence, score: v.score, violations: v.validation.violations })),
    expiresAt: candidate.expires_at,
  });
  await setCandidateStatus(candidateId, "GENERATED");
  await audit(
    needsReview ? "POST_NEEDS_REVIEW" : "POST_GENERATED",
    `${needsReview ? "Черновик требует проверки" : "Черновик готов"} (${chosen.variant.type}, уверенность ${chosen.variant.confidence}): ${chosen.text.slice(0, 140)}${needsReview ? `\nПричины: ${composed.reviewReasons.join("; ")}` : ""}`,
    { candidateId, draftId: draft.id },
    { promptVersion: composed.promptVersion, model: composed.model, variants: composed.variants.map((v) => ({ type: v.variant.type, score: v.score, blocking: v.validation.blocking })) },
    needsReview ? "warn" : "info",
  );
  if (!composed.chosen) {
    await audit("POST_VALIDATION_FAILED", `Все варианты нарушили правила: ${composed.reviewReasons.join("; ")}`, { candidateId, draftId: draft.id }, null, "warn");
  }

  // Images: only when the source asks for it and the feature flag is on; otherwise the draft is text-only.
  const wantsImages = settings.flags.imageTranslation && (source?.translate_images ?? false) && (sourcePost?.media_json.some((m) => m.type === "image") ?? false);
  if (wantsImages && sourcePost) {
    await enqueue("media", "media:translate", { draftId: draft.id, sourcePostId: sourcePost.id }, { priority: PRIORITY[candidate.priority], jobId: `media-${draft.id}` });
  }
  return { kind: "draft", draftId: draft.id, status };
}
