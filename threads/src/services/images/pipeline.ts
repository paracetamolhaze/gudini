import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { env } from "../../config/env.js";
import { loadSettings } from "../../config/settings.js";
import { one, query } from "../../db/pool.js";
import { getDraft, updateDraft } from "../../db/repos/drafts.js";
import { getSourcePost } from "../../db/repos/sourcePosts.js";
import { getCandidate } from "../../db/repos/candidates.js";
import { audit } from "../audit.js";
import { errorMessage } from "../../shared/logger.js";
import { classifyBlocks } from "./classify.js";
import { downloadImage } from "./download.js";
import { inpaintBlocks } from "./inpaint.js";
import { ocrImage } from "./ocr.js";
import { evaluateImageQa } from "./qa.js";
import { finalizeForThreads, renderBlocks } from "./render.js";
import type { ImageQaResult, OcrResult, PlacedBlock } from "./schemas.js";
import { translateBlocks, translationKeepsNumbers } from "./translate.js";
import type { LlmRouter } from "../../llm/index.js";

/**
 * download → OCR → classify → translate → inpaint → render → QA. Every stage is recorded on the
 * media_assets row; a failed stage leaves an honest status (FAILED / NEEDS_REVIEW), never a
 * silently untranslated image attached to an auto-published post.
 */
export type MediaStatus = "PENDING" | "DOWNLOADED" | "OCR_DONE" | "TRANSLATED" | "RENDERED" | "QA_PASSED" | "NEEDS_REVIEW" | "SKIPPED" | "FAILED";

