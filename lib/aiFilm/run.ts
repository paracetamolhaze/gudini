import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import type { Word } from "../transcribe";
import type { Project } from "../store";
import type { StoryResearchPack } from "../storyResearch";
import { textHash } from "../fileFingerprint";
import { setRunCostLimit } from "../costLedger";
import { planStory, planPatch, applyPatch, storyFromRaw, scopeFromIssues, reconcileEventRefs, reviewEvidence, STORY_VERSION } from "./story";
import { buildFilmPlan, compilerFingerprint, coverageConfig, planVersionError, veoCallMinutes, veoConcurrency, PLAN_VERSION, VEO_MODEL, ENVIRONMENT_MODEL } from "./plan";
import { betterPlan, blockingWeight, gateIssues, issueLines, missingRequired, preserveRequired, retryIssues, authorCarriedEvents, showableEvents } from "./criteria";
import { generateGroups } from "./generate";
import { loadCharacterProfile } from "./character";
import { loadUniverseProfile } from "./universe";
import { veoConfigured } from "./veo";
import type { AiFilmPlan, GroupClip, StoryBeat, StoryBible } from "./types";
import { reviewCompiledPlan } from "./editorialReview";

/**
 * Стадия AI-фильма v2 в конвейере. Две фазы по запросу пользователя:
 *   plan     — Character Bible + разбор истории (Claude) → биты → shots/группы →
 *              редьюсер под покрытие и бюджет → план с ценой и временем. Veo не вызывается.
 *   generate — только по подтверждённому плану той же версии и того же ключа:
 *              группы Veo (параллельно, кэш по ключу) → клипы для сборки.
 */

export const PLAN_FILE = "ai-film-plan.json";

/** A failed visual explanation must not force another paid call. Only source-reviewed,
 * unsupported mechanisms can return to the existing recording; mixed scenes containing
 * any other event keep their checks and cannot hide a physical obligation this way. */
function useRecordingForUnsupportedMechanisms(bible: StoryBible, beats: StoryBeat[]) {
  const unsupported = new Set(bible.events.filter(e => e.reviewedMechanism).map(e => e.id));
  if (!["news", "history"].includes(bible.storyType) || !unsupported.size) return { bible, beats, routed: [] as string[] };
  const routed: string[] = [];
  const next = beats.map(beat => {
    const ids = beat.eventIds ?? [];
    if (beat.displayMode === "author" || !ids.length || !ids.every(id => unsupported.has(id))) return beat;
    routed.push(beat.id);
    return { ...beat, displayMode: "author" as const, gudiniVisible: false };
  });
  const tasks = new Set(beats.filter(b => routed.includes(b.id)).map(b => b.visualTask));
  return { beats: next, routed, bible: { ...bible, visualTasks: (bible.visualTasks ?? []).map(task =>
    tasks.has(task.id) && !next.some(b => b.visualTask === task.id && b.displayMode !== "author")
      ? { ...task, role: "explanation" as const, action: "" } : task),
  } };
}

export function filmBudget(): number {
  const v = Number(process.env.MEDIA_FILM_MAX_COST_USD ?? 12);
  return Number.isFinite(v) && v > 0 ? v : 12;
}

/**
 * Ключ входных данных плана: чистая речь + сценарий + версии + модели + персонаж + мир.
 * `character.refHash` — хэш всей идентичности (текст профиля и эталоны), поэтому правка
 * одного описания лица или костюма тоже делает план устаревшим.
 */
export function planKey(
  words: Word[],
  script: string,
  character: { id: string; refHash: string },
  universe: { id: string; hash: string },
  duration?: number,
  fingerprint = "",
): string {
  const speech = JSON.stringify({ words: words.map((w) => [w.word, w.start, w.end]), duration: duration ?? words.at(-1)?.end ?? 0 });
  return (
    `${textHash(speech)}:${textHash(script)}:${STORY_VERSION}.${PLAN_VERSION}:${VEO_MODEL}/${ENVIRONMENT_MODEL}:` +
    `${character.id}@${character.refHash}:${universe.id}@${universe.hash}:${fingerprint}`
  );
}

