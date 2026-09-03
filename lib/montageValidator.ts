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

/**
 * Пределы темпа. Значения берутся из профиля монтажа: держать их ещё и здесь
 * означало бы два источника правды, которые рано или поздно разойдутся.
 */
export const PACING = {
  get firstVisualBy() {
    return taste().first_visual_by;
  },
  get firstVisualAfter() {
    return taste().first_visual_after;
  },
  get maxARollGap() {
    return taste().max_aroll_gap;
  },
  get minExternalCoverage() {
    return taste().min_external_coverage;
  },
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
  const byStart = [...plan.events].sort((a, b) => a.start - b.start);
  const first = byStart[0];
  if (!first) {
    errors.push("в плане нет ни одной вставки");
  } else if (first.start > PACING.firstVisualBy) {
    errors.push(`первая картинка на ${first.start.toFixed(1)}с — позже ${PACING.firstVisualBy}с, начало ролика статично`);
  }
  // сверху только картинки
  for (const e of plan.events) {
    if (e.type !== "EXTERNAL_IMAGE") errors.push(`${e.assetId}: движущаяся вставка (${e.type}) — разрешены только картинки`);
  }
  // после первой картинки дорожка непрерывна: допустим зазор не больше одного кадра
  for (let i = 1; i < byStart.length; i++) {
    const gap = byStart[i].start - byStart[i - 1].end;
    if (gap > 1 / 30 + 0.001) errors.push(`пустой верх ${gap.toFixed(2)}с между ${byStart[i - 1].assetId} и ${byStart[i].assetId}`);
  }
  if (first && plan.duration - byStart[byStart.length - 1].end > 1 / 30 + 0.001) {
    errors.push(`пустой верх в конце: последняя картинка кончается на ${byStart[byStart.length - 1].end.toFixed(1)}с из ${plan.duration.toFixed(1)}`);
  }
  // покрытие после вступления не ниже 98%
  if (first) {
    const after = plan.duration - first.start;
    const covered = byStart.reduce((n, e) => n + (e.end - e.start), 0);
    if (after > 0 && covered / after < 0.98) {
      errors.push(`после вступления картинка есть лишь ${((covered / after) * 100).toFixed(0)}% времени — нужно ≥ 98%`);
    }
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
  // Видео больше не обязательно само по себе: стиль иллюстративный, и пакет из
  // хороших проверенных фотографий с честным покрытием и разными сценами —
  // полноценная медиатека. Порог остаётся настраиваемым и по умолчанию нулевой.
  if (T.min_usable_video_segments > 0 && videos < T.min_usable_video_segments) {
    reasons.push(`видео-сегментов ${videos} < ${T.min_usable_video_segments}`);
  }
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

/**
 * Как визуал РАСПРЕДЕЛЁН по ролику, а не только сколько его всего.
 *
 * Доля 36% может означать «все 36% в середине»: именно так и вышло — двадцать
 * четыре секунды одного лица в начале, весь материал комом посередине и пустой
 * финал. Общая цифра этого не показывает, поэтому её недостаточно для решения
 * о готовности.
 *
 * Времени блоков до режиссёра ещё нет, поэтому оно оценивается по их порядку:
 * блоки идут подряд и примерно равны по длине. Для решения «хватит ли материала»
 * такой оценки достаточно.
 */
export type PackDistribution = {
  firstExternalVisualAt: number;
  maxContinuousARoll: number;
  externalCoverageFirstThird: number;
  externalCoverageMiddleThird: number;
  externalCoverageLastThird: number;
  coveredBeats: number;
  visualBeats: number;
};

export function packDistribution(
  pack: StoryAssetPackV2,
  beats: { id: string; visualNeed: string }[],
  duration: number,
): PackDistribution {
  const visual = beats.filter((b) => b.visualNeed !== "NONE");
  const per = duration / Math.max(1, visual.length);
  const best = (b: { id: string }) => pack.coverage.find((c) => c.beatId === b.id)?.bestScore ?? 0;
  // честным считаем блок с оценкой 2 и выше: «сойдёт как обстановка» провалов не закрывает
  const covered = visual.map((b) => best(b) >= 2);
  // Дыра — блок, под который нет ВООБЩЕ ничего: уплотнение после режиссёра ставит
  // в слабый блок (оценка 1) карточку-обстановку, и экран не пустует. Проект
  // «Мстителей» упирался в два соседних слабых блока при 80% сильного покрытия.
  const anything = visual.map((b) => best(b) >= 1);

  const firstIdx = covered.indexOf(true);
  const firstExternalVisualAt = firstIdx < 0 ? duration : Number((firstIdx * per).toFixed(2));

  let run = 0;
  let maxRun = 0;
  for (const c of anything) {
    run = c ? 0 : run + 1;
    maxRun = Math.max(maxRun, run);
  }

  const share = (from: number, to: number) => {
    const slice = covered.slice(from, to);
    return slice.length ? Number((slice.filter(Boolean).length / slice.length).toFixed(2)) : 0;
  };
  const t = Math.ceil(covered.length / 3);

  return {
    firstExternalVisualAt,
    maxContinuousARoll: Number((maxRun * per).toFixed(2)),
    externalCoverageFirstThird: share(0, t),
    externalCoverageMiddleThird: share(t, 2 * t),
    externalCoverageLastThird: share(2 * t, covered.length),
    coveredBeats: covered.filter(Boolean).length,
    visualBeats: visual.length,
  };
}

/**
 * Предполётная проверка перед платным вызовом режиссёра.
 *
 * Если материала не хватает на приемлемый темп, режиссёр всё равно не сможет
 * его создать — он выбирает из того, что есть. Платить за подтверждение
 * очевидного не нужно: возвращаем NEEDS_MORE_MEDIA и идём доискивать материал.
 */
export function montagePreflight(
  pack: StoryAssetPackV2,
  beats: { id: string; visualNeed: string }[],
  duration: number,
): { ok: boolean; status: "READY" | "NEEDS_MORE_MEDIA"; reasons: string[]; distribution: PackDistribution } {
  const d = packDistribution(pack, beats, duration);
  const reasons: string[] = [];
  if (d.firstExternalVisualAt > PACING.firstVisualBy) {
    reasons.push(
      `первый визуал только на ${d.firstExternalVisualAt.toFixed(1)}с — начало ролика будет статичным (предел ${PACING.firstVisualBy}с)`,
    );
  }
  // Длина блока оценивается как средняя: одна пустая дыра на длинном ролике не
  // должна проваливать проверку только из-за грубой оценки длины блока.
  const visualCount = Math.max(1, beats.filter((b) => b.visualNeed !== "NONE").length);
  const gapLimit = Math.max(PACING.maxARollGap, 1.2 * (duration / visualCount));
  if (d.maxContinuousARoll > gapLimit) {
    reasons.push(`подряд ${d.maxContinuousARoll.toFixed(1)}с без материала — предел ${gapLimit.toFixed(1)}с`);
  }
  for (const [name, v] of [
    ["начале", d.externalCoverageFirstThird],
    ["середине", d.externalCoverageMiddleThird],
    ["конце", d.externalCoverageLastThird],
  ] as const) {
    if (v < 0.34) reasons.push(`в ${name} ролика закрыто лишь ${(v * 100).toFixed(0)}% блоков`);
  }
  return { ok: reasons.length === 0, status: reasons.length === 0 ? "READY" : "NEEDS_MORE_MEDIA", reasons, distribution: d };
}
