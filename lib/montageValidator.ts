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

/** Ориентиры темпа для вертикального короткого ролика. */
export const PACING = {
  /** первая вставка должна появиться не позже этой секунды */
  firstVisualBy: 5,
  /** и не раньше: начало ролика — лицо автора */
  firstVisualAfter: 1.8,
  /** максимальный непрерывный участок без вставок */
  maxARollGap: 8,
  /** нижняя граница доли экранного времени под внешним визуалом */
  minExternalCoverage: 0.5,
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
  // ТЕМП — ЭТО ОШИБКА, А НЕ ЗАМЕЧАНИЕ.
  // Валидатор знал и про покрытие 36%, и про 23.8с подряд без визуала, и всё
  // равно пропускал ролик в рендер. Так вышел статичный ролик, который никто
  // не остановил.
  if (s.externalCoverage < PACING.minExternalCoverage) {
    errors.push(
      `покрытие визуалом ${(s.externalCoverage * 100).toFixed(0)}% ниже минимума ${(PACING.minExternalCoverage * 100).toFixed(0)}%`,
    );
  } else if (s.externalCoverage < T.target_external_coverage - 0.1) {
    warnings.push(`покрытие ${(s.externalCoverage * 100).toFixed(0)}% ниже цели ${(T.target_external_coverage * 100).toFixed(0)}%`);
  }
  if (s.maxARollGap > PACING.maxARollGap) {
    errors.push(`подряд ${s.maxARollGap.toFixed(1)}с без визуала — предел ${PACING.maxARollGap}с`);
  }
  const first = [...plan.events].sort((a, b) => a.start - b.start)[0];
  if (!first) {
    errors.push("в плане нет ни одной вставки");
  } else if (first.start > PACING.firstVisualBy) {
    errors.push(`первая вставка на ${first.start.toFixed(1)}с — позже ${PACING.firstVisualBy}с, начало ролика статично`);
  }
  // вставки не должны стоять одним комом: считаем разброс по таймлайну
  if (plan.events.length >= 3) {
    const mid = plan.events.map((e) => (e.start + e.end) / 2);
    const span = Math.max(...mid) - Math.min(...mid);
    if (span < plan.duration * 0.5) {
      errors.push(
        `все вставки собраны в отрезке ${span.toFixed(1)}с из ${plan.duration.toFixed(0)}с — остальной ролик без визуала`,
      );
    }
  }
  if (s.videoShare < T.preferred_video_share - 0.15 && videos + images > 0) {
    warnings.push(`доля видео ${(s.videoShare * 100).toFixed(0)}% ниже цели ${(T.preferred_video_share * 100).toFixed(0)}%`);
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
/**
 * Готова ли медиатека к динамичному монтажу.
 *
 * Считается ЖЁСТКОЕ покрытие — доля блоков, у которых есть честный материал
 * (оценка 2 и выше). Мягкое покрытие включает «сойдёт как обстановка», и пакет
 * с жёстким покрытием 31% выглядел готовым, а на деле дал двадцать четыре
 * секунды подряд одного лица.
 *
 * Не готова — это не предупреждение: рендерить нечего, нужно доискать материал.
 */
export function packReady(pack: StoryAssetPackV2): { ok: boolean; reasons: string[]; status: "READY" | "NEEDS_MORE_MEDIA" } {
  const T = taste();
  const videos = pack.assets.filter((a) => a.kind === "VIDEO_SEGMENT").length;
  const reasons: string[] = [];
  if (videos < T.min_usable_video_segments) reasons.push(`видео-сегментов ${videos} < ${T.min_usable_video_segments}`);
  if (pack.assets.length < T.min_total_assets) reasons.push(`материалов ${pack.assets.length} < ${T.min_total_assets}`);

  const hard = pack.hardCoverageRatio ?? 0;
  if (hard < T.min_beat_coverage) {
    reasons.push(
      `жёсткое покрытие ${(hard * 100).toFixed(0)}% < ${(T.min_beat_coverage * 100).toFixed(0)}% ` +
        `(мягкое ${(pack.coverageRatio * 100).toFixed(0)}% в счёт не идёт)`,
    );
  }
  // блоки, где есть только слабый контекст, считаем незакрытыми: они и рождают провалы
  const weakOnly = pack.coverage.filter((c) => c.bestScore === 1).map((c) => c.beatId);
  if (weakOnly.length) reasons.push(`только слабый контекст у блоков: ${weakOnly.join(", ")}`);

  return { ok: reasons.length === 0, reasons, status: reasons.length === 0 ? "READY" : "NEEDS_MORE_MEDIA" };
}
