import crypto from "crypto";
import { characterBlock } from "./character";
import { veoPricePerSecond, round2 } from "./pricing";
import { normalizeVeoDuration, VEO_EXTEND_SECONDS } from "./veo";
import type {
  AiFilmPlan, CharacterProfile, ContinuityGroup, FilmShot, PlanStats, StoryBeat, StoryBible, TimelineSegment,
} from "./types";

/**
 * План AI-фильма v2: биты → группы непрерывности → shots Veo → таймлайн → цена и время.
 *
 * Группа из одного бита — независимый shot (text-to-video с эталонами героя, 8 с).
 * Соседние AI-биты с одной меткой continuityGroup — цепочка: первый shot по тексту,
 * дальше extension по 7 с, не длиннее MAX_CHAIN_SECONDS. Независимые группы
 * генерируются параллельно, цепочка — последовательно. Цена считается только по
 * секундам, которые реально генерирует Veo; author-сегменты стоят $0.
 * Редьюсер бюджета детерминирован: сначала low, потом medium, потом high, кроме
 * защищённых (hook / reveal / climax с high).
 */

export const PLAN_VERSION = 3;
export const VEO_MODEL = process.env.AI_FILM_MODEL || "veo-3.1-fast-generate-001";
/** сцены без героя можно направлять в другую модель (например, Lite) — пока та же */
export const ENVIRONMENT_MODEL = process.env.AI_FILM_ENVIRONMENT_MODEL || VEO_MODEL;
export const MAX_CHAIN_SECONDS = 22;
export const MAX_CHAIN_EXTENSIONS = 2;
export const RESOLUTION = "720p" as const;

export function coverageConfig(): { target: number; max: number } {
  const t = Number(process.env.AI_FILM_TARGET_COVERAGE ?? 0.35);
  const m = Number(process.env.AI_FILM_MAX_COVERAGE ?? 0.55);
  const target = Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.35;
  const max = Number.isFinite(m) && m >= target && m <= 1 ? m : Math.max(target, 0.55);
  return { target, max };
}

export function veoConcurrency(): number {
  const v = Number(process.env.AI_FILM_VEO_CONCURRENCY ?? 3);
  return Number.isFinite(v) && v >= 1 ? Math.min(6, Math.floor(v)) : 3;
}

export function veoCallMinutes(): number {
  const v = Number(process.env.AI_FILM_ESTIMATED_VEO_CALL_MINUTES ?? 2);
  return Number.isFinite(v) && v > 0 ? v : 2;
}

export type PlanConfig = {
  key: string;
  budgetUsd: number;
  maxCoverage: number;
  concurrency: number;
  callMinutes: number;
  overheadMinutes?: number;
  model?: string;
  environmentModel?: string;
  /** есть ли эталоны героя — без них сцены с героем идут только по описанию */
  requireReferences?: boolean;
};

const isAi = (b: StoryBeat) => b.displayMode !== "author";
export const protectedBeat = (b: StoryBeat) => b.priority === "high" && (b.purpose === "hook" || b.purpose === "reveal" || b.purpose === "climax");

/** Промпт shot: WHO / WHAT / WHERE / WHAT CHANGES, кадр, камера, непрерывность, запреты. */
export function shotPrompt(args: {
  character: CharacterProfile;
  bible: StoryBible;
  beat: StoryBeat;
  prev: StoryBeat | null;
  mode: "text" | "extend";
  aspectRatio: "16:9" | "9:16";
}): string {
  const { character, bible, beat, prev, mode, aspectRatio } = args;
  const lines: string[] = [];
  lines.push(`Style: ${bible.visualStyle}. World: ${bible.world}. Mood: ${bible.mood}. Lighting: ${bible.lighting}.`);
  if (beat.gudiniVisible) lines.push(characterBlock(character));
  if (bible.supportingCharacters.length) {
    lines.push(`Supporting characters: ${bible.supportingCharacters.map((c) => `${c.name} (${c.function}): ${c.appearance}`).join("; ")}.`);
  }
  if (mode === "extend") {
    lines.push(`Continue the same shot without a cut. Previous moment: ${prev?.stateAfter || prev?.visualAction || "the scene continues"}.`);
  } else if (beat.stateBefore) {
    lines.push(`Before: ${beat.stateBefore}.`);
  }
  lines.push(`Action: ${beat.visualAction}`);
  if (beat.location) lines.push(`Location: ${beat.location}.`);
  if (beat.stateAfter) lines.push(`After: ${beat.stateAfter}.`);
  const shot = beat.shotType.replace("_", "-");
  lines.push(
    aspectRatio === "9:16"
      ? `Framing: vertical 9:16 portrait composition, ${shot} shot, subject near the vertical center with headroom, nothing important at the edges.`
      : `Framing: horizontal 16:9 composition, ${shot} shot, subject centered, nothing important at the edges.`,
  );
  lines.push(`Camera: ${beat.camera || bible.cameraLanguage}.`);
  if (bible.continuityRules.length) lines.push(`Continuity: ${bible.continuityRules.slice(0, 8).join("; ")}.`);
  lines.push(`${character.negative ? `${character.negative}. ` : ""}No text, no captions, no subtitles, no logos, no watermarks, no split screen, no talking to camera.`);
  return lines.join("\n");
}

