import { eventCovered, voiceOnlyEvent } from "./audit";
import type { AiFilmPlan, PlanIssue, StoryEvent } from "./types";

/**
 * Единые критерии: по ним планировщику даётся второй заход, по ним же план не пускается
 * к оплате и по ним же выбирается лучший из двух планов.
 *
 * Раньше критериев было два разных набора. Исправление искало строки предупреждений
 * регулярными выражениями, а ворота перед генерацией смотрели только на типизированные
 * нарушения. Известная склейка внутри непрерывного кадра попадала в первый набор и
 * не попадала во второй, поэтому план с ней доходил до запуска Veo. Переименование
 * предупреждения тихо отключало исправление.
 */

/**
 * Предупреждения, которых достаточно для второго захода, но недостаточно для запрета
 * генерации: ролик с поздним началом смотрибелен, а вот кадра с невыполнимым указанием
 * не существует вовсе.
 */
export const RETRY_WARN_CODES = new Set(["first-scene-late", "author-stretch-long", "anchor-outside-shot", "beat-multiple-events", "scene-out-of-order", "change-without-cause", "prop-asserts-end-state", "hold-outside-window", "absent-before-but-present", "scene-without-visual-task", "explanation-faked-proof", "explanation-hides-event", "repeated-visual-task", "duplicate-visual-tasks", "author-flicker", "author-stretch-explained", "no-visual-tasks"]);

/** Нарушения, запрещающие оплату. */
export function gateIssues(plan: Pick<AiFilmPlan, "issues">): PlanIssue[] {
  return (plan.issues ?? []).filter((i) => i.severity === "block");
}

/** Нарушения, оправдывающие второй заход планировщика. */
export function retryIssues(plan: Pick<AiFilmPlan, "issues">): PlanIssue[] {
  return (plan.issues ?? []).filter((i) => i.severity === "block" || RETRY_WARN_CODES.has(i.code));
}

/** Обязательные события с проверяемым доказательством. */
export function requiredEvents(events: StoryEvent[] | undefined): StoryEvent[] {
  return (events ?? []).filter((e) => e.required && e.id && e.objects.length);
}

/**
 * Какие обязательные события ИСХОДНОГО контракта план не показывает. Проверяется по
 * конечным запросам: бит мог остаться в таймлайне, но не попасть ни в один клип.
 */
export function missingRequired(
  plan: Pick<AiFilmPlan, "beats" | "shots"> & { bible?: { authorCarried?: string[] } },
  required: StoryEvent[],
): string[] {
  const carried = new Set(plan.bible?.authorCarried ?? []);
  return required.filter((e) => !carried.has(e.id) && !eventCovered(e, plan.beats, plan.shots)).map((e) => e.id);
}

/**
 * Обязательные события, чьи реплики планировщик сам отдал объяснению И которые честно не снять:
 * право, статус, сумма, причина. Их несёт голос автора — требовать под них сцену значит снова
 * получить выдуманный штамп. Действие с предметом (разрыв купола, вскрытие посылки, передача
 * ключа) голосу не отдаётся, как бы речь его ни называла: обязательность для рассказа и
 * обязательность показа — разные вещи, и метка «объяснение» вторую не снимает.
 */
export function authorCarriedEvents(bible: {
  events?: StoryEvent[];
  visualTasks?: { role: string; fromPhrase: number; toPhrase: number }[];
}): string[] {
  const explained = new Set<number>();
  for (const t of bible.visualTasks ?? []) {
    if (t.role !== "explanation") continue;
    for (let i = t.fromPhrase; i <= Math.min(t.toPhrase, t.fromPhrase + 500); i++) explained.add(i);
  }
  if (!explained.size) return [];
  return (bible.events ?? [])
    .filter((e) => e.required && e.id && voiceOnlyEvent(e))
    .filter((e) => {
      for (let i = e.fromPhrase; i <= Math.min(e.toPhrase, e.fromPhrase + 500); i++) if (!explained.has(i)) return false;
      return true;
    })
    .map((e) => e.id);
}

/**
 * Второй заход не имеет права ослаблять контракт. Модель, получив список нарушений,
 * охотно снимала обязательность вместо того, чтобы переставить сцену, и проверка
 * становилась зелёной на пустом месте. Обязательный набор первого захода возвращается
 * целиком: снятый флаг ставится назад, удалённое событие добавляется обратно.
 */
export function preserveRequired(original: StoryEvent[] | undefined, next: StoryEvent[] | undefined): StoryEvent[] {
  const out = [...(next ?? [])];
  for (const was of requiredEvents(original)) {
    // То же обязательство под другим именем возвращать нельзя: переименованное событие
    // добавлялось вторым, и одно из двух оставалось непоказанным навсегда. Совпадением
    // считается тот же предмет с тем же обещанным результатом.
    const renamed = out.some(
      (e) => e.id !== was.id && e.objects.some((o) => was.objects.some((w) => o.id === w.id && sameGoal(o.after, w.after))),
    );
    if (renamed) continue;
    const at = out.findIndex((e) => e.id === was.id);
    // Возвращается всё обязательство целиком, а не только идентификатор и флаг.
    // Сохранение одного id ничего не давало: второй заход оставлял «review» обязательным,
    // подменяя «отправить отзыв» на «положить телефон на стол», и такой план проходил
    // проверку — обещанного перехода в контракте уже не было.
    if (at < 0) out.push({ ...was });
    else out[at] = { ...was, fromPhrase: out[at].fromPhrase, toPhrase: out[at].toPhrase };
  }
  return out;
}

/**
 * Место плана в очереди: сравниваются по тяжести, а не по числу строк. Сначала запреты
 * оплаты, потом потерянные обязательные события, потом поводы для второго захода, и лишь
 * в самом конце — покрытие. Прежнее сравнение складывало блокировки и предупреждения в
 * один массив и сравнивало длину: план с одной блокировкой выигрывал у плана без блокировок,
 * но с двумя предупреждениями.
 */
export function planRank(plan: AiFilmPlan, required: StoryEvent[]): number[] {
  return [
    // Потерянные обязательства идут ПЕРВЫМИ и считаются по событиям, а не по строкам:
    // одно сообщение «не показаны» может нести и два события, и пять. Второй заход
    // выигрывал у первого, потеряв ещё три обязательных события, потому что число
    // сообщений уменьшилось на одно.
    missingRequired(plan, required).length,
    blockingWeight(plan),
    retryIssues(plan).length,
    (plan.issues ?? []).length,
    -Math.round((plan.stats?.coverage ?? 0) * 1000),
  ];
}

/** Вес запретов: сообщение о пяти непоказанных событиях тяжелее сообщения об одном. */
export function blockingWeight(plan: Pick<AiFilmPlan, "issues">): number {
  return gateIssues(plan).reduce((a, i) => a + Math.max(1, (i.eventIds ?? []).length), 0);
}

/** Одна ли это цель: результат описан теми же словами, хотя бы отчасти. */
function sameGoal(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));
  const x = words(a);
  const y = words(b);
  for (const w of x) if (y.has(w)) return true;
  return false;
}

/** Лучше ли `candidate`, чем `current`. При равенстве остаётся текущий план. */
export function betterPlan(candidate: AiFilmPlan, current: AiFilmPlan, required: StoryEvent[]): boolean {
  const a = planRank(candidate, required);
  const b = planRank(current, required);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** Одной строкой для лога и для подсказки планировщику. */
export function issueLines(issues: PlanIssue[]): string[] {
  return issues.map((i) => `${i.message}${i.beatIds.length ? ` (${i.beatIds.join(", ")})` : ""}`);
}
