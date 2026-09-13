import fs from "fs";
import type { Carousel, CarouselJob, Slide, SlideImage, SlideRender } from "./types";
import { CAROUSEL_LIMITS } from "./limits";
import { CarouselError, cleanupSlideFiles, finishJob, getCarousel, newId, notFound, patchJob, slideFilePath, updateCarousel, writeFileAtomic } from "./store";
import { slideContentHash } from "./hash";
import { closeBrowser, renderSlide } from "./render";
import { writeEdit, writePlan, writeSlide } from "./writer";
import type { DraftSlide } from "./prompt";
import { runPublishJob, settlePublish } from "./publishJob";
import { generateSlideImage, generateSlideImages, slidesNeedingImages, type ImageOutcome } from "./images";
import { carouselSpend } from "./spend";

/**
 * Выполнение заданий каруселей в фоновом обработчике. Каждый шаг записывается в карусель
 * сразу: прерванное задание продолжается с места остановки — готовые тексты не заказываются
 * у Claude повторно, готовые иллюстрации не оплачиваются второй раз, отрендеренные слайды
 * не рендерятся заново.
 */

type Step = (text: string, progress: number) => void;

const isNotFound = (e: unknown) => e instanceof CarouselError && e.status === 404;
const joinNotes = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(". ") || undefined;

function newImage(d: DraftSlide): SlideImage | undefined {
  if (!d.image) return undefined;
  return { brief: d.image.brief, composition: d.image.composition, textPlacement: d.image.textPlacement, versions: [], rev: 0, status: "none", attempts: 0 };
}

/**
 * Черновые слайды от Claude → слайды карусели. У существующих сохраняются id, готовый рендер
 * и все версии иллюстраций; описание иллюстрации обновляется, если Claude его изменил.
 */
function materialize(draft: DraftSlide[], existing: Slide[], illustrated: boolean): Slide[] {
  return draft.map((d) => {
    const old = d.id ? existing.find((s) => s.id === d.id) : undefined;
    let image = old?.image;
    if (illustrated) {
      if (image && d.image) {
        const changed = d.image.brief !== image.brief || d.image.composition !== image.composition || d.image.textPlacement !== image.textPlacement;
        if (changed) image = { ...image, brief: d.image.brief || image.brief, composition: d.image.composition || image.composition, textPlacement: d.image.textPlacement, rev: image.rev + 1 };
      } else if (!image) image = newImage(d);
    }
    return { id: old?.id ?? newId("s"), kind: d.kind, kicker: d.kicker, title: d.title, body: d.body, bullets: d.bullets, cta: d.cta, image, render: old?.render };
  });
}

function needsRender(c: Carousel, index: number, retryErrors: boolean): boolean {
  const s = c.slides[index];
  if (!s.render || s.render.hash !== slideContentHash(c, s, index, c.slides.length)) return true;
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
    step(`Сборка карточки ${index + 1} из ${c.slides.length}`, from + ((to - from) * k) / todo.length);
    const hash = slideContentHash(c, slide, index, c.slides.length);
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
      // карточка собрана по тому же содержимому, что и сейчас; иначе она уже устарела
      if (s && slideContentHash(x, s, x.slides.indexOf(s), x.slides.length) === hash) s.render = render;
    });
  }
  cleanupSlideFiles(id);
  step("Карточки собраны", to);
  return joinNotes(errors.length ? `Нужны правки — ${errors.join("; ")}` : undefined, shrunk.length ? `Кегль уменьшен, чтобы текст поместился: слайды ${shrunk.join(", ")}` : undefined);
}