export interface MediaAssetRow {
  id: string;
  source_post_id: string | null;
  draft_id: string | null;
  original_url: string;
  local_path: string | null;
  media_type: string;
  width: number | null;
  height: number | null;
  ocr_json: { source?: OcrResult; blocks?: PlacedBlock[]; final?: OcrResult } | null;
  translation_json: unknown;
  translated_path: string | null;
  final_path: string | null;
  qa_json: ImageQaResult | null;
  status: MediaStatus;
  attempts: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export function mediaDir(assetId: string): string {
  return path.join(env().DATA_DIR, "media", assetId);
}

async function setAsset(id: string, patch: Partial<{ status: MediaStatus; local_path: string; width: number; height: number; ocr_json: unknown; translation_json: unknown; translated_path: string; final_path: string; qa_json: unknown; error: string | null; attempts: number }>): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, v: unknown, cast = "") => {
    params.push(v);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k.endsWith("_json")) add(k, JSON.stringify(v), "::jsonb");
    else add(k, v);
  }
  if (!sets.length) return;
  params.push(id);
  await query(`UPDATE media_assets SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
}

export async function getAsset(id: string): Promise<MediaAssetRow | null> {
  return one<MediaAssetRow>(`SELECT * FROM media_assets WHERE id = $1`, [id]);
}

/** Pure stage runner (no DB) so tests can drive it with fake vision/translation models. */
export async function translateImageBuffer(
  original: Buffer,
  ctx: { postSummary?: string; minFontPx: number; router?: LlmRouter; refs?: { mediaAssetId?: string; draftId?: string } },
): Promise<{ status: "QA_PASSED" | "NEEDS_REVIEW" | "SKIPPED"; final: Buffer | null; blocks: PlacedBlock[]; sourceOcr: OcrResult; finalOcr: OcrResult | null; qa: ImageQaResult | null; skipReason?: string }> {
  const meta = await sharp(original, { failOn: "none" }).rotate().metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const { result: sourceOcr } = await ocrImage(original, { refs: ctx.refs, router: ctx.router, purpose: "source" });
  const classified = classifyBlocks(sourceOcr.blocks);
  if (!sourceOcr.hasText || !classified.some((b) => b.translate)) {
    return { status: "SKIPPED", final: null, blocks: classified, sourceOcr, finalOcr: null, qa: null, skipReason: "на картинке нет текста, который стоит переводить" };
  }
  let blocks = await translateBlocks(classified, { imageDescription: sourceOcr.imageDescription, postSummary: ctx.postSummary }, { refs: ctx.refs, router: ctx.router });
  // A translation that dropped a number is not used; the block stays untranslated and QA will flag it.
  blocks = blocks.map((b) => (b.translate && !translationKeepsNumbers(b) ? { ...b, translate: false, skipReason: "translation lost a number" } : b));
  const inpainted = await inpaintBlocks(original, blocks, width, height);
  const rendered = await renderBlocks(inpainted, blocks, width, height, { minFontPx: ctx.minFontPx });
  const final = await finalizeForThreads(rendered.image);
  const { result: finalOcr } = await ocrImage(final, { refs: ctx.refs, router: ctx.router, purpose: "qa" });
  const qa = evaluateImageQa(rendered.blocks, finalOcr);
  const lost = classified.filter((b) => b.translate).length - rendered.blocks.filter((b) => b.translate).length;
  if (lost > 0) qa.issues.push(`${lost} блок(ов) не переведены (перевод потерял числа)`);
  qa.passed = qa.issues.length === 0;
  return { status: qa.passed ? "QA_PASSED" : "NEEDS_REVIEW", final, blocks: rendered.blocks, sourceOcr, finalOcr, qa };
}

/**
 * Картинка исходной публикации как есть: скачать и приложить к посту. Ни распознавания, ни перевода,
 * ни модели — поэтому работает и на локальном мосте Claude, который умеет только текст.
 *
 * Threads скачивает картинку по публичному адресу, X загружает файл, поэтому обеим площадкам нужен
 * один и тот же готовый файл: кладём его туда же, куда кладёт переводчик, и ставим статус
 * QA_PASSED — проверять здесь нечего, мы ничего не меняли.
 */
export async function attachOriginalForDraft(draftId: string, sourcePostId: string): Promise<{ assetId: string | null; status: MediaStatus; reason?: string }> {
  const draft = await getDraft(draftId);
  if (!draft) return { assetId: null, status: "SKIPPED", reason: "draft not found" };
  if (["PUBLISHED", "PUBLISHING", "REJECTED", "EXPIRED"].includes(draft.status)) return { assetId: null, status: "SKIPPED", reason: `draft is ${draft.status}` };
  const post = await getSourcePost(sourcePostId);
  const image = post?.media_json.find((m) => m.type === "image");
  if (!post || !image) return { assetId: null, status: "SKIPPED", reason: "source has no image" };
  const settings = await loadSettings();
  if (settings.images.mode !== "original") return { assetId: null, status: "SKIPPED", reason: `режим картинок: ${settings.images.mode}` };

  const existing = await one<MediaAssetRow>(`SELECT * FROM media_assets WHERE draft_id = $1 ORDER BY created_at ASC LIMIT 1`, [draftId]);
  if (existing?.final_path && existing.status === "QA_PASSED") return { assetId: existing.id, status: existing.status };
  const asset = existing ?? (await one<MediaAssetRow>(`INSERT INTO media_assets (source_post_id, draft_id, original_url, media_type, status) VALUES ($1,$2,$3,'image','PENDING') RETURNING *`, [post.id, draftId, image.url]));
  if (!asset) throw new Error("insert media asset failed");
  const id = asset.id;
  const dir = mediaDir(id);
  await setAsset(id, { attempts: asset.attempts + 1, error: null });
  try {
    const dl = await downloadImage(image.url, { dir });
    await setAsset(id, { status: "DOWNLOADED", local_path: dl.path, width: dl.width, height: dl.height });
    // Threads принимает JPEG по ссылке; приводим к нему один раз, чтобы обе площадки брали один файл.
    await mkdir(dir, { recursive: true });
    const finalPath = path.join(dir, "final.jpg");
    await writeFile(finalPath, await sharp(await readFile(dl.path)).jpeg({ quality: 90 }).toBuffer());
    await setAsset(id, { status: "QA_PASSED", final_path: finalPath, translated_path: finalPath });
    await updateDraft(draftId, { image_asset_id: id });
    await audit("IMAGE_DOWNLOADED", `Картинка из источника приложена к посту (${dl.width}×${dl.height})`, { mediaAssetId: id, draftId }, { url: dl.finalUrl });
    return { assetId: id, status: "QA_PASSED" };
  } catch (err) {
    const reason = errorMessage(err);
    await setAsset(id, { status: "FAILED", error: reason });
    await audit("IMAGE_FAILED", `Картинку не удалось приложить: ${reason}`, { mediaAssetId: id, draftId }, null, "warn");
    return { assetId: id, status: "FAILED", reason };
  }
}

export async function translateImageForDraft(draftId: string, sourcePostId: string): Promise<{ assetId: string | null; status: MediaStatus; reason?: string }> {
  const draft = await getDraft(draftId);
  if (!draft) return { assetId: null, status: "SKIPPED", reason: "draft not found" };
  if (["PUBLISHED", "PUBLISHING", "REJECTED", "EXPIRED"].includes(draft.status)) return { assetId: null, status: "SKIPPED", reason: `draft is ${draft.status}` };
  const post = await getSourcePost(sourcePostId);
  const image = post?.media_json.find((m) => m.type === "image");
  if (!post || !image) return { assetId: null, status: "SKIPPED", reason: "source has no image" };
  const settings = await loadSettings();
  if (settings.images.mode !== "translate") return { assetId: null, status: "SKIPPED", reason: `режим картинок: ${settings.images.mode}` };

  let asset = await one<MediaAssetRow>(`SELECT * FROM media_assets WHERE draft_id = $1 ORDER BY created_at ASC LIMIT 1`, [draftId]);
  if (asset && (asset.status === "QA_PASSED" || asset.status === "NEEDS_REVIEW") && asset.final_path) return { assetId: asset.id, status: asset.status };
  if (asset && asset.status === "FAILED" && asset.attempts > settings.images.retries) return { assetId: asset.id, status: "FAILED", reason: "retries exhausted" };
  if (!asset) {
    asset = await one<MediaAssetRow>(`INSERT INTO media_assets (source_post_id, draft_id, original_url, media_type, status) VALUES ($1,$2,$3,'image','PENDING') RETURNING *`, [post.id, draftId, image.url]);
    if (!asset) throw new Error("insert media asset failed");
  }
  const id = asset.id;
  const dir = mediaDir(id);
  const refs = { mediaAssetId: id, draftId };
  await setAsset(id, { attempts: asset.attempts + 1, error: null });
  try {
    let originalPath = asset.local_path;
    if (!originalPath) {
      const dl = await downloadImage(image.url, { dir });
      originalPath = dl.path;
      await setAsset(id, { status: "DOWNLOADED", local_path: dl.path, width: dl.width, height: dl.height });
      await audit("IMAGE_DOWNLOADED", `Картинка загружена (${dl.width}×${dl.height}, ${Math.round(dl.bytes / 1024)} КБ)`, { mediaAssetId: id, draftId }, { url: dl.finalUrl });
    }
    const original = await readFile(originalPath);
    const candidate = draft.candidate_id ? await getCandidate(draft.candidate_id) : null;
    const result = await translateImageBuffer(original, { postSummary: candidate?.analysis_json?.analysis.summary, minFontPx: settings.images.minFontPx, refs });
    if (result.status === "SKIPPED") {
      await setAsset(id, { status: "SKIPPED", ocr_json: { source: result.sourceOcr, blocks: result.blocks }, error: result.skipReason ?? null });
      await audit("IMAGE_TRANSLATED", `Картинка пропущена: ${result.skipReason}`, { mediaAssetId: id, draftId }, null, "info");
      return { assetId: id, status: "SKIPPED", reason: result.skipReason };
    }
    await mkdir(dir, { recursive: true });
    const finalPath = path.join(dir, "final.jpg");
    await writeFile(finalPath, result.final!);
    await setAsset(id, {
      status: result.status,
      final_path: finalPath,
      translated_path: finalPath,
      ocr_json: { source: result.sourceOcr, blocks: result.blocks, final: result.finalOcr ?? undefined },
      translation_json: result.blocks.filter((b) => b.translate).map((b) => ({ id: b.id, from: b.text, to: b.translation, shorter: b.shorter, rendered: b.rendered })),
      qa_json: result.qa,
      error: result.qa?.passed ? null : result.qa?.issues.join("; ") ?? null,
    });
    await updateDraft(draftId, { image_asset_id: id });
    if (result.status === "QA_PASSED") {
      await audit("IMAGE_TRANSLATED", `Картинка переведена: ${result.blocks.filter((b) => b.translate).length} блок(ов), QA пройден`, { mediaAssetId: id, draftId }, { blocks: result.blocks.filter((b) => b.translate).map((b) => ({ from: b.text, to: b.translation })) });
    } else {
      const issues = result.qa?.issues ?? [];
      if (asset.attempts + 1 <= settings.images.retries) {
        // One more try is allowed by settings; leave the asset RENDERED so the sweep re-runs it.
        await setAsset(id, { status: "RENDERED" });
        await audit("IMAGE_QA_FAILED", `QA картинки не пройден (попытка ${asset.attempts + 1}): ${issues.join("; ")} — будет повтор`, { mediaAssetId: id, draftId }, { issues }, "warn");
        return { assetId: id, status: "RENDERED", reason: issues.join("; ") };
      }
      await updateDraft(draftId, { status: draft.status === "DRAFT" ? "NEEDS_REVIEW" : draft.status, review_reason: [draft.review_reason, `картинка: ${issues.join("; ")}`].filter(Boolean).join("; ") });
      await audit("IMAGE_QA_FAILED", `QA картинки не пройден: ${issues.join("; ")} — черновик отправлен на проверку`, { mediaAssetId: id, draftId }, { issues }, "warn");
    }
    return { assetId: id, status: result.status };
  } catch (err) {
    const message = errorMessage(err);
    await setAsset(id, { status: "FAILED", error: message });
    await audit("IMAGE_FAILED", `Перевод картинки не удался: ${message}`, { mediaAssetId: id, draftId }, null, "error");
    throw err;
  }
}
