import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { getAsset } from "../../services/images/pipeline.js";
import { HttpError } from "../server.js";
import { query } from "../../db/pool.js";
import { getDraft, updateDraft } from "../../db/repos/drafts.js";
import { enqueue } from "../../queue/queues.js";
import { audit } from "../../services/audit.js";
import { env } from "../../config/env.js";

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" };

function sendFile(reply: FastifyReply, file: string) {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return reply.type(MIME[ext] ?? "application/octet-stream").header("cache-control", "public, max-age=3600").send(createReadStream(file));
}

/** Public URL Threads fetches the final image from (asset ids are unguessable uuids). */
export function publicMediaUrl(assetId: string): string {
  const e = env();
  const base = (e.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return `${base}${e.THREADS_URL_PREFIX}/media/public/${assetId}/final.jpg`;
}

export function registerMediaRoutes(app: FastifyInstance, prefix: string, api: string): void {
  // No auth: Meta's servers download the image from here. Only QA-passed/approved finals are served.
  app.get(`${prefix}/media/public/:id/final.jpg`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const asset = await getAsset(id);
    if (!asset?.final_path || !existsSync(asset.final_path) || !["QA_PASSED", "NEEDS_REVIEW"].includes(asset.status)) throw new HttpError(404, "no final image");
    return sendFile(reply, asset.final_path);
  });

  app.get(`${api}/media/:id/:which`, async (req, reply) => {
    const { id, which } = req.params as { id: string; which: string };
    const asset = await getAsset(id);
    if (!asset) throw new HttpError(404, "asset not found");
    const file = which === "original" ? asset.local_path : asset.final_path;
    if (!file || !existsSync(file)) throw new HttpError(404, `no ${which} file`);
    return sendFile(reply, file);
  });

  app.get(`${api}/media`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const status = q.status;
    const rows = await query(`SELECT * FROM media_assets ${status ? "WHERE status = $1" : ""} ORDER BY created_at DESC LIMIT 100`, status ? [status] : []);
    return { assets: rows };
  });

  app.post(`${api}/media/:id/retry`, async (req) => {
    const { id } = req.params as { id: string };
    const asset = await getAsset(id);
    if (!asset?.draft_id || !asset.source_post_id) throw new HttpError(404, "asset not found or detached");
    await query(`UPDATE media_assets SET status = 'PENDING', attempts = 0, error = NULL, updated_at = now() WHERE id = $1`, [id]);
    const jobId = await enqueue("media", "media:translate", { draftId: asset.draft_id, sourcePostId: asset.source_post_id }, { jobId: `media-${asset.draft_id}-manual-${Date.now()}`, priority: 1 });
    return { queued: true, jobId };
  });

  /** A human looked at the image and accepts it despite QA remarks. */
  app.post(`${api}/media/:id/approve`, async (req) => {
    const { id } = req.params as { id: string };
    const asset = await getAsset(id);
    if (!asset?.final_path) throw new HttpError(409, "asset has no final image");
    await query(`UPDATE media_assets SET status = 'QA_PASSED', updated_at = now() WHERE id = $1`, [id]);
    await audit("IMAGE_TRANSLATED", "Картинка одобрена вручную", { mediaAssetId: id, draftId: asset.draft_id });
    return { ok: true };
  });

  /** Detach the image: the draft goes out as text only. */
  app.post(`${api}/drafts/:id/image/remove`, async (req) => {
    const { id } = req.params as { id: string };
    const draft = await getDraft(id);
    if (!draft) throw new HttpError(404, "draft not found");
    await updateDraft(id, { image_asset_id: null });
    await query(`UPDATE media_assets SET status = 'SKIPPED', error = 'removed manually', updated_at = now() WHERE draft_id = $1`, [id]);
    await audit("IMAGE_FAILED", "Картинка отвязана от черновика вручную", { draftId: id }, null, "info");
    return { ok: true };
  });

  /** Ask for a translation of the source image for a draft that did not get one automatically. */
  app.post(`${api}/drafts/:id/image/translate`, async (req) => {
    const { id } = req.params as { id: string };
    const draft = await getDraft(id);
    if (!draft?.candidate_id) throw new HttpError(404, "draft not found");
    const cand = await query<{ source_post_id: string }>(`SELECT source_post_id FROM content_candidates WHERE id = $1`, [draft.candidate_id]);
    const sourcePostId = cand[0]?.source_post_id;
    if (!sourcePostId) throw new HttpError(409, "no source post");
    const jobId = await enqueue("media", "media:translate", { draftId: id, sourcePostId }, { jobId: `media-${id}-manual-${Date.now()}`, priority: 1 });
    return { queued: true, jobId };
  });
}
