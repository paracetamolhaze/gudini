import { mediaComplete, mediaLlmAvailable, mediaTransport } from "../mediaLlm";
import type { Carousel, CarouselRequest } from "./types";
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
 * Обращения к Claude для каруселей — через общий транспорт сайта (lib/mediaLlm:
 * MEDIA_LLM_TRANSPORT, политика провайдеров, учёт токенов). Своего клиента нет.
 * Вызывается только из фонового обработчика: у него свой учёт, он не смешивается с
 * расходами видеопроектов в процессе сайта.
 *
 * Текст пишет Opus (как сценарии роликов), исправления по замечаниям и правки — Sonnet.
 * Исправление — не больше одного дополнительного запроса.
 */

const MODEL_WRITE = "claude-opus-5";
const MODEL_EDIT = "claude-sonnet-5";
const STAGE = "Script Generation" as const;

function ensureLlm() {
  if (mediaLlmAvailable()) return;
  throw new Error(
    mediaTransport() === "openrouter"
      ? "Claude недоступен: MEDIA_LLM_TRANSPORT=openrouter, а ключ OPENROUTER_CLAUDE_KEY не задан — генерация не запускалась"
      : "Claude недоступен: нет ключа Anthropic (ANTHROPIC_API_KEY или «Настройки») — генерация не запускалась",
  );
}

const ask = (system: string, user: string, model: string, maxTokens: number) => mediaComplete({ system, user, model, maxTokens, stage: STAGE });

/** Из двух разборов лучший: меньше непоправимого, затем меньше замечаний. */
const better = (a: Parsed, b: Parsed): Parsed =>
  b.fatal.length < a.fatal.length || (b.fatal.length === a.fatal.length && b.problems.length <= a.problems.length) ? b : a;

/** Замечания, которые стоит показать автору: длину окончательно проверяет рендер. */
const visibleNotes = (problems: string[]) => problems.filter((p) => !/символов при пределе/.test(p));

export async function writePlan(req: CarouselRequest): Promise<{ draft: Draft; notes: string[] }> {
  ensureLlm();
  const user = generationUser(req);
  let parsed = normalizeDraft(extractJson(await ask(generationSystem(), user, MODEL_WRITE, 16000)), { expectedCount: req.slideCount });
  if (parsed.problems.length || parsed.fatal.length) {
    const raw = await ask(generationSystem(), `${user}\n\n${repairUser(parsed.draft, [...parsed.fatal, ...parsed.problems])}`, MODEL_EDIT, 16000);
    try {
      parsed = better(parsed, normalizeDraft(extractJson(raw), { expectedCount: req.slideCount }));
    } catch {}
  }
  if (parsed.fatal.length) throw new Error(`Claude вернул негодную карусель: ${parsed.fatal.join("; ")}`);
  return { draft: fitSlideCount(parsed.draft, req.slideCount), notes: visibleNotes(parsed.problems) };
}

export async function writeEdit(c: Carousel, instruction: string): Promise<{ draft: Draft; notes: string[] }> {
  ensureLlm();
  const user = instructUser(c, instruction);
  // замечания только к тому, что правка изменила: нетронутые карточки остаются как были
  const parse = (raw: string): Parsed => {
    const p = normalizeDraft(extractJson(raw), { existing: c.slides });
    return { ...p, problems: editProblems(p, c) };
  };
  let parsed = parse(await ask(editSystem(), user, MODEL_EDIT, 16000));
  if (parsed.problems.length || parsed.fatal.length) {
    const raw = await ask(editSystem(), `${user}\n\n${repairUser(parsed.draft, [...parsed.fatal, ...parsed.problems])}`, MODEL_EDIT, 16000);
    try {
      parsed = better(parsed, parse(raw));
    } catch {}
  }
  if (parsed.fatal.length) throw new Error(`Claude вернул негодную правку: ${parsed.fatal.join("; ")}`);
  return { draft: parsed.draft, notes: visibleNotes(parsed.problems) };
}

export async function writeSlide(c: Carousel, index: number, hint: string) {
  ensureLlm();
  const user = regenerateUser(c, index, hint);
  let r = normalizeRegenerated(extractJson(await ask(regenerateSystem(), user, MODEL_EDIT, 8000)), c, index);
  if (r.problems.length || r.fatal.length) {
    const raw = await ask(regenerateSystem(), `${user}\n\n${repairUser({ slide: r.slide }, [...r.fatal, ...r.problems])}`, MODEL_EDIT, 8000);
    try {
      const again = normalizeRegenerated(extractJson(raw), c, index);
      if (again.fatal.length < r.fatal.length || (again.fatal.length === r.fatal.length && again.problems.length <= r.problems.length)) r = again;
    } catch {}
  }
  if (r.fatal.length) throw new Error("Claude вернул карточку без заголовка");
  return r;
}
