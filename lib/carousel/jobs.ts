import fs from "fs";
import { resetLedger, summarize } from "../costLedger";
import type { Carousel, CarouselJob, Slide, SlideRender } from "./types";
import { CAROUSEL_LIMITS } from "./limits";
import { CarouselError, cleanupSlideFiles, finishJob, getCarousel, newId, notFound, patchJob, slideFilePath, updateCarousel, writeFileAtomic } from "./store";
import { slideHash } from "./templates";
import { closeBrowser, renderSlide } from "./render";
import { writeEdit, writePlan, writeSlide } from "./writer";
import type { DraftSlide } from "./prompt";
import { runPublishJob, settlePublish } from "./publishJob";

/**
 * Выполнение заданий каруселей в фоновом обработчике. Каждый шаг записывается в карусель
 * сразу: прерванное задание продолжается с места остановки — готовые тексты не заказываются
 * у Claude повторно, отрендеренные слайды не рендерятся заново.
 */

type Step = (text: string, progress: number) => void;

const isNotFound = (e: unknown) => e instanceof CarouselError && e.status === 404;
const joinNotes = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(". ") || undefined;

/** Черновые слайды от Claude → слайды карусели: у существующих сохраняются id и готовый рендер. */
function materialize(draft: DraftSlide[], existing: Slide[]): Slide[] {
  return draft.map((d) => {
    const old = d.id ? existing.find((s) => s.id === d.id) : undefined;
    return { id: old?.id ?? newId("s"), kind: d.kind, kicker: d.kicker, title: d.title, body: d.body, bullets: d.bullets, cta: d.cta, render: old?.render };
  });
}

function needsRender(c: Carousel, index: number, retryErrors: boolean): boolean {
  const s = c.slides[index];
  if (!s.render || s.render.hash !== slideHash(c, s, index, c.slides.length)) return true;
  if (s.render.error) return retryErrors;
  return !s.render.file || !fs.existsSync(slideFilePath(c.id, s.render.file));
}

async function renderPending(id: string, step: Step, from: number, to: number, retryErrors = false): Promise<string | undefined> {
  const start = getCarousel(id);
  if (!start) throw notFound();
  const todo = start.slides.filter((_, i) => needsRender(start, i, retryErrors)).map((s) => s.id);
  const errors: string[] = [];
  const shrunk: number[] = [];
  for (let k = 0; k < todo.length; k++) {
    const c = getCarousel(id);
    if (!c) throw notFound();
    const index = c.slides.findIndex((s) => s.id === todo[k]);
    if (index < 0) continue;
    const slide = c.slides[index];
    step(`Рендер слайда ${index + 1} из ${c.slides.length}`, from + ((to - from) * k) / todo.length);
    const hash = slideHash(c, slide, index, c.slides.length);
    const out = await renderSlide(c, slide, index, c.slides.length);
    let render: SlideRender;
    if (out.ok) {
      const file = `slide-${slide.id}-${hash.slice(0, 12)}.jpg`;
      if (!getCarousel(id)) throw notFound();
      writeFileAtomic(slideFilePath(id, file), out.buffer);
      render = { hash, file, width: out.width, height: out.height, bytes: out.buffer.length, scale: out.scale, at: new Date().toISOString() };
      if (out.scale < 1) shrunk.push(index + 1);
    } else {
      render = { hash, at: new Date().toISOString(), error: out.error };
      errors.push(`слайд ${index + 1}: ${out.error}`);
    }
    updateCarousel(id, (x) => {
      const s = x.slides.find((y) => y.id === slide.id);
      if (s) s.render = render;
    });
  }
  cleanupSlideFiles(id);
  step("Слайды готовы", to);
  return joinNotes(errors.length ? `Нужны правки — ${errors.join("; ")}` : undefined, shrunk.length ? `Кегль уменьшен, чтобы текст поместился: слайды ${shrunk.join(", ")}` : undefined);
}

async function runGenerate(id: string, job: CarouselJob, step: Step): Promise<string | undefined> {
  const c = getCarousel(id);
  if (!c) throw notFound();
  let notes: string[] = [];
  if (job.params.stage !== "planned" || !c.slides.length) {
    step("Claude пишет структуру, слайды и подпись", 8);
    const plan = await writePlan(c.request);
    notes = plan.notes;
    updateCarousel(
      id,
      (x) => {
        x.title = plan.draft.title || x.title;
        x.story = plan.draft.story;
        x.slides = materialize(plan.draft.slides, []);
        x.caption = plan.draft.caption;
        x.hashtags = plan.draft.hashtags;
        x.claimsToCheck = plan.draft.claimsToCheck;
        if (x.job?.id === job.id) x.job.params = { ...x.job.params, stage: "planned" };
      },
      { content: true },
    );
    step("Тексты готовы", 40);
  }
  const renderNote = await renderPending(id, step, 45, 98);
  return joinNotes(notes.length ? `Замечания проверки текста: ${notes.slice(0, 4).join("; ")}` : undefined, renderNote);
}