/** Что именно разошлось между сохранённым планом и текущими данными — по частям ключа. */
export function planKeyDiff(saved: string, current: string): string[] {
  const names = ["речь", "сценарий", "версия плана", "модели", "профиль персонажа (описание или эталоны)", "профиль мира", "промпты планировщика и сборщика"];
  const a = saved.split(":");
  const b = current.split(":");
  const out: string[] = [];
  for (let i = 0; i < names.length; i++) {
    if ((a[i] ?? "") !== (b[i] ?? "")) out.push(names[i]);
  }
  return out.length ? out : ["ключ целиком"];
}

export function loadPlanFile(dir: string): AiFilmPlan | null {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, PLAN_FILE), "utf8"));
    return p && Array.isArray(p.beats) && Array.isArray(p.shots) ? (p as AiFilmPlan) : null;
  } catch {
    return null;
  }
}

export type FilmStageResult =
  | { kind: "plan"; plan: AiFilmPlan }
  | { kind: "film"; plan: AiFilmPlan; clips: GroupClip[]; spent: number; generated: number; cached: number };

/**
 * Фаза плана целиком: разбор истории Claude → биты → запросы → второй заход по типизированным
 * нарушениям → выбор лучшего кандидата. Вынесена из стадии, чтобы тем же кодом можно было
 * прогнать план вне конвейера — например, при разборе качества планировщика на новых темах,
 * без видео и без Veo. Конвейер вызывает её же.
 */
/**
 * План без визуальных задач всей истории — прежний подбор картинки под каждую реплику. Такой
 * план получает замечание и второй заход; проверки самих задач живут в разборе плана.
 */
function withVisualTaskIssue(plan: AiFilmPlan, bible: { visualTasks?: unknown[] }): AiFilmPlan {
  if ((bible.visualTasks ?? []).length || !plan.shots.length) return plan;
  return {
    ...plan,
    issues: [
      ...(plan.issues ?? []),
      {
        code: "no-visual-tasks",
        severity: "warn" as const,
        beatIds: [],
        message: "План составлен без визуальных задач всей истории — сначала выпишите, что зритель должен увидеть за весь ролик, потом раскладывайте сцены",
      },
    ],
  };
}

