import { loadSettings } from "../../config/settings.js";
import { getSource } from "../../db/repos/sources.js";
import { getSourcePost, setSourcePostStatus, type SourcePostRow } from "../../db/repos/sourcePosts.js";
import {
  attachToCluster,
  getCandidate,
  getCandidateBySourcePost,
  insertCandidate,
  insertCluster,
  recentClusters,
  setClusterCandidate,
  updateCandidateJson,
  type CandidateAnalysisJson,
  type CandidateFactsJson,
} from "../../db/repos/candidates.js";
import { enqueue, PRIORITY } from "../../queue/queues.js";
import { audit } from "../audit.js";
import { errorMessage, logger } from "../../shared/logger.js";
import { analyzeSourcePost } from "./analyzer.js";
import { priorityFromAnalysis, scoreCandidate } from "./scoring.js";
import { checkFacts, summarizeFactCheck } from "../facts/factChecker.js";
import { marketData } from "../facts/marketData/coingecko.js";
import { findMatchingCluster } from "../dedup/cluster.js";
import type { SourceAnalysis } from "./schemas.js";

/**
 * Source post → analysis → event cluster → score gate → fact check → candidate.
 * Idempotent: a post that already has a candidate is skipped; a failed LLM call leaves the post
 * FAILED for the job retry, never a half-written candidate.
 */
export type AnalyzeOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "merged"; clusterId: string; candidateId: string }
  | { kind: "rejected"; candidateId: string; reason: string }
  | { kind: "approved"; candidateId: string; total: number };