async function runRegenerate(id: string, job: CarouselJob, step: Step): Promise<string | undefined> {
  const c = getCarousel(id);
  if (!c) throw notFound();
  const index = c.slides.findIndex((s) => s.id === job.params.slideId);
  if (index < 0) throw new Error("Слайд для перегенерации не найден — возможно, его удалили");
  step(`Claude переписывает слайд ${index + 1}`, 10);
  const r = await writeSlide(c, index, job.params.hint ?? "");
  updateCarousel(
    id,
    (x) => {
      const s = x.slides.find((y) => y.id === job.params.slideId);
      if (!s) return;
      Object.assign(s, { kicker: r.slide.kicker, title: r.slide.title, body: r.slide.body, bullets: r.slide.bullets, cta: r.slide.cta });
      if (r.claims.length) x.claimsToCheck = [...new Set([...x.claimsToCheck, ...r.claims])].slice(0, CAROUSEL_LIMITS.claimsMax);
    },
    { content: true },
  );
  return joinNotes(`Слайд ${index + 1} переписан`, await renderPending(id, step, 50, 98));
}

async function runInstruct(id: string, job: CarouselJob, step: Step): Promise<string | undefined> {
  const c = getCarousel(id);
  if (!c) throw notFound();
  step("Claude выполняет поручение", 10);
  const { draft, notes } = await writeEdit(c, job.params.instruction ?? "");
  updateCarousel(
    id,
    (x) => {
      x.slides = materialize(draft.slides, x.slides);
      x.caption = draft.caption || x.caption;
      x.hashtags = draft.hashtags.length ? draft.hashtags : x.hashtags;
      x.claimsToCheck = draft.claimsToCheck;
    },
    { content: true },
  );
  const renderNote = await renderPending(id, step, 45, 98);
  return joinNotes(draft.summary || "Поручение выполнено", notes.length ? `Замечания: ${notes.slice(0, 3).join("; ")}` : undefined, renderNote);
}

export async function executeJob(id: string, job: CarouselJob): Promise<void> {
  // учёт этого процесса — только своё задание: цена карусели считается отдельно от роликов
  resetLedger();
  const step: Step = (text, progress) => patchJob(id, job.id, { step: text, progress });
  let costSaved = false;
  // расход записывается до отметки об окончании: интерфейс видит итог вместе с результатом
  const saveCost = () => {
    if (costSaved) return;
    costSaved = true;
    const { totals } = summarize();
    if (totals.variableApiCost <= 0 && totals.llmCalls <= 0) return;
    try {
      updateCarousel(id, (c) => {
        c.cost = { usd: Number((c.cost.usd + totals.variableApiCost).toFixed(4)), calls: c.cost.calls + totals.llmCalls };
      });
    } catch {}
  };
  try {
    if (job.type === "publish" || job.type === "verify_publish") {
      step(job.type === "publish" ? "Публикация в Instagram" : "Проверка публикации", 5);
      const state = await runPublishJob(id, job.type === "publish" ? "publish" : "verify", (text) => step(text, 50));
      if (state.status === "published") finishJob(id, job.id, "done", { note: state.note ?? "Карусель опубликована" });
      else finishJob(id, job.id, "error", { error: state.error ?? "Публикация не завершена" });
      return;
    }
    let note: string | undefined;
    if (job.type === "generate") note = await runGenerate(id, job, step);
    else if (job.type === "render") note = await renderPending(id, step, 5, 98, true);
    else if (job.type === "regenerate_slide") note = await runRegenerate(id, job, step);
    else if (job.type === "instruct") note = await runInstruct(id, job, step);
    saveCost();
    finishJob(id, job.id, "done", { note });
  } catch (e) {
    if (isNotFound(e)) return;
    const message = String((e as any)?.message ?? e).replace(/\s+/g, " ").slice(0, 500);
    saveCost();
    try {
      if (job.type === "publish" || job.type === "verify_publish") settlePublish(id, `Сбой публикации: ${message}`);
      finishJob(id, job.id, "error", { error: message });
    } catch {}
  } finally {
    saveCost();
    await closeBrowser();
  }
}