export async function planFilm(args: {
  words: Word[];
  script: string;
  topic?: string;
  researchSummary?: string;
  /** факты справки по отдельности: по ним разбор сверяет статус событий контракта */
  researchFacts?: string[];
  character: ReturnType<typeof loadCharacterProfile>;
  universe: ReturnType<typeof loadUniverseProfile>;
  duration: number;
  coverage: { target: number; max: number };
  cfg: Parameters<typeof buildFilmPlan>[0]["cfg"];
  onStep?: (step: string, progress: number) => void;
  /** запрос и ответ модели на каждом заходе: нужен разбору, на выбор плана не влияет */
  onCall?: (info: { system: string; user: string; raw: string; retry: boolean }) => void;
  /** подмена вызова модели по заходам: продолжить прерванный прогон от сохранённого ответа; в конвейере не задаётся */
  complete?: (a: { system: string; user: string; retry: boolean }) => Promise<string>;
  /** Offline replays may inject the editor too; production always runs the independent review. */
  reviewComplete?: (a: { system: string; user: string }) => Promise<string>;
  /** Explicit offline compiler/patch replay only; never set by the production stage. */
  skipEditorialReview?: boolean;
}): Promise<{ plan: AiFilmPlan; story: Awaited<ReturnType<typeof planStory>>; retried: boolean; accepted: boolean; candidates: { first: AiFilmPlan; retry?: AiFilmPlan }; correction: { kind: "none" | "format" | "patch" | "failed"; applied: string[]; rejected: string[] } }> {
  const { character, universe, duration, cfg } = args;
  const editorialReview = (candidate: AiFilmPlan) => args.skipEditorialReview
    ? Promise.resolve(candidate) // Existing deterministic compiler/patch fixtures make no network calls.
    : reviewCompiledPlan({ plan: candidate, script: args.script, facts: args.researchFacts ?? [], complete: args.reviewComplete, onCall: args.onCall });
  let capturedFirst = "";
  const ask = (retryNote?: string) =>
    planStory({
      words: args.words, script: args.script, topic: args.topic, researchSummary: args.researchSummary, researchFacts: args.researchFacts,
      character, universe, duration, coverage: args.coverage, budgetUsd: cfg.budgetUsd, retryNote,
      onCall: (call) => { if (!call.retry) capturedFirst = call.raw; args.onCall?.(call); },
      // подмена вызова модели: даёт продолжить прерванный прогон от сохранённого ответа тем же
      // кодом — первый заход из файла, второй к модели; в конвейере не задаётся
      complete: args.complete ? (a) => args.complete!({ ...a, retry: Boolean(retryNote) }) : undefined,
    });
  let formatRepaired = false;
  const correction: { kind: "none" | "format" | "patch" | "failed"; applied: string[]; rejected: string[] } = { kind: "none", applied: [], rejected: [] };
  let story: Awaited<ReturnType<typeof planStory>>;
  try {
    story = await ask();
  } catch (error) {
    // Repair only a received, malformed model response. Authentication, transport, budget,
    // input and compiler failures are not retried as if they were creative mistakes.
    const message = error instanceof Error ? error.message : String(error);
    if (!capturedFirst || !/AI Film Story:.*(?:JSON|структур|биты)/i.test(message)) throw error;
    formatRepaired = true;
    correction.kind = "format";
    story = await ask(`Ошибка формата ответа: ${message.split("(символов")[0]}. Верни полный JSON по схеме, сохрани содержание восстановимых полей. Никаких рассуждений вне JSON.\nПолученный ответ:\n${capturedFirst}`);
  }
  // Какие обязательные события несёт голос автора, решает первый ответ: во втором заходе под
  // давлением списка нарушений модель могла бы отдать объяснению то, что обязана показать.
  story.bible.authorCarried = authorCarriedEvents(story.bible);
  args.onStep?.("AI-фильм: план сцен", 30);
  let plan = buildFilmPlan({ character, bible: story.bible, beats: story.beats, duration, cfg });
  // Оба кандидата сохраняются: по ним видно, что выбрал планировщик, а что изменила сборка.
  const candidates: { first: AiFilmPlan; retry?: AiFilmPlan } = { first: plan };
  // Второй заход даётся по тем же типизированным нарушениям, по которым план потом
  // не пускается к оплате: раньше исправление искало строки предупреждений регулярными
  // выражениями, а ворота смотрели только на issues, и известная склейка внутри кадра
  // проходила мимо ворот. Теперь набор один — criteria.ts.
  // обязательные к показу: контракт минус неподтверждённые механизмы и опровергнутые утверждения
  let required = showableEvents(story.bible);
  plan = withVisualTaskIssue(plan, story.bible);
  args.onStep?.("AI-фильм: режиссёрская проверка собранного плана", 31);
  plan = await editorialReview(plan);
  candidates.first = plan;
  if (plan.issues.some(i => i.code === "editorial-review-failed")) {
    // A transport/quota or invalid-review failure is not a request to spend on creative repair.
    return { plan, story, retried: formatRepaired, accepted: false, candidates, correction: { kind: "failed", applied: [], rejected: [] } };
  }
  const first = retryIssues(plan);
  let retried = formatRepaired;
  let accepted = false;
  const needsEvidenceReview = ["news", "history"].includes(story.bible.storyType) && Boolean(args.researchFacts?.length);
  if (needsEvidenceReview && formatRepaired) {
    const message = "Две попытки ушли на восстановление ответа; проверка источников не завершена, Veo не запускается";
    plan = { ...plan, issues: [...plan.issues, { code: "correction-failed", severity: "block", beatIds: [], message }], warnings: [...plan.warnings, message] };
    candidates.first = plan;
  }
  if ((first.length || needsEvidenceReview) && !formatRepaired) {
    console.warn(`AI-фильм: план нарушил требования (${issueLines(first).join("; ")}) — второй заход`);
    args.onStep?.("AI-фильм: правка плана", 29);
    retried = true;
    // Во второй заход уходит и сам контракт: те же идентификаторы, те же состояния.
    // Иначе модель переименовывает событие, прежнее возвращается принудительно, и в плане
    // оказываются два обязательства об одном и том же — одно из них навсегда непоказанное.
    const mustShow = required.filter((e) => !(story.bible.authorCarried ?? []).includes(e.id));
    const contract = mustShow.length
      ? `\nОбязательные события остаются теми же, с теми же id и состояниями. Покажи каждое:\n` +
        mustShow
          .map((e) => `- ${e.id}: ${e.observable} (${e.objects.map((o) => `${o.id}: ${o.before} → ${o.after}`).join("; ")})`)
          .join("\n") +
        `\nСостояние предмета после сцены пиши теми же словами, что и after у события.`
        + `\nИсключение: если evidenceReview обнаружит unsupported-mechanism, этот механизм не требуется показывать. Удали его доказательство из сцены; сохрани рассказ голосом или нейтральный внешний исход.`
      : "";
    // Ограниченная корректировка: модель получает первый план целиком и замечания, возвращает
    // только изменения. Всё незатронутое сохраняется по построению, изменения вне области
    // отбрасываются, затем весь план проходит проверки заново.
    let scope = scopeFromIssues(first, plan.beats, story.bible, story.raw, story.phrases.length, character.name);
    try {
      const patch = await planPatch({
        words: args.words, script: args.script, topic: args.topic, researchSummary: args.researchSummary, researchFacts: args.researchFacts,
        first: story.raw, compiled: plan, remarks: [...issueLines(first), ...(contract ? [contract.trim()] : [])],
        character, universe, duration, coverage: args.coverage, budgetUsd: cfg.budgetUsd, scope, requireEvidenceReview: needsEvidenceReview, onCall: args.onCall,
        complete: args.complete ? (a) => args.complete!({ ...a, retry: true }) : undefined,
      });
      const reviewed = needsEvidenceReview
        ? reviewEvidence(story.raw, patch, args.researchFacts ?? [])
        : { raw: story.raw, eventIds: [] };
      if (reviewed.eventIds.length) {
        story = storyFromRaw(reviewed.raw, { words: args.words, phrases: story.phrases, duration, character, universe, researchFacts: args.researchFacts });
        story.bible.authorCarried = authorCarriedEvents(story.bible);
        const editorialIssues = plan.issues.filter(i => i.code.startsWith("editorial-"));
        plan = withVisualTaskIssue(buildFilmPlan({ character, bible: story.bible, beats: story.beats, duration, cfg }), story.bible);
        plan = { ...plan, issues: [...plan.issues, ...editorialIssues], warnings: [...plan.warnings, ...editorialIssues.map(i => i.message)] };
        candidates.first = plan;
        required = showableEvents(story.bible);
        scope = scopeFromIssues([...first, { code: "unconfirmed-mechanism", beatIds: [], eventIds: reviewed.eventIds }], plan.beats, story.bible, story.raw, story.phrases.length, character.name);
      }
      const patched = applyPatch(story.raw, patch, scope);
      // A patch cannot restore its own unsupported assertion to confirmed after review.
      for (const event of patched.raw.bible.events) {
        const reviewedEvent = story.bible.events.find(e => e.id === event.id && e.reviewedMechanism);
        if (reviewedEvent) Object.assign(event, { reviewedMechanism: true, basis: "told", basisFact: reviewedEvent.basisFact });
      }
      correction.kind = "patch";
      correction.applied = patched.applied;
      correction.rejected = patched.rejected;
      for (const l of patched.applied) console.log(`   корректировка: ${l}`);
      for (const l of patched.rejected) console.warn(`   корректировка отклонена: ${l}`);
      let retry = storyFromRaw(patched.raw, { words: args.words, phrases: story.phrases, duration, character, universe, researchFacts: args.researchFacts });
      // Обязательный набор первого захода возвращается силой: снять обязательность вместо
      // постановки сцены модель не может — это делало проверку зелёной, не показав события.
      let retryBible: StoryBible = { ...retry.bible, events: preserveRequired(story.bible.events, retry.bible.events), authorCarried: story.bible.authorCarried };
      const fallback = useRecordingForUnsupportedMechanisms(retryBible, retry.beats);
      retryBible = fallback.bible;
      retry = { ...retry, bible: retryBible, beats: fallback.beats };
      for (const id of fallback.routed) correction.applied.push(`${id}: неподтверждённый механизм оставлен авторской записи; генерация вставки не требуется`);
      // Ссылки сцен второго захода тоже сверяются с его контрактом: модель охотно описывает
      // событие в сцене и забывает переписать его в bible.events.
      reconcileEventRefs(retryBible, retry.beats);
      args.onStep?.("AI-фильм: проверка результата правки", 32);
      const retryPlan = await editorialReview(withVisualTaskIssue(buildFilmPlan({ character, bible: retryBible, beats: retry.beats, duration, cfg }), retryBible));
      candidates.retry = retryPlan;
      // Выбор по тяжести и сохранённым событиям, а не по числу строк.
      const was = { blocks: blockingWeight(plan), lost: missingRequired(plan, required).length };
      if (betterPlan(retryPlan, plan, required)) {
        story = { ...retry, bible: retryBible };
        plan = retryPlan;
        accepted = true;
        console.log(
          `AI-фильм: второй заход принят — запретов ${blockingWeight(retryPlan)} (было ${was.blocks}), ` +
            `потеряно обязательных ${missingRequired(retryPlan, required).length} (было ${was.lost})`,
        );
      } else {
        console.warn("AI-фильм: второй заход не лучше первого, остаётся первый план");
      }
    } catch (error) {
      correction.kind = "failed";
      // A paid correction must not destroy the usable first result. Existing blockers remain;
      // this warning does not permit an invalid plan to reach Veo or cause another model call.
      const message = "Корректировка не завершена; сохранён первый план и его проверки";
      console.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
      plan = { ...plan, issues: [...(plan.issues ?? []), {
        code: "correction-failed", severity: needsEvidenceReview ? "block" : "warn", beatIds: [], message,
      }], warnings: [...plan.warnings, message] };
    }
  }
  return { plan, story, retried, accepted, candidates, correction };
}

