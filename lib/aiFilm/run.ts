import fs from "fs";
import path from "path";
import type { Word } from "../transcribe";
import type { Project } from "../store";
import type { StoryResearchPack } from "../storyResearch";
import { textHash } from "../fileFingerprint";
import { setRunCostLimit } from "../costLedger";
import { planStory, STORY_VERSION } from "./story";
import { buildFilmPlan, coverageConfig, planVersionError, veoCallMinutes, veoConcurrency, PLAN_VERSION, VEO_MODEL, ENVIRONMENT_MODEL } from "./plan";
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
export function planKey(words: Word[], script: string, character: { id: string; refHash: string }, universe: { id: string; hash: string }, duration?: number): string {
  const speech = JSON.stringify({ words: words.map((w) => [w.word, w.start, w.end]), duration: duration ?? words.at(-1)?.end ?? 0 });
  return `${textHash(speech)}:${textHash(script)}:${STORY_VERSION}.${PLAN_VERSION}:${VEO_MODEL}/${ENVIRONMENT_MODEL}:${character.id}@${character.refHash}:${universe.id}@${universe.hash}`;
}

/** Что именно разошлось между сохранённым планом и текущими данными — по частям ключа. */
export function planKeyDiff(saved: string, current: string): string[] {
  const names = ["речь", "сценарий", "версия плана", "модели", "профиль персонажа (описание или эталоны)", "профиль мира"];
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
  const key = planKey(words, project.script ?? "", character, universe, duration);
  const budget = filmBudget();
  const coverage = coverageConfig();
  const cfg = { key, universe, budgetUsd: budget, maxCoverage: coverage.max, concurrency: veoConcurrency(), callMinutes: veoCallMinutes() };

  if (request === "plan") {
    args.setStep("AI-фильм: разбор истории", 26);
    const research = await args.research.catch(() => null);
    const summary = research ? research.facts.slice(0, 8).map((f) => f.text).filter(Boolean).join("; ") : "";
    const ask = (retryNote?: string) =>
      planStory({ words, script: project.script ?? "", topic: project.topic, researchSummary: summary, character, universe, duration, coverage, retryNote });
    let story = await ask();
    args.setStep("AI-фильм: план сцен", 30);
    let plan = buildFilmPlan({ character, bible: story.bible, beats: story.beats, duration, cfg });
    // Требования к структуре проверяемы, поэтому не «как повезёт»: если план начинается
    // с говорящей головы или содержит длинный кусок без сцен, планировщик получает ровно
    // один второй заход с названными нарушениями. Дороже это на один запрос к модели.
    // Второй заход даётся не на всё подряд, а только на то, что портит оплаченный клип:
    // дыры в структуре и физически невыполнимые указания. Замечания про однообразие
    // ракурсов и плотность действий остаются предупреждениями — это вкус, а не поломка.
    const HARD = [
      /Первая сцена появляется/,
      /Длинные куски без сцен/,
      /В ролике нет ни одной/,
      /Сцены без события/,
      /Камера сверху, а важное находится НАД человеком/,
      /Камера описана и как неподвижная, и как движущаяся/,
      /Повреждённый предмет снова целый/,
      /Действие возвращается в прежнее место/,
      /Склейка внутри одной сцены/,
      /Сцена требует читаемый текст/,
    ];
    const broken = (p: AiFilmPlan) => p.warnings.filter((w) => HARD.some((re) => re.test(w)));
    const first = broken(plan);
    if (first.length) {
      console.warn(`AI-фильм: план нарушил структуру (${first.join("; ")}) — второй заход`);
      args.setStep("AI-фильм: правка плана", 29);
      const retry = await ask(first.map((w) => `- ${w}`).join("\n"));
      const retryPlan = buildFilmPlan({ character, bible: retry.bible, beats: retry.beats, duration, cfg });
      // берём лучший из двух: второй заход не обязан оказаться удачнее
      if (broken(retryPlan).length < first.length) {
        story = retry;
        plan = retryPlan;
        console.log(`AI-фильм: второй заход исправил структуру (осталось ${broken(retryPlan).length} из ${first.length})`);
      } else {
        console.warn("AI-фильм: второй заход не улучшил структуру, остаётся первый план");
      }
    }
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
