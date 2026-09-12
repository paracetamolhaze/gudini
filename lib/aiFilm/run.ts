import fs from "fs";
import path from "path";
import type { Word } from "../transcribe";
import type { Project } from "../store";
import type { StoryResearchPack } from "../storyResearch";
import { textHash } from "../fileFingerprint";
import { setRunCostLimit } from "../costLedger";
import { planStory, reconcileEventRefs, STORY_VERSION } from "./story";
import { buildFilmPlan, compilerFingerprint, coverageConfig, planVersionError, veoCallMinutes, veoConcurrency, PLAN_VERSION, VEO_MODEL, ENVIRONMENT_MODEL } from "./plan";
import { betterPlan, blockingWeight, gateIssues, issueLines, missingRequired, preserveRequired, requiredEvents, retryIssues } from "./criteria";
import { generateGroups } from "./generate";
import { loadCharacterProfile } from "./character";
import { loadUniverseProfile } from "./universe";
import { veoConfigured } from "./veo";
import type { AiFilmPlan, GroupClip } from "./types";

/**
 * Стадия AI-фильма v2 в конвейере. Две фазы по запросу пользователя:
 *   plan     — Character Bible + разбор истории (Claude) → биты → shots/группы →
 *              редьюсер под покрытие и бюджет → план с ценой и временем. Veo не вызывается.
 *   generate — только по подтверждённому плану той же версии и того же ключа:
 *              группы Veo (параллельно, кэш по ключу) → клипы для сборки.
 */

export const PLAN_FILE = "ai-film-plan.json";

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
  character: ReturnType<typeof loadCharacterProfile>;
  universe: ReturnType<typeof loadUniverseProfile>;
  duration: number;
  coverage: { target: number; max: number };
  cfg: Parameters<typeof buildFilmPlan>[0]["cfg"];
  onStep?: (step: string, progress: number) => void;
  /** запрос и ответ модели на каждом заходе: нужен разбору, на выбор плана не влияет */
  onCall?: (info: { system: string; user: string; raw: string; retry: boolean }) => void;
}): Promise<{ plan: AiFilmPlan; story: Awaited<ReturnType<typeof planStory>>; retried: boolean; accepted: boolean; candidates: { first: AiFilmPlan; retry?: AiFilmPlan } }> {
  const { character, universe, duration, cfg } = args;
  const ask = (retryNote?: string) =>
    planStory({
      words: args.words, script: args.script, topic: args.topic, researchSummary: args.researchSummary,
      character, universe, duration, coverage: args.coverage, retryNote, onCall: args.onCall,
    });
  let story = await ask();
  args.onStep?.("AI-фильм: план сцен", 30);
  let plan = buildFilmPlan({ character, bible: story.bible, beats: story.beats, duration, cfg });
  // Оба кандидата сохраняются: по ним видно, что выбрал планировщик, а что изменила сборка.
  const candidates: { first: AiFilmPlan; retry?: AiFilmPlan } = { first: plan };
  // Второй заход даётся по тем же типизированным нарушениям, по которым план потом
  // не пускается к оплате: раньше исправление искало строки предупреждений регулярными
  // выражениями, а ворота смотрели только на issues, и известная склейка внутри кадра
  // проходила мимо ворот. Теперь набор один — criteria.ts.
  const required = requiredEvents(story.bible.events);
  plan = withVisualTaskIssue(plan, story.bible);
  candidates.first = plan;
  const first = retryIssues(plan);
  let retried = false;
  let accepted = false;
  if (first.length) {
    console.warn(`AI-фильм: план нарушил требования (${issueLines(first).join("; ")}) — второй заход`);
    args.onStep?.("AI-фильм: правка плана", 29);
    retried = true;
    // Во второй заход уходит и сам контракт: те же идентификаторы, те же состояния.
    // Иначе модель переименовывает событие, прежнее возвращается принудительно, и в плане
    // оказываются два обязательства об одном и том же — одно из них навсегда непоказанное.
    const contract = required.length
      ? `\nОбязательные события остаются теми же, с теми же id и состояниями. Покажи каждое:\n` +
        required
          .map((e) => `- ${e.id}: ${e.observable} (${e.objects.map((o) => `${o.id}: ${o.before} → ${o.after}`).join("; ")})`)
          .join("\n") +
        `\nСостояние предмета после сцены пиши теми же словами, что и after у события.`
      : "";
    const retry = await ask(issueLines(first).map((w) => `- ${w}`).join("\n") + contract);
    // Обязательный набор первого захода возвращается силой: снять обязательность вместо
    // постановки сцены модель не может — это делало проверку зелёной, не показав события.
    const retryBible = { ...retry.bible, events: preserveRequired(story.bible.events, retry.bible.events) };
    // Ссылки сцен второго захода тоже сверяются с его контрактом: модель охотно описывает
    // событие в сцене и забывает переписать его в bible.events.
    reconcileEventRefs(retryBible, retry.beats);
    const retryPlan = withVisualTaskIssue(buildFilmPlan({ character, bible: retryBible, beats: retry.beats, duration, cfg }), retryBible);
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
  }
  return { plan, story, retried, accepted, candidates };
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
    const summary = research ? research.facts.slice(0, 8).map((f) => f.text).filter(Boolean).join("; ") : "";
    // Ответы планировщика сохраняются рядом с планом ДО разбора: упавший разбор стоит
    // столько же, сколько удачный, и без текста ответа причину падения искать нечем.
    const callsDir = path.join(dir, "ai-film", "story-calls");
    let callNo = 0;
    const { plan } = await planFilm({
      words, script: project.script ?? "", topic: project.topic, researchSummary: summary,
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
  const lost = missingRequired(plan, requiredEvents(plan.bible.events));
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