export async function analyzeSourcePostById(sourcePostId: string): Promise<AnalyzeOutcome> {
  const post = await getSourcePost(sourcePostId);
  if (!post) return { kind: "skipped", reason: "source post not found" };
  if (post.status === "DUPLICATE") return { kind: "skipped", reason: "duplicate" };
  const existing = await getCandidateBySourcePost(post.id);
  if (existing) return { kind: "skipped", reason: `candidate ${existing.id} already exists` };
  if (post.status !== "NEW" && post.status !== "FAILED" && post.status !== "ANALYZING") return { kind: "skipped", reason: `status ${post.status}` };

  const settings = await loadSettings();
  const source = post.source_id ? await getSource(post.source_id) : null;
  await setSourcePostStatus(post.id, "ANALYZING");

  let analysis: SourceAnalysis;
  let model: string;
  let promptVersion: string;
  try {
    const r = await analyzeSourcePost({
      text: post.text,
      authorUsername: post.author_username,
      platform: post.platform,
      permalink: post.permalink,
      publishedAt: post.published_at,
      sourceName: source?.name ?? post.platform,
      sourceTrust: source?.trust_score ?? 50,
      sourceLanguage: source?.language ?? "en",
      mediaCount: post.media_json.length,
      imageAltTexts: post.media_json.map((m) => m.altText ?? "").filter(Boolean),
      refs: {},
    });
    analysis = r.analysis;
    model = r.model;
    promptVersion = r.promptVersion;
  } catch (err) {
    // Left FAILED for the job retry; the worker records JOB_FAILED with the reason after the last attempt.
    await setSourcePostStatus(post.id, "FAILED");
    logger().warn({ sourcePostId: post.id, err: errorMessage(err) }, "analysis failed");
    throw err;
  }

  if (analysis.injectionAttempt) {
    await audit("CANDIDATE_REJECTED", `Пост @${post.author_username} содержит инструкции для ИИ — учтено как данные, риск повышен`, { sourceId: post.source_id, sourcePostId: post.id }, { injectionAttempt: true }, "warn");
    analysis = { ...analysis, riskScore: Math.max(analysis.riskScore, 70) };
  }

  // ---- event clustering: same event already known? --------------------------------------
  const clusters = await recentClusters(settings.dedup.windowHours);
  const match = findMatchingCluster(
    { eventKey: analysis.eventKey, entities: analysis.entities, category: analysis.category, windowHours: settings.dedup.windowHours },
    clusters.map((c) => ({ id: c.id, eventKey: c.event_key, entities: c.entities ?? [], category: c.category ?? null, lastSeenAt: c.last_seen_at, sourcePostIds: c.source_post_ids, candidateId: c.candidate_id })),
  );
  const ageHours = post.published_at ? (Date.now() - post.published_at.getTime()) / 3_600_000 : null;
  const postSummary = { id: post.id, author: post.author_username, permalink: post.permalink, publishedAt: post.published_at?.toISOString() ?? null, text: post.text.slice(0, 1500) };

  if (match && match.cluster.candidateId) {
    const candidateId = match.cluster.candidateId;
    const cand = await getCandidate(candidateId);
    await attachToCluster(match.cluster.id, post.id);
    await setSourcePostStatus(post.id, "ANALYZED");
    if (cand?.analysis_json) {
      const merged: CandidateAnalysisJson = {
        ...cand.analysis_json,
        sourcePosts: [...cand.analysis_json.sourcePosts.filter((s) => s.id !== post.id), postSummary],
        clusterReason: match.reason,
      };
      // More independent sources → more corroboration → rescore (risk relief only, never new facts).
      const rescored = scoreCandidate({
        analysis: cand.analysis_json.analysis,
        sourcePriority: source?.priority ?? 2,
        sourceTrust: source?.trust_score ?? 50,
        ageHours,
        weights: settings.scoring.weights,
        threshold: source?.minimum_score ?? settings.scoring.minimumContentScore,
        corroboration: merged.sourcePosts.length,
      });
      merged.scoring = { ...cand.analysis_json.scoring, total: Math.max(cand.analysis_json.scoring.total, rescored.total), passes: cand.analysis_json.scoring.passes || rescored.passes };
      await updateCandidateJson(candidateId, { analysis: merged });
    }
    await audit(
      "EVENT_CLUSTERED",
      `Пост @${post.author_username} — то же событие (${analysis.eventKey}): объединён с кандидатом; ${match.reason}`,
      { sourceId: post.source_id, sourcePostId: post.id, candidateId },
      { clusterId: match.cluster.id, reason: match.reason, sources: (cand?.analysis_json?.sourcePosts.length ?? 0) + 1 },
    );
    return { kind: "merged", clusterId: match.cluster.id, candidateId };
  }

  const clusterId = match ? match.cluster.id : (await insertCluster({ eventKey: analysis.eventKey, title: analysis.topic, sourcePostId: post.id })).id;
  if (match) await attachToCluster(clusterId, post.id);

  // ---- scoring gate ---------------------------------------------------------------------
  const threshold = source?.minimum_score ?? settings.scoring.minimumContentScore;
  const scoring = scoreCandidate({
    analysis,
    sourcePriority: source?.priority ?? 2,
    sourceTrust: source?.trust_score ?? 50,
    ageHours,
    weights: settings.scoring.weights,
    threshold,
  });
  const priority = priorityFromAnalysis(analysis, scoring.total);
  const expiresAt = new Date(Date.now() + (analysis.isBreaking ? settings.expiry.breakingHours : analysis.contentKind === "ANALYSIS" ? settings.expiry.evergreenHours : settings.expiry.normalHours) * 3_600_000);
  const analysisJson: CandidateAnalysisJson = { analysis, scoring, model, promptVersion, sourcePosts: [postSummary], clusterReason: match?.reason };

  const rejectReason = !analysis.worthPosting
    ? `Аналитик: ${analysis.reason}`
    : analysis.contentKind === "SPAM" || analysis.contentKind === "PROMO"
      ? `Тип контента ${analysis.contentKind}: ${analysis.reason}`
      : !scoring.passes
        ? `Итоговый балл ${scoring.total} ниже порога ${threshold} (риск ${scoring.risk})`
        : null;

  if (rejectReason) {
    const cand = await insertCandidate({ sourcePostId: post.id, clusterId, topic: analysis.topic, category: analysis.category, scoring, analysis: analysisJson, facts: null, status: "REJECTED", rejectReason, priority, expiresAt });
    await setClusterCandidate(clusterId, cand.id);
    await setSourcePostStatus(post.id, "REJECTED");
    await audit("CANDIDATE_REJECTED", `${analysis.topic}: ${rejectReason}`, { sourceId: post.source_id, sourcePostId: post.id, candidateId: cand.id }, { scoring, category: analysis.category });
    return { kind: "rejected", candidateId: cand.id, reason: rejectReason };
  }

  // ---- fact check -----------------------------------------------------------------------
  const check = await checkFacts(analysis.facts, marketData());
  const facts: CandidateFactsJson = { facts: check.facts, summary: summarizeFactCheck(check.facts), checkedAt: new Date().toISOString() };
  if (check.providerErrors.length) analysisJson.providerErrors = check.providerErrors;

  const cand = await insertCandidate({ sourcePostId: post.id, clusterId, topic: analysis.topic, category: analysis.category, scoring, analysis: analysisJson, facts, status: "APPROVED_FOR_GENERATION", rejectReason: null, priority, expiresAt });
  await setClusterCandidate(clusterId, cand.id);
  await setSourcePostStatus(post.id, "CANDIDATE");
  await audit(
    "CANDIDATE_ANALYZED",
    `${analysis.topic}\nРелевантность ${scoring.relevance} · свежесть ${Math.round(scoring.freshness)} · новизна ${scoring.novelty} · риск ${scoring.risk} → итог ${scoring.total} (порог ${threshold})\nРешение: генерировать (${priority}). Причина: ${analysis.reason}`,
    { sourceId: post.source_id, sourcePostId: post.id, candidateId: cand.id },
    { scoring, priority, category: analysis.category, eventKey: analysis.eventKey, expiresAt: expiresAt.toISOString() },
  );
  await audit(
    facts.summary.hasContradiction ? "FACT_CHECK_FAILED" : "FACT_CHECKED",
    `Факты: подтверждено ${facts.summary.verified}, без независимого подтверждения ${facts.summary.unverified}, противоречит рынку ${facts.summary.contradicted}, динамических ${facts.summary.dynamic}`,
    { sourceId: post.source_id, sourcePostId: post.id, candidateId: cand.id },
    { facts: check.facts.map((f) => ({ claim: f.claim, status: f.status, evidence: f.evidence })), providerErrors: check.providerErrors },
    facts.summary.hasContradiction ? "warn" : "info",
  );
  await enqueue("content", "content:generate", { candidateId: cand.id }, { priority: PRIORITY[priority], jobId: `generate-${cand.id}` });
  return { kind: "approved", candidateId: cand.id, total: scoring.total };
}

