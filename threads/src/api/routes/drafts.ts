import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDraft, listDrafts, updateDraft, transitionDraft, insertDraft } from "../../db/repos/drafts.js";
import { getCandidate } from "../../db/repos/candidates.js";
import { getSourcePost } from "../../db/repos/sourcePosts.js";
import { enqueue, PRIORITY } from "../../queue/queues.js";
import { HttpError } from "../server.js";
import { clampInt } from "../../shared/ids.js";
import { audit } from "../../services/audit.js";
import { validateDraft } from "../../services/writer/validate.js";
import { query, one } from "../../db/pool.js";

export function registerDraftRoutes(app: FastifyInstance, api: string): void {
  app.post(`${api}/drafts`, async (req) => {
    const body = z.object({ topic: z.string().trim().min(5).max(1500) }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, "Напишите тему поста: от 5 до 1500 символов.");
    const draft = await insertDraft({ candidateId: null, type: "EXPLAINER", text: "", hook: null, body: null, sourceSummary: body.data.topic, sourceUrls: [], confidence: null, riskScore: null, status: "GENERATING", reviewReason: null, priority: "P2", promptVersion: "topic_v1", model: null, validation: null, variants: [], expiresAt: null });
    try { await enqueue("content", "content:topic", { draftId: draft.id }, { jobId: `topic-${draft.id}`, priority: 1 }); }
    catch { await updateDraft(draft.id, { status: "FAILED", error: "Не удалось запустить написание. Повторите из карточки поста." }); }
    return { id: draft.id };
  });
  app.get(`${api}/drafts`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const drafts = await listDrafts({ status: q.status, limit: clampInt(q.limit, 1, 200, 50), before: q.before });
    const candIds = drafts.map((d) => d.candidate_id).filter((x): x is string => Boolean(x));
    const cands = candIds.length ? await query<{ id: string; topic: string | null; category: string | null; total_score: number | null; risk_score: number | null; source_post_id: string }>(`SELECT id, topic, category, total_score, risk_score, source_post_id FROM content_candidates WHERE id = ANY($1::uuid[])`, [candIds]) : [];
    const byId = new Map(cands.map((c) => [c.id, c]));
    const assetIds = drafts.map((d) => d.image_asset_id).filter((x): x is string => Boolean(x));
    const assets = assetIds.length ? await query<{ id: string; status: string; final_path: string | null }>(`SELECT id, status, final_path FROM media_assets WHERE id = ANY($1::uuid[])`, [assetIds]) : [];
    const assetById = new Map(assets.map((a) => [a.id, a]));
    return { drafts: drafts.map((d) => ({ ...d, candidate: d.candidate_id ? byId.get(d.candidate_id) ?? null : null, asset: d.image_asset_id ? assetById.get(d.image_asset_id) ?? null : null })) };
  });

  app.get(`${api}/drafts/:id`, async (req) => {
    const { id } = req.params as { id: string };
    const draft = await getDraft(id);
    if (!draft) throw new HttpError(404, "draft not found");
    const candidate = draft.candidate_id ? await getCandidate(draft.candidate_id) : null;
    const sourcePost = candidate ? await getSourcePost(candidate.source_post_id) : null;
    const assets = await query(`SELECT * FROM media_assets WHERE draft_id = $1 ORDER BY created_at ASC`, [id]);
    const feedback = await query(`SELECT * FROM draft_feedback WHERE draft_id = $1 ORDER BY created_at DESC`, [id]);
    const publication = await one(`SELECT * FROM publications WHERE draft_id = $1`, [id]);
    const attempts = await query(`SELECT * FROM publication_attempts WHERE draft_id = $1 ORDER BY created_at DESC`, [id]);
    return { draft, candidate, sourcePost, assets, feedback, publication, attempts };
  });

  const editBody = z.object({ text: z.string().min(1).max(3000) });
  app.put(`${api}/drafts/:id`, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = editBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "text is required");
    const draft = await getDraft(id);
    if (!draft) throw new HttpError(404, "draft not found");
    if (["GENERATING", "PUBLISHING", "PUBLISHED"].includes(draft.status)) throw new HttpError(409, `draft is ${draft.status}`);
    const candidate = draft.candidate_id ? await getCandidate(draft.candidate_id) : null;
    const validation = validateDraft(parsed.data.text, candidate?.facts_json?.facts ?? [], { maxChars: 2500 });
    // A human edit is trusted for wording; the validator still reports and blocks clearly forbidden content.
    const status = validation.blocking && validation.violations.some((v) => v.code === "FORBIDDEN_PHRASE") ? "NEEDS_REVIEW" : draft.status === "NEEDS_REVIEW" && !validation.blocking ? "DRAFT" : draft.status;
    const updated = await updateDraft(id, { text: parsed.data.text, hook: null, body: null, validation_json: validation, status, review_reason: validation.violations.length ? validation.violations.map((v) => v.message).join("; ") : null });
    await audit("POST_GENERATED", `Черновик отредактирован вручную (${validation.violations.length} замечаний)`, { draftId: id, candidateId: draft.candidate_id }, { violations: validation.violations });
    return { draft: updated, validation };
  });

  app.post(`${api}/drafts/:id/approve`, async (req) => {
    const { id } = req.params as { id: string };
    const row = await transitionDraft(id, ["DRAFT", "NEEDS_REVIEW", "SCHEDULED"], "APPROVED", { review_reason: null });
    if (!row) throw new HttpError(409, "draft cannot be approved from its current status");
    await updateDraft(id, { approved_by_user: true });
    await audit("POST_APPROVED", `Черновик одобрен вручную: ${row.text.slice(0, 100)}`, { draftId: id, candidateId: row.candidate_id });
    return { draft: row };
  });

  app.post(`${api}/drafts/:id/reject`, async (req) => {
    const { id } = req.params as { id: string };
    const reason = (req.body as { reason?: string } | null)?.reason?.trim() || "отклонено вручную";
    const row = await transitionDraft(id, ["DRAFT", "NEEDS_REVIEW", "APPROVED", "SCHEDULED", "FAILED"], "REJECTED", { review_reason: reason });
    if (!row) throw new HttpError(409, "draft cannot be rejected from its current status");
    await audit("POST_REJECTED", `Черновик отклонён: ${reason}`, { draftId: id, candidateId: row.candidate_id });
    return { draft: row };
  });

  app.post(`${api}/drafts/:id/regenerate`, async (req) => {
    const { id } = req.params as { id: string };
    const draft = await getDraft(id);
    if (!draft) throw new HttpError(404, "draft not found");
    if (!draft.candidate_id && draft.source_summary) {
      const changed = await transitionDraft(id, ["DRAFT", "NEEDS_REVIEW", "FAILED"], "GENERATING");
      if (!changed) throw new HttpError(409, "Пост уже обрабатывается или запланирован.");
      try { await enqueue("content", "content:topic", { draftId: id }, { jobId: `topic-${id}-${Date.now()}`, priority: 1 }); }
      catch { await updateDraft(id, { status: "FAILED", error: "Очередь недоступна. Повторите позже." }); throw new HttpError(503, "Очередь недоступна"); }
      return { queued: true, draftId: id };
    }
    if (!draft.candidate_id) throw new HttpError(409, "Не сохранена тема поста.");
    if (["PUBLISHING", "PUBLISHED"].includes(draft.status)) throw new HttpError(409, `draft is ${draft.status}`);
    await transitionDraft(id, ["DRAFT", "NEEDS_REVIEW", "APPROVED", "SCHEDULED", "FAILED"], "REJECTED", { review_reason: "заменён новой генерацией" });
    const jobId = await enqueue("content", "content:generate", { candidateId: draft.candidate_id, force: true }, { priority: PRIORITY[draft.priority], jobId: `generate-${draft.candidate_id}-${Date.now()}` });
    await audit("POST_REGENERATED", "Запрошена повторная генерация черновика", { draftId: id, candidateId: draft.candidate_id });
    return { queued: true, jobId };
  });

  const scheduleBody = z.object({ scheduledAt: z.string().datetime({ offset: true }) });
  app.post(`${api}/drafts/:id/schedule`, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = scheduleBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "scheduledAt must be an ISO datetime");
    const when = new Date(parsed.data.scheduledAt);
    if (when <= new Date()) throw new HttpError(400, "Выберите время в будущем.");
    const draft = await getDraft(id);
    if (!draft) throw new HttpError(404, "draft not found");
    if (!["DRAFT", "NEEDS_REVIEW", "APPROVED", "SCHEDULED"].includes(draft.status)) throw new HttpError(409, `draft is ${draft.status}`);
    const row = await updateDraft(id, { status: "SCHEDULED", scheduled_at: when, review_reason: null, approved_by_user: true });
    await audit("POST_SCHEDULED", `Публикация назначена на ${when.toISOString()}`, { draftId: id, candidateId: draft.candidate_id });
    return { draft: row };
  });

  app.post(`${api}/drafts/:id/publish-now`, async (req) => {
    const { id } = req.params as { id: string };
    const draft = await getDraft(id);
    if (!draft) throw new HttpError(404, "draft not found");
    if (!["DRAFT", "NEEDS_REVIEW", "APPROVED", "SCHEDULED", "FAILED"].includes(draft.status)) throw new HttpError(409, `draft is ${draft.status}`);
    await updateDraft(id, { status: "APPROVED", scheduled_at: new Date(), review_reason: null, error: null, approved_by_user: true });
    const jobId = await enqueue("publisher", "publisher:publish", { draftId: id, manual: true }, { priority: 1, jobId: `publish-${id}-${Date.now()}` });
    await audit("POST_APPROVED", "Черновик отправлен на немедленную публикацию", { draftId: id, candidateId: draft.candidate_id });
    return { queued: true, jobId };
  });

  const feedbackBody = z.object({ rating: z.enum(["LIKE", "DISLIKE"]), note: z.string().max(500).optional() });
  app.post(`${api}/drafts/:id/feedback`, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = feedbackBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "rating must be LIKE or DISLIKE");
    const draft = await getDraft(id);
    if (!draft) throw new HttpError(404, "draft not found");
    await query(`INSERT INTO draft_feedback (draft_id, rating, note) VALUES ($1,$2,$3)`, [id, parsed.data.rating, parsed.data.note ?? null]);
    // A liked draft becomes a style example candidate (rating 4) so the voice improves over time.
    if (parsed.data.rating === "LIKE") {
      await query(`INSERT INTO style_examples (text, rating, source, enabled, tags) VALUES ($1, 4, 'liked_draft', true, $2)`, [draft.text, [draft.type.toLowerCase()]]);
    }
    return { ok: true };
  });
}
