import type { Carousel, JobType } from "./types";
import { IG_LIMITS } from "./limits";
import { captionProblems } from "./text";
import { slideContentHash } from "./hash";
import { isJobLive, isJobPending } from "./store";
import { imageSummary } from "./images";
import { scheduleSummary } from "./schedule";
import { formatInZone } from "./timezone";

/** То, что видит интерфейс: карусель плюс вычисленные состояние и готовность к публикации. */

export type StatusTone = "neutral" | "success" | "warn" | "error" | "accent";

export const JOB_LABELS: Record<JobType, string> = {
  generate: "Генерация",
  render: "Сборка карточек",
  regenerate_slide: "Перегенерация слайда",
  instruct: "Правка по поручению",
  images: "Иллюстрации",
  image: "Иллюстрация слайда",
  publish: "Публикация в Instagram",
  verify_publish: "Проверка публикации",
};

export function isStale(c: Carousel, index: number): boolean {
  const s = c.slides[index];
  return !s.render || s.render.hash !== slideContentHash(c, s, index, c.slides.length);
}

const hasCurrentImage = (c: Carousel, i: number) => {
  const img = c.slides[i].image;
  return Boolean(img && img.versions.some((v) => v.id === img.currentId));
};

export function carouselStatus(c: Carousel): { text: string; tone: StatusTone; busy?: boolean } {
  const job = c.job;
  if (job && isJobPending(job)) {
    const text =
      job.type === "publish"
        ? "Публикуется"
        : job.type === "verify_publish"
          ? "Проверка публикации"
          : !c.slides.length
            ? "Генерируется"
            : job.type === "images" || job.type === "image"
              ? "Иллюстрации"
              : job.type === "render"
                ? "Сборка карточек"
                : "Обновляется";
    return { text: job.state === "queued" ? `${text} · в очереди` : text, tone: "accent", busy: true };
  }
  if (c.publish.status === "published") return { text: "Опубликовано", tone: "success" };
  if (c.publish.status === "uncertain") return { text: "Публикация не подтверждена", tone: "warn" };
  if (c.publish.status === "failed" || (job?.state === "error" && (job.type === "publish" || job.type === "verify_publish"))) {
    return { text: "Ошибка публикации", tone: "error" };
  }
  const sc = c.schedule;
  if (sc?.status === "scheduled") return { text: `Запланировано · ${formatInZone(Date.parse(sc.runAt), sc.timeZone)}`, tone: "accent" };
  if (sc?.status === "missed") return { text: "Публикация просрочена", tone: "warn" };
  if (job?.state === "error") return { text: c.slides.length ? "Ошибка задания" : "Ошибка генерации", tone: "error" };
  if (!c.slides.length) return { text: "Черновик", tone: "neutral" };
  if (c.mode === "illustrated") {
    const img = imageSummary(c);
    if (img.uncertain) return { text: "Исход генерации неизвестен", tone: "warn" };
    if (img.failed) return { text: `Нет иллюстраций: ${img.failed} из ${img.total}`, tone: "warn" };
  }
  if (c.slides.some((s) => s.render?.error)) return { text: "Нужны правки", tone: "warn" };
  if (c.slides.some((s, i) => isStale(c, i) || !s.render?.file)) return { text: "Не собрано", tone: "warn" };
  return { text: "Готово", tone: "success" };
}

/** Что мешает публикации. Пустой список — карусель можно отправлять в Instagram. */
export function publishReadiness(c: Carousel): string[] {
  const p: string[] = [];
  if (isJobPending(c.job)) p.push("Дождитесь окончания текущего задания");
  if (c.slides.length < IG_LIMITS.minItems) p.push(`В карусели должно быть не меньше ${IG_LIMITS.minItems} слайдов`);
  if (c.slides.length > IG_LIMITS.maxItems) p.push(`Instagram принимает не больше ${IG_LIMITS.maxItems} слайдов`);
  c.slides.forEach((s, i) => {
    if (c.mode === "illustrated" && !hasCurrentImage(c, i)) p.push(`Слайд ${i + 1}: нет иллюстрации`);
    else if (isStale(c, i)) p.push(`Слайд ${i + 1} не собран после изменений`);
    else if (s.render?.error) p.push(`Слайд ${i + 1}: ${s.render.error}`);
    else if (!s.render?.file) p.push(`Слайд ${i + 1}: нет картинки`);
  });
  for (const x of captionProblems(c.caption, c.hashtags)) p.push(`Подпись: ${x}`);
  return p;
}

export function toClient(c: Carousel) {
  return {
    carousel: c,
    status: carouselStatus(c),
    readiness: publishReadiness(c),
    staleSlideIds: c.slides.filter((_, i) => isStale(c, i)).map((s) => s.id),
    jobInterrupted: isJobPending(c.job) && !isJobLive(c.job),
    images: c.mode === "illustrated" ? imageSummary(c) : null,
    schedule: scheduleSummary(c),
  };
}

export function toSummary(c: Carousel) {
  const sc = scheduleSummary(c);
  return {
    id: c.id,
    title: c.title,
    idea: c.request.idea.slice(0, 200),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    format: c.format,
    mode: c.mode,
    slideCount: c.slides.length,
    cover: c.slides[0]?.render?.file ?? null,
    status: carouselStatus(c),
    permalink: c.publish.permalink ?? null,
    costUsd: c.cost.usd,
    schedule: sc ? { status: sc.status, when: sc.when, runAt: sc.runAt, account: sc.account.label ?? sc.account.igUserId, permalink: sc.permalink, error: sc.error, stale: sc.stale } : null,
  };
}