function imageNote(outcomes: ImageOutcome[]): string | undefined {
  const failed = outcomes.filter((o) => !o.ok && !o.skipped && !o.uncertain);
  const uncertain = outcomes.filter((o) => o.uncertain);
  const notCurrent = outcomes.filter((o) => o.ok && o.notCurrent);
  return joinNotes(
    failed.length ? `Не удалось нарисовать: ${failed.map((o) => `слайд ${o.index + 1} — ${o.error}`).join("; ")}` : undefined,
    uncertain.length ? `Исход неизвестен у слайдов ${uncertain.map((o) => o.index + 1).join(", ")}: проверьте расход и повторите вручную` : undefined,
    notCurrent.length ? `Новые версии слайдов ${notCurrent.map((o) => o.index + 1).join(", ")} сохранены, но не выбраны: вы меняли эти слайды во время генерации` : undefined,
  );
}

async function runGenerate(id: string, job: CarouselJob, step: Step): Promise<string | undefined> {
  const c = getCarousel(id);
  if (!c) throw notFound();
  const illustrated = c.mode === "illustrated";
  let notes: string[] = [];
  if (job.params.stage !== "planned" || !c.slides.length) {
    step("Подготовка содержания: Claude пишет структуру, тексты и описания иллюстраций", 6);
    const plan = await writePlan(c, job.id);
    notes = plan.notes;
    updateCarousel(
      id,
      (x) => {
        x.title = plan.draft.title || x.title;
        x.story = plan.draft.story;
        x.slides = materialize(plan.draft.slides, [], illustrated);
        x.caption = plan.draft.caption;
        x.hashtags = plan.draft.hashtags;
        x.claimsToCheck = plan.draft.claimsToCheck;
        if (illustrated && plan.draft.visual) x.visual = plan.draft.visual;
        if (x.job?.id === job.id) x.job.params = { ...x.job.params, stage: "planned" };
      },
      { content: true },
    );
    step("Содержание готово", 20);
  }
  let imagesNote: string | undefined;
  if (illustrated) {
    const cur = getCarousel(id);
    if (!cur) throw notFound();
    const targets = slidesNeedingImages(cur);
    if (targets.length) imagesNote = imageNote(await generateSlideImages(id, job.id, targets, step, [22, 84]));
  }
  const renderNote = await renderPending(id, step, 86, 98);
  return joinNotes(notes.length ? `Замечания проверки текста: ${notes.slice(0, 4).join("; ")}` : undefined, imagesNote, renderNote);
}

async function runImages(id: string, job: CarouselJob, step: Step): Promise<string | undefined> {
  const c = getCarousel(id);
  if (!c) throw notFound();
  if (c.mode !== "illustrated") throw new Error("У текстовой карусели нет иллюстраций");
  const wanted = job.params.slideIds?.length ? job.params.slideIds : slidesNeedingImages(c, Boolean(job.params.includeUncertain));
  const targets = c.slides.filter((s) => wanted.includes(s.id)).map((s) => s.id);
  const note = targets.length ? imageNote(await generateSlideImages(id, job.id, targets, step, [5, 84], { includeUncertain: job.params.includeUncertain })) : "Все иллюстрации уже на месте";
  return joinNotes(note, await renderPending(id, step, 86, 98));
}

async function runImage(id: string, job: CarouselJob, step: Step): Promise<string | undefined> {
  const c = getCarousel(id);
  if (!c) throw notFound();
  const index = c.slides.findIndex((s) => s.id === job.params.slideId);
  if (index < 0) throw new Error("Слайд не найден — возможно, его удалили");
  const edit = job.params.mode === "edit";
  step(edit ? `Правка иллюстрации слайда ${index + 1}` : `Новая иллюстрация слайда ${index + 1}`, 10);
  const out = await generateSlideImage(id, job.id, job.params.slideId!, { mode: edit ? "edit" : "generate", instruction: job.params.instruction, hint: job.params.hint, includeUncertain: true });
  if (!out.ok && !out.uncertain) throw new Error(out.error ?? "иллюстрация не получена");
  const note = out.uncertain ? `Слайд ${index + 1}: ${out.error}` : out.notCurrent ? `Новая версия слайда ${index + 1} сохранена, но не выбрана: слайд менялся во время генерации` : `Слайд ${index + 1}: ${edit ? "иллюстрация изменена" : "новая иллюстрация"}`;
  return joinNotes(note, await renderPending(id, step, 60, 98));
}