export async function runAiFilmStage(args: {
  id: string;
  dir: string;
  project: Project;
  words: Word[];
  duration: number;
  research: Promise<StoryResearchPack | null | undefined>;
  setStep: (step: string, progress: number) => void;
}): Promise<FilmStageResult> {
  const { id, dir, project, words, duration } = args;
  const request = project.aiFilm?.request ?? "plan";
  const character = loadCharacterProfile();
  const universe = loadUniverseProfile();
  const key = planKey(words, project.script ?? "", character, universe, duration, compilerFingerprint(character, universe));
  const budget = filmBudget();
  const coverage = coverageConfig();
  const cfg = { key, universe, budgetUsd: budget, maxCoverage: coverage.max, concurrency: veoConcurrency(), callMinutes: veoCallMinutes() };

  if (request === "plan") {
    args.setStep("AI-фильм: разбор истории", 26);
    const research = await args.research.catch(() => null);
    const facts = research ? research.facts.slice(0, 8).map((f) => f.text).filter(Boolean) : [];
    const summary = facts.join("; ");
    // Ответы планировщика сохраняются рядом с планом ДО разбора: упавший разбор стоит
    // столько же, сколько удачный, и без текста ответа причину падения искать нечем.
    const callsDir = path.join(dir, "ai-film", "story-calls", `${Date.now()}-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(callsDir, { recursive: true });
    fs.writeFileSync(path.join(callsDir, "input.json"), JSON.stringify({
      words, script: project.script ?? "", topic: project.topic, researchSummary: summary,
      researchFacts: facts, duration, coverage, cfg,
    }, null, 2), "utf8");
    let callNo = 0;
    const result = await planFilm({
      words, script: project.script ?? "", topic: project.topic, researchSummary: summary, researchFacts: facts,
      character, universe, duration, coverage, cfg,
      onStep: (step, progress) => args.setStep(step, progress),
      onCall: ({ system, user, raw, retry }) => {
        try {
          fs.mkdirSync(callsDir, { recursive: true });
          const name = `${String(++callNo).padStart(2, "0")}-${retry ? "retry" : "first"}`;
          fs.writeFileSync(path.join(callsDir, `${name}-raw.json`), raw, "utf8");
          fs.writeFileSync(path.join(callsDir, `${name}-user.txt`), user, "utf8");
          fs.writeFileSync(path.join(callsDir, `${name}-system.txt`), system, "utf8");
        } catch {}
      },
    });
    const { plan } = result;
    fs.writeFileSync(path.join(callsDir, "candidates.json"), JSON.stringify({
      ...result.candidates, retried: result.retried, accepted: result.accepted, correction: result.correction,
      selectedKey: plan.key, blocking: gateIssues(plan),
    }, null, 2), "utf8");
    fs.writeFileSync(path.join(dir, PLAN_FILE), JSON.stringify(plan, null, 2), "utf8");
    const s = plan.stats;
    console.log(
      `AI-фильм: план — битов ${plan.beats.length}, AI ${s.aiSeconds} с из ${s.speechSeconds} с (${Math.round(s.coverage * 100)}%), ` +
        `Veo-секунд ${s.generatedSeconds}, вызовов ${s.calls}, групп ${s.groups} (цепочек ${s.chains}), оценка $${s.estimatedCost.toFixed(2)}, ~${s.estimatedWallMinutes} мин при ${s.concurrency} параллельных`,
    );
    for (const w of plan.warnings) console.warn(`  предупреждение: ${w}`);
    return { kind: "plan", plan };
  }

  // generate — только по подтверждённому плану
  const plan = project.aiFilm?.plan ?? loadPlanFile(dir);
  if (!plan) throw new Error("AI-фильм: плана нет — сначала соберите план и подтвердите его");
  const stale = planVersionError(plan);
  if (stale) throw new Error(stale);
  if (plan.key !== key) {
    // Без разбора по частям было непонятно, что именно изменилось: речь пересчиталась,
    // сценарий правили или подменили пак героя. Теперь причина видна и в логе, и на сайте.
    const changed = planKeyDiff(plan.key, key);
    console.warn(`AI-фильм: ключ плана разошёлся (${changed.join(", ")})
  план:   ${plan.key}
  сейчас: ${key}`);
    throw new Error(`AI-фильм: план устарел, изменилось: ${changed.join(", ")}. Соберите план заново`);
  }
  if (!veoConfigured()) {
    throw new Error("AI-фильм: Google Cloud не подключён к воркеру (нет файла учётных данных ADC). Veo не вызывался");
  }
  const requireRefs = process.env.AI_FILM_REQUIRE_REFERENCES !== "0";
  if (requireRefs && plan.shots.some((s) => s.gudiniVisible && s.mode === "text") && character.referenceFiles.length === 0) {
    throw new Error(`AI-фильм: у персонажа «${character.name}» нет эталонных картинок в ${character.dir}. Добавьте их (см. README там же) или AI_FILM_REQUIRE_REFERENCES=0. Veo не вызывался`);
  }
  if (plan.stats.estimatedCost > budget) {
    throw new Error(`AI-фильм: оценка плана $${plan.stats.estimatedCost.toFixed(2)} выше предела MEDIA_FILM_MAX_COST_USD=$${budget}. Veo не вызывался`);
  }
  if (!plan.shots.length) throw new Error("AI-фильм: в плане нет ни одной AI-сцены — генерировать нечего");
  // Ворота перед оплатой. Раньше их не было вовсе: план с непоказанным обязательным
  // событием или с физически невыполнимым кадром спокойно доходил до кнопки генерации.
  const blocking = gateIssues(plan);
  if (blocking.length) {
    throw new Error(
      `AI-фильм: план не готов к генерации. ${issueLines(blocking).join(". ")}. ` +
        `Соберите план заново — сцену нужно поставить так, чтобы событие было видно. Veo не вызывался`,
    );
  }
  // Обязательные события сверяются ещё раз по конечным запросам этого же плана: план
  // мог быть собран старым кодом, а событие потеряться на группировке или редьюсере.
  const lost = missingRequired(plan, showableEvents(plan.bible));
  if (lost.length) {
    throw new Error(`AI-фильм: обязательные события не попали ни в один запрос Veo: ${lost.join(", ")}. Соберите план заново. Veo не вызывался`);
  }
  // предел этого запуска — бюджет фильма (обычный предел $2 рассчитан на карточки)
  setRunCostLimit(budget);
  args.setStep("AI-фильм: генерация сцен", 28);
  const gen = await generateGroups({
    dir,
    projectId: id,
    plan,
    character,
    concurrency: cfg.concurrency,
    onProgress: (msg, f) => args.setStep(`AI-фильм: ${msg}`, 28 + Math.round(f * 9)),
  });
  console.log(`AI-фильм: shots сгенерировано ${gen.generated}, из кэша ${gen.cached}, потрачено в этом запуске $${gen.spent.toFixed(2)}`);
  return { kind: "film", plan, clips: gen.clips, spent: gen.spent, generated: gen.generated, cached: gen.cached };
}
