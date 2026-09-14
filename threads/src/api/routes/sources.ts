import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deleteSource, getSource, insertSource, listSources, updateSource } from "../../db/repos/sources.js";
import { listSourcePosts } from "../../db/repos/sourcePosts.js";
import { enqueue } from "../../queue/queues.js";
import { HttpError } from "../server.js";
import { clampInt } from "../../shared/ids.js";
import { audit } from "../../services/audit.js";

const sourceBody = z.object({
  type: z.enum(["THREADS_PROFILE", "THREADS_SEARCH", "RSS", "NEWS", "MANUAL"]),
  username: z.string().trim().max(80).optional().nullable(),
  name: z.string().trim().max(120).optional(),
  url: z.string().trim().max(1000).optional().nullable(),
  language: z.string().trim().max(8).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  enabled: z.boolean().optional(),
  trust_score: z.number().int().min(0).max(100).optional(),
  translate_images: z.boolean().optional(),
  minimum_score: z.number().min(0).max(100).nullable().optional(),
  keywords: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  poll_minutes: z.number().int().min(2).max(24 * 60).optional(),
});

function validateShape(input: z.infer<typeof sourceBody>): void {
  if (input.type === "THREADS_PROFILE" && !input.username?.replace(/^@/, "").trim()) throw new HttpError(400, "THREADS_PROFILE source needs a username");
  if ((input.type === "RSS" || input.type === "NEWS") && !/^https?:\/\//i.test(input.url ?? "")) throw new HttpError(400, "RSS source needs an http(s) feed url");
  if (input.type === "THREADS_SEARCH" && !(input.url?.trim() || input.name?.trim())) throw new HttpError(400, "THREADS_SEARCH source needs a query (url field)");
}

export function registerSourceRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/sources`, async () => ({ sources: await listSources() }));

  /** Force a poll of every enabled source now (the scheduler does this on its own interval). */
  app.post(`${api}/sources/poll`, async () => {
    const jobId = await enqueue("source", "source:poll", {}, { jobId: `source-poll-manual-${Date.now()}`, priority: 1 });
    return { queued: true, jobId };
  });

  app.post(`${api}/sources`, async (req, reply) => {
    const parsed = sourceBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    validateShape(parsed.data);
    try {
      const row = await insertSource(parsed.data);
      await enqueue("source", "source:check", { sourceId: row.id, force: true }, { jobId: `source-check:${row.id}:${Date.now()}` });
      return reply.code(201).send({ source: row });
    } catch (err) {
      if (err instanceof Error && /sources_profile_unique/.test(err.message)) throw new HttpError(409, "Этот профиль уже добавлен");
      throw err;
    }
  });

  app.patch(`${api}/sources/:id`, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = sourceBody.partial().safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const row = await updateSource(id, parsed.data);
    if (!row) throw new HttpError(404, "source not found");
    return { source: row };
  });

  app.delete(`${api}/sources/:id`, async (req) => {
    const { id } = req.params as { id: string };
    const source = await getSource(id);
    if (!source) throw new HttpError(404, "source not found");
    await deleteSource(id);
    await audit("SETTINGS_CHANGED", `Источник удалён: ${source.name}`, { sourceId: id });
    return { ok: true };
  });

  app.post(`${api}/sources/:id/check`, async (req) => {
    const { id } = req.params as { id: string };
    const source = await getSource(id);
    if (!source) throw new HttpError(404, "source not found");
    const jobId = await enqueue("source", "source:check", { sourceId: id, force: true }, { jobId: `source-check:${id}:${Date.now()}`, priority: 1 });
    return { queued: true, jobId };
  });

  app.get(`${api}/sources/:id/posts`, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    return { posts: await listSourcePosts({ sourceId: id, limit: clampInt(q.limit, 1, 200, 30) }) };
  });

  app.get(`${api}/source-posts`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return { posts: await listSourcePosts({ status: q.status, sourceId: q.sourceId, limit: clampInt(q.limit, 1, 200, 50), before: q.before }) };
  });
}