async function runRegenerate(id: string, job: CarouselJob, step: Step): Promise<string | undefined> {
  const c = getCarousel(id);
  if (!c) throw notFound();
  const index = c.slides.findIndex((s) => s.id === job.params.slideId);
  if (index < 0) throw new Error("Слайд для перегенерации не найден — возможно, его удалили");
  step(`Claude переписывает слайд ${index + 1}`, 8);
  const r = await writeSlide(c, index, job.params.hint ?? "", job.id);
  updateCarousel(
    id,
    (x) => {
      const s = x.slides.find((y) => y.id === job.params.slideId);
      if (!s) return;
      Object.assign(s, { kicker: r.slide.kicker, title: r.slide.title, body: r.slide.body, bullets: r.slide.bullets, cta: r.slide.cta });
      if (x.mode === "illustrated" && r.slide.image) {
        if (s.image) s.image = { ...s.image, brief: r.slide.image.brief || s.image.brief, composition: r.slide.image.composition || s.image.composition, textPlacement: r.slide.image.textPlacement, rev: s.image.rev + 1 };
        else s.image = newImage(r.slide);
      }
      if (r.claims.length) x.claimsToCheck = [...new Set([...x.claimsToCheck, ...r.claims])].slice(0, CAROUSEL_LIMITS.claimsMax);
    },
    { content: true },
  );
  let imagesNote: string | undefined;
  if (c.mode === "illustrated" && (job.params.withImage || !c.slides[index].image?.versions.length)) {
    step(`Иллюстрация слайда ${index + 1}`, 40);
    imagesNote = imageNote([await generateSlideImage(id, job.id, job.params.slideId!, { mode: "generate", includeUncertain: true })]);
  }
  return joinNotes(`Слайд ${index + 1} переписан`, imagesNote, await renderPending(id, step, 70, 98));
}

async function runInstruct(id: string, job: CarouselJob, step: Step): Promise<string | undefined> {
  const c = getCarousel(id);
  if (!c) throw notFound();
  step("Claude выполняет поручение", 8);
  const { draft, notes } = await writeEdit(c, job.params.instruction ?? "", job.id);
  const illustrated = c.mode === "illustrated";
  updateCarousel(
    id,
    (x) => {
      x.slides = materialize(draft.slides, x.slides, illustrated);
      x.caption = draft.caption || x.caption;
      x.hashtags = draft.hashtags.length ? draft.hashtags : x.hashtags;
      x.claimsToCheck = draft.claimsToCheck;
    },
    { content: true },
  );
  let imagesNote: string | undefined;
  if (illustrated) {
    const cur = getCarousel(id);
    if (!cur) throw notFound();
    // новые карточки получают иллюстрации; у существующих картинки остаются, даже если описание уточнилось
    const targets = cur.slides.filter((s) => s.image && !s.image.versions.length).map((s) => s.id);
    if (targets.length) imagesNote = imageNote(await generateSlideImages(id, job.id, targets, step, [30, 84]));
  }
  const renderNote = await renderPending(id, step, 86, 98);
  return joinNotes(draft.summary || "Поручение выполнено", notes.length ? `Замечания: ${notes.slice(0, 3).join("; ")}` : undefined, imagesNote, renderNote);
}

export async function executeJob(id: string, job: CarouselJob): Promise<void> {
  const step: Step = (text, progress) => patchJob(id, job.id, { step: text, progress });
  // итог по карусели — из журнала раздела: там и факт, и оценка при неизвестном исходе
  const saveCost = () => {
    try {
      const spend = carouselSpend(id);
      updateCarousel(id, (c) => {
        c.cost = { ...spend, legacyUsd: c.cost.legacyUsd, usd: Number((spend.usd + (c.cost.legacyUsd ?? 0)).toFixed(4)) };
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
    else if (job.type === "images") note = await runImages(id, job, step);
    else if (job.type === "image") note = await runImage(id, job, step);
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
