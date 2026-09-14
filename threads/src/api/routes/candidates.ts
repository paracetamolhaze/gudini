import type { FastifyInstance } from "fastify";
import { getCandidate, listCandidates, setCandidateStatus } from "../../db/repos/candidates.js";
import { getSourcePost } from "../../db/repos/sourcePosts.js";
import { updateSource } from "../../db/repos/sources.js";
import { enqueue, PRIORITY } from "../../queue/queues.js";
import { HttpError } from "../server.js";
import { clampInt } from "../../shared/ids.js";
import { audit } from "../../services/audit.js";
import { query } from "../../db/pool.js";

export function registerCandidateRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/candidates`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const rows = await listCandidates({ status: q.status, limit: clampInt(q.limit, 1, 200, 50), before: q.before });
    // Attach the originating post (author, text, media) so the list can show the original next to the summary.
    const ids = rows.map((r) => r.source_post_id);
    const posts = ids.length ? await query<{ id: string; author_username: string; text: string; permalink: string | null; media_json: unknown; published_at: Date | null; source_id: string | null }>(`SELECT id, author_username, text, permalink, media_json, published_at, source_id FROM source_posts WHERE id = ANY($1::uuid[])`, [ids]) : [];
    const byId = new Map(posts.map((p) => [p.id, p]));
    return { candidates: rows.map((r) => ({ ...r, sourcePost: byId.get(r.source_post_id) ?? null })) };
  });

  app.get(`${api}/candidates/:id`, async (req) => {
    const { id } = req.params as { id: string };
    const candidate = await getCandidate(id);
    if (!candidate) throw new HttpError(404, "candidate not found");
    const sourcePost = await getSourcePost(candidate.source_post_id);
    const drafts = await query(`SELECT id, status, type, text, confidence, risk_score, created_at FROM drafts WHERE candidate_id = $1 ORDER BY created_at DESC`, [id]);
    return { candidate, sourcePost, drafts };
  });

  app.post(`${api}/candidates/:id/generate`, async (req) => {
    const { id } = req.params as { id: string };
    const candidate = await getCandidate(id);
    if (!candidate) throw new HttpError(404, "candidate not found");
    if (candidate.status === "EXPIRED") throw new HttpError(409, "candidate expired");
    await setCandidateStatus(id, "APPROVED_FOR_GENERATION", null);
    const jobId = await enqueue("content", "content:generate", { candidateId: id, force: true }, { priority: PRIORITY[candidate.priority], jobId: `generate-${id}-${Date.now()}` });
    await audit("CANDIDATE_APPROVED", `Кандидат отправлен на генерацию вручную: ${candidate.topic ?? id}`, { candidateId: id });
    return { queued: true, jobId };
  });

  app.post(`${api}/candidates/:id/reject`, async (req) => {
    const { id } = req.params as { id: string };
    const candidate = await getCandidate(id);
    if (!candidate) throw new HttpError(404, "candidate not found");
    const reason = (req.body as { reason?: string } | null)?.reason?.trim() || "отклонено вручную";
    await setCandidateStatus(id, "REJECTED", reason);
    await audit("CANDIDATE_REJECTED", `Кандидат отклонён вручную: ${candidate.topic ?? id} — ${reason}`, { candidateId: id });
    return { ok: true };
  });

  app.post(`${api}/candidates/:id/ignore-source`, async (req) => {
    const { id } = req.params as { id: string };
    const candidate = await getCandidate(id);
    if (!candidate) throw new HttpError(404, "candidate not found");
    const post = await getSourcePost(candidate.source_post_id);
    if (!post?.source_id) throw new HttpError(409, "candidate has no source to disable");
    await updateSource(post.source_id, { enabled: false });
    await setCandidateStatus(id, "REJECTED", "источник отключён");
    await audit("SOURCE_REJECTED", `Источник отключён из карточки кандидата: ${candidate.topic ?? id}`, { candidateId: id, sourceId: post.source_id });
    return { ok: true, sourceId: post.source_id };
  });

  app.post(`${api}/source-posts/:id/analyze`, async (req) => {
    const { id } = req.params as { id: string };
    const post = await getSourcePost(id);
    if (!post) throw new HttpError(404, "source post not found");
    const jobId = await enqueue("analysis", "analysis:analyze", { sourcePostId: id }, { jobId: `analyze-${id}-${Date.now()}`, priority: 1 });
    return { queued: true, jobId };
  });
}
