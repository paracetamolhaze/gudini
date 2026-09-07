import fs from "fs";
import path from "path";
import type { Word } from "../transcribe";
import type { Project } from "../store";
import type { StoryResearchPack } from "../storyResearch";
import { textHash } from "../fileFingerprint";
import { setRunCostLimit } from "../costLedger";
import { analyzeStory, STORY_VERSION } from "./story";
import { buildFilmPlan, PLAN_VERSION, VEO_MODEL } from "./plan";
import { generateSequences } from "./generate";
import { assembleFilm } from "./composite";
import { veoConfigured } from "./veo";
import type { AiFilmPlan } from "./types";

/**
 * Стадия AI-фильма в конвейере. Две фазы по запросу пользователя:
 *   plan     — разбор истории и план сцен с ценой; Veo не вызывается, денег стоит
 *              только один запрос Claude. План показывается в интерфейсе.
 *   generate — только по подтверждённому плану: сцены Veo (кэш по ключу),
 *              сборка фильма. Без плана или с устаревшим планом — стоп.
 */

export const PLAN_FILE = "ai-film-plan.json";

export function filmBudget(): number {
  const v = Number(process.env.MEDIA_FILM_MAX_COST_USD ?? 12);
  return Number.isFinite(v) && v > 0 ? v : 12;
}

/** Ключ входных данных плана: чистая речь + сценарий + версии + модель. */
export function planKey(words: Word[], script: string): string {
  return `${textHash(words.map((w) => w.word).join(" "))}:${textHash(script)}:${STORY_VERSION}.${PLAN_VERSION}:${VEO_MODEL}`;
}

export function loadPlanFile(dir: string): AiFilmPlan | null {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, PLAN_FILE), "utf8"));
    return p && Array.isArray(p.sequences) ? (p as AiFilmPlan) : null;
  } catch {
    return null;
  }
}

export type FilmStageResult =
  | { kind: "plan"; plan: AiFilmPlan }
  | { kind: "film"; plan: AiFilmPlan; file: string; spent: number; generated: number; cached: number };

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
  const key = planKey(words, project.script ?? "");

  if (request === "plan") {
    args.setStep("AI-фильм: разбор истории", 26);
    const research = await args.research.catch(() => null);
    const summary = research ? research.facts.slice(0, 8).map((f: any) => (typeof f === "string" ? f : f.text ?? f.fact ?? "")).filter(Boolean).join("; ") : "";
    const story = await analyzeStory({ words, script: project.script ?? "", researchSummary: summary, topic: project.topic });
    args.setStep("AI-фильм: план сцен", 30);
    const plan = buildFilmPlan(story.bible, story.episodes, duration, { key });
    fs.writeFileSync(path.join(dir, PLAN_FILE), JSON.stringify(plan, null, 2), "utf8");
    console.log(
      `AI-фильм: план — эпизодов ${plan.episodes.length}, последовательностей ${plan.sequences.length}, вызовов Veo ${plan.calls}, ` +
        `секунд ${plan.totalSeconds}, оценка $${plan.estimatedCost.toFixed(2)}, ~${plan.estimatedMinutes} мин`,
    );
    return { kind: "plan", plan };
  }

  // generate — только по подтверждённому плану
  const plan = project.aiFilm?.plan ?? loadPlanFile(dir);
  if (!plan) throw new Error("AI-фильм: плана нет — сначала соберите план и подтвердите его");
  if (plan.key !== key) {
    throw new Error("AI-фильм: план устарел — речь или сценарий изменились с момента его сборки. Соберите план заново");
  }
  if (!veoConfigured()) {
    throw new Error("AI-фильм: Google Cloud не подключён к воркеру (нет файла учётных данных ADC). Veo не вызывался");
  }
  const budget = filmBudget();
  if (plan.estimatedCost > budget) {
    throw new Error(`AI-фильм: оценка плана $${plan.estimatedCost.toFixed(2)} выше предела MEDIA_FILM_MAX_COST_USD=$${budget}. Veo не вызывался`);
  }
  // предел этого запуска — бюджет фильма (обычный предел $2 рассчитан на карточки)
  setRunCostLimit(budget);
  fs.writeFileSync(path.join(dir, PLAN_FILE), JSON.stringify(plan, null, 2), "utf8");
  args.setStep("AI-фильм: генерация сцен", 28);
  const gen = await generateSequences({
    dir,
    projectId: id,
    plan,
    onProgress: (msg, f) => args.setStep(`AI-фильм: ${msg}`, 28 + Math.round(f * 8)),
  });
  console.log(`AI-фильм: сцен сгенерировано ${gen.generated}, из кэша ${gen.cached}, потрачено в этом запуске $${gen.spent.toFixed(2)}`);
  args.setStep("AI-фильм: сборка фильма", 36);
  const file = await assembleFilm(dir, plan, gen.files, duration);
  return { kind: "film", plan, file, spent: gen.spent, generated: gen.generated, cached: gen.cached };
}
