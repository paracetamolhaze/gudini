import type { Carousel } from "./types";
import { carouselApiKey, KEY_ENV, textModel, textTimeoutMs } from "./config";
import { chatText, OpenRouterError } from "./openrouter";
import { textEstimate } from "./models";
import { reserveSpend, settleSpend } from "./spend";
import { CarouselError } from "./store";
import {
  editProblems,
  editSystem,
  extractJson,
  fitSlideCount,
  generationSystem,
  generationUser,
  instructUser,
  normalizeDraft,
  normalizeRegenerated,
  regenerateSystem,
  regenerateUser,
  repairUser,
  type Draft,
  type Parsed,
} from "./prompt";

/**
 * Обращения к Claude для каруселей — через собственный клиент OpenRouter раздела (свой ключ
 * CAROUSEL_OPENROUTER_API_KEY, модель CAROUSEL_TEXT_MODEL). Общий транспорт сайта, ключи
 * видео и обложек здесь не используются, и запасного перехода на них нет.
 *
 * Каждый запрос резервируется в журнале раздела по оценке и закрывается фактической ценой.
 * Исправление по замечаниям — не больше одного дополнительного запроса; повтор при сбое —
 * один и только при подтверждённой временной ошибке (неизвестный исход не повторяется).
 */

type TextKind = "plan" | "edit" | "slide";
type Ctx = { carousel: Carousel; jobId: string; runLabel: string };

function requireConfig(): string {
  if (!carouselApiKey()) throw new CarouselError(`Требуется ключ OpenRouter для каруселей (${KEY_ENV}) — запрос к Claude не отправлялся`, 503, "config");
  const t = textModel();
  if (t.problem) throw new CarouselError(t.problem, 503, "config");
  return t.id;
}

function describe(e: unknown): string {
  if (e instanceof OpenRouterError) return `Claude через OpenRouter: ${e.message}`;
  return String((e as any)?.message ?? e);
}

async function ask(ctx: Ctx, kind: TextKind, label: string, system: string, user: string, maxTokens: number): Promise<string> {
  const model = requireConfig();
  const attempt = async (retry: boolean): Promise<string> => {
    const entry = reserveSpend({
      carouselId: ctx.carousel.id,
      title: ctx.carousel.title,
      kind: "text",
      label: retry ? `${label} (повтор)` : label,
      runLabel: ctx.runLabel,
      model,
      estimate: textEstimate(model, kind),
      jobId: ctx.jobId,
    });
    try {
      const r = await chatText({ model, system, user, maxTokens, timeoutMs: textTimeoutMs() });
      settleSpend(entry.id, { status: "done", cost: r.cost });
      return r.text;
    } catch (e) {
      if (e instanceof OpenRouterError) settleSpend(entry.id, { status: e.uncertain ? "uncertain" : "failed", cost: e.uncertain ? null : (e.cost ?? 0), note: e.message });
      else settleSpend(entry.id, { status: "failed", cost: 0, note: String((e as any)?.message ?? e).slice(0, 200) });
      throw e;
    }
  };
  try {
    return await attempt(false);
  } catch (e) {
    if (e instanceof OpenRouterError && e.retryable && !e.uncertain) return attempt(true);
    if (e instanceof OpenRouterError) throw new Error(describe(e));
    throw e;
  }
}

/** Из двух разборов лучший: меньше непоправимого, затем меньше замечаний. */
const better = (a: Parsed, b: Parsed): Parsed =>
  b.fatal.length < a.fatal.length || (b.fatal.length === a.fatal.length && b.problems.length <= a.problems.length) ? b : a;

/** Замечания, которые стоит показать автору: длину окончательно проверяет рендер. */
const visibleNotes = (problems: string[]) => problems.filter((p) => !/символов при пределе/.test(p));

export async function writePlan(c: Carousel, jobId: string): Promise<{ draft: Draft; notes: string[] }> {
  const ctx: Ctx = { carousel: c, jobId, runLabel: "Карусель: генерация" };
  const illustrated = c.mode === "illustrated";
  const req = c.request;
  const user = generationUser(req, { illustrated, illustrationStyle: c.design?.illustrationStyle });
  const system = generationSystem(illustrated);
  const parse = (raw: string) => normalizeDraft(extractJson(raw), { expectedCount: req.slideCount, illustrated });
  let parsed = parse(await ask(ctx, "plan", "План карусели", system, user, 16000));
  if (parsed.problems.length || parsed.fatal.length) {
    const raw = await ask(ctx, "plan", "Исправление плана", system, `${user}\n\n${repairUser(parsed.draft, [...parsed.fatal, ...parsed.problems])}`, 16000);
    try {
      parsed = better(parsed, parse(raw));
    } catch {}
  }
  if (parsed.fatal.length) throw new Error(`Claude вернул негодную карусель: ${parsed.fatal.join("; ")}`);
  return { draft: fitSlideCount(parsed.draft, req.slideCount), notes: visibleNotes(parsed.problems) };
}

export async function writeEdit(c: Carousel, instruction: string, jobId: string): Promise<{ draft: Draft; notes: string[] }> {
  const ctx: Ctx = { carousel: c, jobId, runLabel: "Карусель: правка" };
  const illustrated = c.mode === "illustrated";
  const user = instructUser(c, instruction);
  const system = editSystem(illustrated);
  // замечания только к тому, что правка изменила: нетронутые карточки остаются как были
  const parse = (raw: string): Parsed => {
    const p = normalizeDraft(extractJson(raw), { existing: c.slides, illustrated });
    return { ...p, problems: editProblems(p, c) };
  };
  let parsed = parse(await ask(ctx, "edit", "Правка по поручению", system, user, 16000));
  if (parsed.problems.length || parsed.fatal.length) {
    const raw = await ask(ctx, "edit", "Исправление правки", system, `${user}\n\n${repairUser(parsed.draft, [...parsed.fatal, ...parsed.problems])}`, 16000);
    try {
      parsed = better(parsed, parse(raw));
    } catch {}
  }
  if (parsed.fatal.length) throw new Error(`Claude вернул негодную правку: ${parsed.fatal.join("; ")}`);
  return { draft: parsed.draft, notes: visibleNotes(parsed.problems) };
}

export async function writeSlide(c: Carousel, index: number, hint: string, jobId: string) {
  const ctx: Ctx = { carousel: c, jobId, runLabel: "Карусель: слайд" };
  const illustrated = c.mode === "illustrated";
  const user = regenerateUser(c, index, hint);
  const system = regenerateSystem(illustrated);
  let r = normalizeRegenerated(extractJson(await ask(ctx, "slide", `Текст слайда ${index + 1}`, system, user, 8000)), c, index, illustrated);
  if (r.problems.length || r.fatal.length) {
    const raw = await ask(ctx, "slide", `Исправление слайда ${index + 1}`, system, `${user}\n\n${repairUser({ slide: r.slide }, [...r.fatal, ...r.problems])}`, 8000);
    try {
      const again = normalizeRegenerated(extractJson(raw), c, index, illustrated);
      if (again.fatal.length < r.fatal.length || (again.fatal.length === r.fatal.length && again.problems.length <= r.problems.length)) r = again;
    } catch {}
  }
  if (r.fatal.length) throw new Error("Claude вернул карточку без заголовка");
  return r;
}
