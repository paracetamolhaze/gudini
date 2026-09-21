import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conversationChain, getInteraction, listInteractions, updateInteraction } from "../../db/repos/interactions.js";
import { enqueue } from "../../queue/queues.js";
import { HttpError } from "../server.js";
import { clampInt } from "../../shared/ids.js";
import { audit } from "../../services/audit.js";
import { validateReply } from "../../services/replies/writer.js";
import { one, query } from "../../db/pool.js";

export function registerReplyRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/replies`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const type = q.type === "public" ? "PUBLIC_POST_REPLY" : q.type === "mention" ? "MENTION" : q.type;
    let rows = await listInteractions({ type, status: q.status, limit: clampInt(q.limit, 1, 200, 50), before: q.before });
    if (q.type === "own") rows = rows.filter((r) => r.type !== "PUBLIC_POST_REPLY");
    const ids = rows.map(r => r.publication_id).filter(Boolean);
    const publications = ids.length ? await query<{ id: string; published_text: string }>(`SELECT id, published_text FROM publications WHERE id = ANY($1::uuid[])`, [ids]) : [];
    return { interactions: rows.map(r => ({ ...r, parent_text: publications.find(p => p.id === r.publication_id)?.published_text ?? null })) };
  });

  app.get(`${api}/replies/:id`, async (req) => {
    const { id } = req.params as { id: string };
    const row = await getInteraction(id);
    if (!row) throw new HttpError(404, "interaction not found");
    const chain = row.root_post_id && row.target_reply_id ? await conversationChain(row.root_post_id, row.target_reply_id) : [];
    const publication = row.publication_id ? await one(`SELECT id, published_text, permalink, threads_post_id FROM publications WHERE id = $1`, [row.publication_id]) : null;
    const discovered = row.type === "PUBLIC_POST_REPLY" && row.target_post_id ? await one(`SELECT * FROM discovered_posts WHERE threads_post_id = $1`, [row.target_post_id]) : null;
    return { interaction: row, chain, publication, discovered };
  });

  const textBody = z.object({ text: z.string().trim().min(1).max(500) });
  app.put(`${api}/replies/:id`, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = textBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "text is required");
    const row = await getInteraction(id);
    if (!row) throw new HttpError(404, "interaction not found");
    if (["SENDING", "SENT"].includes(row.status)) throw new HttpError(409, `interaction is ${row.status}`);
    const pub = row.publication_id ? await one<{ published_text: string }>(`SELECT published_text FROM publications WHERE id = $1`, [row.publication_id]) : null;
    const violations = validateReply(parsed.data.text, { ourPost: pub?.published_text ?? row.target_text, maxChars: 500 });
    const blocking = violations.some((v) => v.severity === "block" && v.code !== "NOT_RUSSIAN");
    const updated = await updateInteraction(id, { our_text: parsed.data.text, status: blocking ? "NEEDS_REVIEW" : "DRAFT", reason: violations.length ? violations.map((v) => v.message).join("; ") : row.reason });
    return { interaction: updated, violations };
  });

  app.post(`${api}/replies/:id/send`, async (req) => {
    const { id } = req.params as { id: string };
    const row = await getInteraction(id);
    if (!row) throw new HttpError(404, "interaction not found");
    if (!row.our_text) throw new HttpError(409, "interaction has no reply text");
    if (["SENDING", "SENT"].includes(row.status)) throw new HttpError(409, `interaction is ${row.status}`);
    await updateInteraction(id, { status: "APPROVED" });
    const jobId = await enqueue("replies", "replies:send", { interactionId: id, manual: true }, { jobId: `reply-send-${id}-${Date.now()}`, priority: 1 });
    await audit("REPLY_GENERATED", `Ответ @${row.target_username} одобрен вручную и поставлен на отправку`, { interactionId: id, publicationId: row.publication_id });
    return { queued: true, jobId };
  });

  app.post(`${api}/replies/:id/skip`, async (req) => {
    const { id } = req.params as { id: string };
    const row = await getInteraction(id);
    if (!row) throw new HttpError(404, "interaction not found");
    if (row.status === "SENT") throw new HttpError(409, "already sent");
    const reason = (req.body as { reason?: string } | null)?.reason?.trim() || "пропущено вручную";
    await updateInteraction(id, { status: "SKIPPED", decision: "SKIP", reason });
    await audit("REPLY_SKIPPED", `Пропуск вручную @${row.target_username}: ${reason}`, { interactionId: id, publicationId: row.publication_id });
    return { ok: true };
  });

  app.post(`${api}/replies/:id/regenerate`, async (req) => {
    const { id } = req.params as { id: string };
    const row = await getInteraction(id);
    if (!row) throw new HttpError(404, "interaction not found");
    if (row.status === "SENT") throw new HttpError(409, "already sent");
    await updateInteraction(id, { status: "PENDING", our_text: null, decision: null, reason: null });
    const jobId = await enqueue("replies", "replies:process", { interactionId: id }, { jobId: `reply-process-${id}-${Date.now()}`, priority: 1 });
    return { queued: true, jobId };
  });

  app.get(`${api}/discovery`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const rows = await query(`SELECT * FROM discovered_posts ${q.status ? "WHERE status = $1" : ""} ORDER BY created_at DESC LIMIT 200`, q.status ? [q.status] : []);
    return { posts: rows };
  });

  app.post(`${api}/discovery/run`, async () => ({ jobId: await enqueue("engagement", "engagement:poll", {}, { jobId: `engagement-manual-${Date.now()}`, priority: 1 }) }));
  app.post(`${api}/replies/poll`, async () => ({ jobId: await enqueue("replies", "replies:poll", {}, { jobId: `replies-manual-${Date.now()}`, priority: 1 }) }));
}
