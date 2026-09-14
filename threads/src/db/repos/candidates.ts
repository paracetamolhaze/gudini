import { one, query } from "../pool.js";
import type { ScoreBreakdown, SourceAnalysis, VerifiedFact } from "../../services/analysis/schemas.js";

export type CandidateStatus = "DISCOVERED" | "ANALYZED" | "REJECTED" | "APPROVED_FOR_GENERATION" | "GENERATING" | "GENERATED" | "PUBLISHED" | "EXPIRED" | "FAILED";

export interface CandidateAnalysisJson {
  analysis: SourceAnalysis;
  scoring: ScoreBreakdown;
  model: string;
  promptVersion: string;
  sourcePosts: Array<{ id: string; author: string; permalink: string | null; publishedAt: string | null; text: string }>;
  clusterReason?: string;
  providerErrors?: string[];
}

export interface CandidateFactsJson {
  facts: VerifiedFact[];
  summary: { verified: number; unverified: number; contradicted: number; dynamic: number; hasContradiction: boolean };
  checkedAt: string;
}

export interface CandidateRow {
  id: string;
  source_post_id: string;
  cluster_id: string | null;
  topic: string | null;
  category: string | null;
  relevance_score: number | null;
  freshness_score: number | null;
  virality_score: number | null;
  trust_score: number | null;
  uniqueness_score: number | null;
  risk_score: number | null;
  total_score: number | null;
  analysis_json: CandidateAnalysisJson | null;
  facts_json: CandidateFactsJson | null;
  status: CandidateStatus;
  reject_reason: string | null;
  priority: "P0" | "P1" | "P2" | "P3";
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function insertCandidate(input: {
  sourcePostId: string;
  clusterId: string | null;
  topic: string;
  category: string;
  scoring: ScoreBreakdown;
  analysis: CandidateAnalysisJson;
  facts: CandidateFactsJson | null;
  status: CandidateStatus;
  rejectReason: string | null;
  priority: CandidateRow["priority"];
  expiresAt: Date | null;
}): Promise<CandidateRow> {
  const row = await one<CandidateRow>(
    `INSERT INTO content_candidates (source_post_id, cluster_id, topic, category, relevance_score, freshness_score, virality_score, trust_score, uniqueness_score, risk_score, total_score, analysis_json, facts_json, status, reject_reason, priority, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17)
     ON CONFLICT (source_post_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [
      input.sourcePostId,
      input.clusterId,
      input.topic,
      input.category,
      input.scoring.relevance,
      input.scoring.freshness,
      input.scoring.value,
      input.scoring.sourcePriority,
      input.scoring.novelty,
      input.scoring.risk,
      input.scoring.total,
      JSON.stringify(input.analysis),
      input.facts ? JSON.stringify(input.facts) : null,
      input.status,
      input.rejectReason,
      input.priority,
      input.expiresAt,
    ],
  );
  if (!row) throw new Error("insert candidate returned no row");
  return row;
}

export async function getCandidate(id: string): Promise<CandidateRow | null> {
  return one<CandidateRow>(`SELECT * FROM content_candidates WHERE id = $1`, [id]);
}

export async function getCandidateBySourcePost(sourcePostId: string): Promise<CandidateRow | null> {
  return one<CandidateRow>(`SELECT * FROM content_candidates WHERE source_post_id = $1`, [sourcePostId]);
}

export async function setCandidateStatus(id: string, status: CandidateStatus, rejectReason: string | null = null): Promise<void> {
  await query(`UPDATE content_candidates SET status = $2, reject_reason = COALESCE($3, reject_reason), updated_at = now() WHERE id = $1`, [id, status, rejectReason]);
}

export async function updateCandidateJson(id: string, patch: { analysis?: CandidateAnalysisJson; facts?: CandidateFactsJson }): Promise<void> {
  await query(
    `UPDATE content_candidates SET analysis_json = COALESCE($2::jsonb, analysis_json), facts_json = COALESCE($3::jsonb, facts_json), updated_at = now() WHERE id = $1`,
    [id, patch.analysis ? JSON.stringify(patch.analysis) : null, patch.facts ? JSON.stringify(patch.facts) : null],
  );
}

export async function listCandidates(opts: { status?: string; limit?: number; before?: string }): Promise<CandidateRow[]> {
  const params: unknown[] = [];
  const conds: string[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (opts.status) conds.push(`status = ${push(opts.status)}`);
  if (opts.before) conds.push(`created_at < ${push(opts.before)}`);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return query<CandidateRow>(`SELECT * FROM content_candidates ${where} ORDER BY created_at DESC LIMIT ${push(Math.min(200, opts.limit ?? 50))}`, params);
}

export async function expireCandidates(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE content_candidates SET status = 'EXPIRED', updated_at = now()
     WHERE expires_at < now() AND status IN ('DISCOVERED','ANALYZED','APPROVED_FOR_GENERATION') RETURNING id`,
  );
  return rows.length;
}

// ---- event clusters -------------------------------------------------------------------------

export interface ClusterRow {
  id: string;
  event_key: string | null;
  title: string;
  source_post_ids: string[];
  candidate_id: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  entities?: string[];
  category?: string | null;
}

export async function recentClusters(windowHours: number): Promise<Array<ClusterRow & { entities: string[]; category: string | null }>> {
  return query(
    `SELECT ec.*,
            COALESCE((SELECT array_agg(e) FROM jsonb_array_elements_text(c.analysis_json->'analysis'->'entities') e), '{}') AS entities,
            c.category
     FROM event_clusters ec LEFT JOIN content_candidates c ON c.id = ec.candidate_id
     WHERE ec.last_seen_at >= now() - make_interval(hours => $1)
     ORDER BY ec.last_seen_at DESC LIMIT 300`,
    [windowHours],
  );
}

export async function insertCluster(input: { eventKey: string; title: string; sourcePostId: string }): Promise<ClusterRow> {
  const row = await one<ClusterRow>(`INSERT INTO event_clusters (event_key, title, source_post_ids) VALUES ($1,$2,$3) RETURNING *`, [input.eventKey, input.title, [input.sourcePostId]]);
  if (!row) throw new Error("insert cluster returned no row");
  return row;
}

export async function attachToCluster(clusterId: string, sourcePostId: string): Promise<void> {
  await query(`UPDATE event_clusters SET source_post_ids = array_append(array_remove(source_post_ids, $2), $2), last_seen_at = now() WHERE id = $1`, [clusterId, sourcePostId]);
}

export async function setClusterCandidate(clusterId: string, candidateId: string): Promise<void> {
  await query(`UPDATE event_clusters SET candidate_id = $2 WHERE id = $1`, [clusterId, candidateId]);
}