function shortHash(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/**
 * Ключ кэша shot: модель, режим, секунды, соотношение, разрешение, параметры генерации,
 * промпт, хэш эталонов (если используются) и ключ источника (для extension — ключ
 * предыдущего shot). Правка независимого shot не трогает остальные; правка первого
 * shot цепочки пересобирает только её.
 */
export function shotKey(shot: FilmShot, refHash: string, sourceKey: string | null): string {
  return shortHash(
    JSON.stringify({
      model: shot.model,
      mode: shot.mode,
      seconds: shot.veoSeconds,
      aspect: shot.aspectRatio,
      resolution: shot.resolution,
      audio: false,
      personGeneration: "allow_adult",
      prompt: shot.prompt,
      refs: shot.useReferences ? refHash : null,
      source: sourceKey,
    }),
  );
}

/** Группы непрерывности из битов: соседние AI-биты с одной меткой и одним режимом. */
export function groupBeats(beats: StoryBeat[]): StoryBeat[][] {
  const groups: StoryBeat[][] = [];
  let cur: StoryBeat[] = [];
  for (const b of beats) {
    if (!isAi(b)) { if (cur.length) groups.push(cur); cur = []; continue; }
    const last = cur[cur.length - 1];
    const joins =
      last &&
      last.continuityGroup &&
      last.continuityGroup === b.continuityGroup &&
      last.displayMode === b.displayMode &&
      b.end - cur[0].start <= MAX_CHAIN_SECONDS + 1e-6;
    if (joins) cur.push(b);
    else { if (cur.length) groups.push(cur); cur = [b]; }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export type BuiltShots = { groups: ContinuityGroup[]; shots: FilmShot[]; timeline: TimelineSegment[]; warnings: string[] };

export function buildShots(beats: StoryBeat[], character: CharacterProfile, bible: StoryBible, cfg: PlanConfig): BuiltShots {
  const model = cfg.model || VEO_MODEL;
  const envModel = cfg.environmentModel || ENVIRONMENT_MODEL;
  const hasRefs = character.referenceFiles.length > 0;
  const warnings: string[] = [];
  const groups: ContinuityGroup[] = [];
  const shots: FilmShot[] = [];
  const priceOf = (m: string) => veoPricePerSecond(m, { audio: false, resolution: RESOLUTION }).pricePerSec;

  groupBeats(beats).forEach((gBeats, gi) => {
    const first = gBeats[0];
    const last = gBeats[gBeats.length - 1];
    const displayMode = first.displayMode as "full_ai" | "hybrid";
    const aspectRatio = displayMode === "full_ai" ? "9:16" : "16:9";
    const span = last.end - first.start;
    const gudiniVisible = gBeats.some((b) => b.gudiniVisible);
    const useReferences = gudiniVisible && hasRefs;
    const groupModel = gudiniVisible ? model : envModel;
    const id = `G${gi + 1}`;
    const shotIds: string[] = [];
    const prevBeat = beats[beats.indexOf(first) - 1] ?? null;
    let covered = 0;
    let idx = 0;
    while (covered < span - 0.05) {
      const mode: FilmShot["mode"] = idx === 0 ? "text" : "extend";
      if (mode === "extend" && idx > MAX_CHAIN_EXTENSIONS) break;
      const veoSeconds = mode === "text" ? normalizeVeoDuration(Math.min(span, 8), "text", { references: useReferences }) : VEO_EXTEND_SECONDS;
      const from = first.start + covered;
      const to = Math.min(last.end, from + veoSeconds);
      // бит, на который приходится больше всего времени этого shot
      const beat = gBeats.reduce((best, b) => (Math.min(b.end, to) - Math.max(b.start, from) > Math.min(best.end, to) - Math.max(best.start, from) ? b : best), gBeats[0]);
      const prev = mode === "extend" ? (gBeats[gBeats.indexOf(beat) - 1] ?? beat) : prevBeat;
      const shot: FilmShot = {
        id: `${id}-${idx + 1}`,
        groupId: id,
        index: idx,
        beatIds: gBeats.filter((b) => b.end > from && b.start < to).map((b) => b.id),
        displayMode,
        gudiniVisible: beat.gudiniVisible,
        generationProfile: mode === "extend" ? "continuation" : beat.gudiniVisible ? "character" : "environment",
        model: groupModel,
        mode,
        usedSeconds: Math.round(Math.min(veoSeconds, span - covered) * 100) / 100,
        veoSeconds,
        aspectRatio,
        resolution: RESOLUTION,
        useReferences: mode === "text" && useReferences,
        prompt: shotPrompt({ character, bible, beat, prev, mode, aspectRatio }),
        dependsOn: idx === 0 ? null : `${id}-${idx}`,
        cost: round2(veoSeconds * priceOf(groupModel)),
      };
      shots.push(shot);
      shotIds.push(shot.id);
      covered += veoSeconds;
      idx++;
    }
    groups.push({ id, displayMode, start: first.start, end: last.end, shotIds, chain: shotIds.length > 1, aspectRatio });
  });

  if (!hasRefs && shots.some((s) => s.gudiniVisible)) {
    warnings.push(`У персонажа «${character.name}» нет эталонных картинок в ${character.dir}: сцены с героем пойдут только по описанию`);
  }

  // таймлайн: сегменты по битам, соседние author сливаются
  const timeline: TimelineSegment[] = [];
  for (const b of beats) {
    const groupId = isAi(b) ? groups.find((g) => g.start <= b.start + 1e-6 && g.end >= b.end - 1e-6 && g.displayMode === b.displayMode)?.id : undefined;
    const prev = timeline[timeline.length - 1];
    if (prev && prev.mode === "author" && b.displayMode === "author") { prev.end = b.end; prev.beatIds.push(b.id); continue; }
    if (prev && groupId && prev.groupId === groupId) { prev.end = b.end; prev.beatIds.push(b.id); continue; }
    timeline.push({ start: b.start, end: b.end, mode: b.displayMode, ...(groupId ? { groupId } : {}), beatIds: [b.id] });
  }
  return { groups, shots, timeline, warnings };
}

/** Оценка времени по графу: группы — задачи длиной shots × минут, пул из concurrency воркеров (LPT), плюс накладные. */
export function estimateWallMinutes(groups: { shotIds: string[] }[], concurrency: number, callMinutes: number, overheadMinutes = 1): number {
  if (!groups.length) return 0;
  const jobs = groups.map((g) => g.shotIds.length * callMinutes).sort((a, b) => b - a);
  const workers = new Array(Math.max(1, concurrency)).fill(0);
  for (const j of jobs) {
    let k = 0;
    for (let i = 1; i < workers.length; i++) if (workers[i] < workers[k]) k = i;
    workers[k] += j;
  }
  return Math.ceil(Math.max(...workers) + overheadMinutes);
}

export function computeStats(beats: StoryBeat[], built: BuiltShots, duration: number, cfg: PlanConfig): PlanStats {
  const aiSeconds = built.timeline.filter((s) => s.mode !== "author").reduce((a, s) => a + (s.end - s.start), 0);
  const generatedSeconds = built.shots.reduce((a, s) => a + s.veoSeconds, 0);
  const chains = built.groups.filter((g) => g.chain);
  return {
    speechSeconds: Math.round(duration * 10) / 10,
    aiSeconds: Math.round(aiSeconds * 10) / 10,
    generatedSeconds,
    coverage: duration > 0 ? Math.round((aiSeconds / duration) * 1000) / 1000 : 0,
    calls: built.shots.length,
    groups: built.groups.length,
    independentGroups: built.groups.length - chains.length,
    chains: chains.length,
    longestChainCalls: Math.max(0, ...built.groups.map((g) => g.shotIds.length)),
    estimatedCost: round2(built.shots.reduce((a, s) => a + s.cost, 0)),
    estimatedWallMinutes: estimateWallMinutes(built.groups, cfg.concurrency, cfg.callMinutes, cfg.overheadMinutes ?? 1),
    concurrency: cfg.concurrency,
    reducedBeats: beats.filter((b) => b.reduced).length,
  };
}

function demote(b: StoryBeat, why: string): void {
  b.displayMode = "author";
  b.requiresGeneration = false;
  b.gudiniVisible = false;
  b.continuityGroup = null;
  b.reduced = why;
}

/**
 * Детерминированное сокращение под покрытие и бюджет: low → medium → high, с конца
 * ролика к началу; защищённые (hook/reveal/climax с high) не трогаются. Если и без
 * всего остального план не влезает — ошибка с цифрами, а не тихое урезание истории.
 */
export function reduceToBudget(beats: StoryBeat[], character: CharacterProfile, bible: StoryBible, duration: number, cfg: PlanConfig): { beats: StoryBeat[]; built: BuiltShots; stats: PlanStats } {
  const work = beats.map((b) => ({ ...b }));
  const order: Array<"low" | "medium" | "high"> = ["low", "medium", "high"];
  for (;;) {
    const built = buildShots(work, character, bible, cfg);
    const stats = computeStats(work, built, duration, cfg);
    const overCoverage = stats.coverage > cfg.maxCoverage + 1e-9;
    const overBudget = stats.estimatedCost > cfg.budgetUsd + 1e-9;
    if (!overCoverage && !overBudget) return { beats: work, built, stats };
    let victim: StoryBeat | undefined;
    for (const p of order) {
      const candidates = work.filter((b) => isAi(b) && b.priority === p && !protectedBeat(b));
      if (candidates.length) { victim = candidates[candidates.length - 1]; break; }
    }
    if (!victim) {
      throw new Error(
        `AI-фильм: план не помещается в ${overBudget ? `бюджет $${cfg.budgetUsd} (оценка $${stats.estimatedCost})` : `покрытие ${Math.round(cfg.maxCoverage * 100)}% (сейчас ${Math.round(stats.coverage * 100)}%)`} ` +
          `даже после снятия всех необязательных сцен — уменьшите число ключевых сцен или поднимите MEDIA_FILM_MAX_COST_USD`,
      );
    }
    demote(victim, overBudget ? `снят по бюджету (приоритет ${victim.priority})` : `снят по покрытию (приоритет ${victim.priority})`);
  }
}

export function buildFilmPlan(args: {
  character: CharacterProfile;
  bible: StoryBible;
  beats: StoryBeat[];
  duration: number;
  cfg: PlanConfig;
}): AiFilmPlan {
  const { character, bible, duration, cfg } = args;
  if (!args.beats.length) throw new Error("AI-фильм: нет битов для плана");
  const model = cfg.model || VEO_MODEL;
  const price = veoPricePerSecond(model, { audio: false, resolution: RESOLUTION });
  const { beats, built, stats } = reduceToBudget(args.beats, character, bible, duration, cfg);
  const warnings = [...built.warnings];
  if (stats.reducedBeats) warnings.push(`Сцен переведено в автора редьюсером: ${stats.reducedBeats}`);
  return {
    version: PLAN_VERSION,
    createdAt: new Date().toISOString(),
    key: cfg.key,
    duration,
    character: { id: character.id, name: character.name, refHash: character.refHash, referenceCount: character.referenceFiles.length },
    bible,
    beats,
    groups: built.groups,
    shots: built.shots,
    timeline: built.timeline,
    pricing: { model, resolution: RESOLUTION, audio: false, pricePerSec: price.pricePerSec, source: price.source },
    budgetUsd: cfg.budgetUsd,
    stats,
    warnings,
  };
}

/** Старый план (другая версия схемы) — не интерпретировать, просить пересобрать. */
export function planVersionError(plan: { version?: number } | null | undefined): string | null {
  if (!plan) return null;
  if (plan.version !== PLAN_VERSION) return "AI Film plan устарел, пересоберите план";
  return null;
}
