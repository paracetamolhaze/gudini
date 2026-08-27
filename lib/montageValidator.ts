import { MontagePlan } from "./creativeDirector";
import { StoryAssetPackV2 } from "./storyAssetPack";
import { taste } from "./montageTaste";

/**
 * Проверка плана ДО рендера. Идея из talking-head-autoeditor: между моделью и
 * ffmpeg стоит детерминированный валидатор, который ловит то, что модель могла
 * напридумывать. Ошибки блокируют рендер, замечания — просто диагностика.
 */

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    events: number;
    videos: number;
    images: number;
    externalCoverage: number;
    videoShare: number;
    maxARollGap: number;
    speechCutsCovered: string;
  };
};

export function validateMontage(plan: MontagePlan, pack: StoryAssetPackV2): ValidationResult {
  const T = taste();
  const errors: string[] = [];
  const warnings: string[] = [];
  const known = new Map(pack.assets.map((a) => [a.id, a]));

  // 1) все материалы существуют в пакете и проверены
  for (const e of plan.events) {
    const asset = known.get(e.assetId);
    if (!asset) {
      errors.push(`материал ${e.assetId} отсутствует в медиатеке`);
      continue;
    }
    if (!asset.verification.sourceVerified || !asset.verification.visualVerified) {
      errors.push(`материал ${e.assetId} не прошёл проверку`);
    }
  }

  // 2) повторов быть не может
  const seen = new Set<string>();
  for (const e of plan.events) {
    if (seen.has(e.assetId)) errors.push(`материал ${e.assetId} использован дважды`);
    seen.add(e.assetId);
  }

  // 3) пересечения и запрещённые типы
  const sorted = [...plan.events].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end - 0.01) {
      errors.push(`вставки пересекаются на ${sorted[i].start.toFixed(2)}с`);
    }
  }
  for (const e of plan.events) {
    if (e.type !== "EXTERNAL_VIDEO" && e.type !== "EXTERNAL_IMAGE") {
      errors.push(`недопустимый тип события: ${(e as { type: string }).type}`);
    }
    if (e.end - e.start > T.max_visual_duration + 0.05) {
      warnings.push(`вставка ${e.assetId} длиннее ${T.max_visual_duration}с`);
    }
    if (!e.quote || e.quote.trim().split(/\s+/).length < 2) {
      errors.push(`вставка ${e.assetId} без дословной цитаты речи`);
    }
  }

  // 4) диагностика темпа и покрытия — не блокирует, но видно
  const videos = plan.events.filter((e) => e.type === "EXTERNAL_VIDEO").length;
  const images = plan.events.filter((e) => e.type === "EXTERNAL_IMAGE").length;
  const s = plan.stats;
  if (s.externalCoverage < T.target_external_coverage - 0.1) {
    warnings.push(`покрытие ${(s.externalCoverage * 100).toFixed(0)}% ниже цели ${(T.target_external_coverage * 100).toFixed(0)}%`);
  }
  if (s.videoShare < T.preferred_video_share - 0.15 && videos + images > 0) {
    warnings.push(`доля видео ${(s.videoShare * 100).toFixed(0)}% ниже цели ${(T.preferred_video_share * 100).toFixed(0)}%`);
  }
  if (s.maxARollGap > T.max_aroll_gap + 1) {
    warnings.push(`подряд ${s.maxARollGap.toFixed(1)}с без визуала`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      events: plan.events.length,
      videos,
      images,
      externalCoverage: s.externalCoverage,
      videoShare: s.videoShare,
      maxARollGap: s.maxARollGap,
      speechCutsCovered: `${s.speechCutsCovered}/${s.speechCutsTotal}`,
    },
  };
}

/** Готова ли медиатека к монтажу вообще. */
export function packReady(pack: StoryAssetPackV2): { ok: boolean; reasons: string[] } {
  const T = taste();
  const videos = pack.assets.filter((a) => a.kind === "VIDEO_SEGMENT").length;
  const reasons: string[] = [];
  if (videos < T.min_usable_video_segments) reasons.push(`видео-сегментов ${videos} < ${T.min_usable_video_segments}`);
  if (pack.assets.length < T.min_total_assets) reasons.push(`материалов ${pack.assets.length} < ${T.min_total_assets}`);
  if (pack.coverageRatio < T.min_beat_coverage)
    reasons.push(`покрытие блоков ${(pack.coverageRatio * 100).toFixed(0)}% < ${(T.min_beat_coverage * 100).toFixed(0)}%`);
  return { ok: reasons.length === 0, reasons };
}
