import crypto from "crypto";
import { characterBlock } from "./character";
import { universePromptBlock, type UniverseProfile } from "./universe";
import { veoPricePerSecond, round2 } from "./pricing";
import { normalizeVeoDuration, VEO_EXTEND_SECONDS } from "./veo";
import type {
  AiFilmPlan, CameraAngle, CharacterProfile, Composition, ContinuityGroup, FilmShot, PlanStats, StagingMode, StoryBeat, StoryBible, TimelineSegment,
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

export { PLAN_VERSION } from "./version";
import { PLAN_VERSION } from "./version";
export const VEO_MODEL = process.env.AI_FILM_MODEL || "veo-3.1-fast-generate-001";
/** сцены без героя можно направлять в другую модель (например, Lite) — пока та же */
export const ENVIRONMENT_MODEL = process.env.AI_FILM_ENVIRONMENT_MODEL || VEO_MODEL;
export const MAX_CHAIN_SECONDS = 22;
export const MAX_CHAIN_EXTENSIONS = 2;
/** Один независимый AI-бит — максимум один клип Veo на 8 с (без continuityRequired). */
export const PREFERRED_MAX_AI_SHOT_SECONDS = 8;
/** Ниже этого aiSeconds/generatedSeconds план получает предупреждение. */
export const MIN_GENERATION_EFFICIENCY = 0.65;
/** Автор короче этого между двумя AI-сценами — мигание, а не кадр: следующая сцена сдвигается встык. */
export const MIN_AUTHOR_GAP_SECONDS = 3;
export const RESOLUTION = "720p" as const;

export function coverageConfig(): { target: number; max: number } {
  // 0.5 / 0.65 вместо прежних 0.35 / 0.55: при низком потолке планировщик показывал
  // не события истории, а одну обобщающую сцену вместо трёх конкретных. Это дороже:
  // каждая дополнительная сцена — ещё один клип Veo.
  const t = Number(process.env.AI_FILM_TARGET_COVERAGE ?? 0.5);
  const m = Number(process.env.AI_FILM_MAX_COVERAGE ?? 0.65);
  const target = Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.5;
  const max = Number.isFinite(m) && m >= target && m <= 1 ? m : Math.max(target, 0.65);
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
  /** Universe Lock — обязателен, попадает в каждый промпт */
  universe: UniverseProfile;
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

/**
 * Постановка зависит от типа истории, стиль — нет. Строка идёт в каждый промпт своей сцены:
 * новость снимается как наблюдение, история — как реконструкция эпохи, размышление — как
 * бытовой эпизод. Отдельно сказано, чем кадр новости НЕ является, иначе генератор охотно
 * добавляет таймкод, зерно и рамку камеры наблюдения и выдаёт постановку за документ.
 */
export const STAGING_LINE: Record<StagingMode, string> = {
  observational:
    "Staging: a staged reconstruction of a real event, filmed as if a camera happened to be there — plain observational framing, " +
    "ordinary uncomposed detail, available light. It must not look like archive footage, security-camera or phone-recording material: " +
    "no timecode, no date stamp, no camera-UI overlay, no VHS or CCTV grain.",
  period_reconstruction:
    "Staging: a period reconstruction — clothing, tools, vehicles, architecture, materials, surfaces and light all belong to the stated " +
    "time and place. Nothing modern anywhere in frame: no plastic, no printed graphics, no modern eyewear, no LED or fluorescent light unless the action states it.",
  everyday_life:
    "Staging: an ordinary, recognisable moment from real life; the idea reads through the action itself. " +
    "No symbolic effects, no glowing objects, no smoke or haze that the action does not call for.",
};

/** Промпт shot: WHO / WHAT / WHERE / WHAT CHANGES, кадр, камера, непрерывность, запреты. */
export function shotPrompt(args: {
  character: CharacterProfile;
  universe: UniverseProfile;
  bible: StoryBible;
  beat: StoryBeat;
  prev: StoryBeat | null;
  mode: "text" | "extend";
  aspectRatio: "16:9" | "9:16";
}): string {
  const { character, universe, bible, beat, prev, mode, aspectRatio } = args;
  const lines: string[] = [];
  // Порядок важен: Veo сильнее слушает начало промпта, поэтому сперва действие и движение,
  // а стиль, мир и запреты уходят вниз. Раньше первые полторы тысячи знаков были служебными,
  // и на само действие оставалась одна фраза — отсюда выдуманные предметы в кадре.
  if (mode === "extend") {
    lines.push(`Continue the same shot without a cut. Previous moment: ${prev?.stateAfter || prev?.visualAction || "the scene continues"}.`);
  } else if (beat.stateBefore) {
    lines.push(`Before: ${beat.stateBefore}.`);
  }
  lines.push(`Action: ${beat.visualAction}`);
  // Одно изменение ради которого снимается сцена — сразу после действия и до всего
  // остального: у генератора должна быть одна цель, а не список равноправных задач.
  if (beat.keyMoment) {
    lines.push(`The one thing that must be visible: ${beat.keyMoment}. It happens early in the shot, not at the very end.`);
  }
  if (beat.motion) lines.push(`Motion in order: ${beat.motion}`);
  if (beat.location) lines.push(`Location: ${beat.location}.`);
  if (beat.stateAfter) lines.push(`After: ${beat.stateAfter}.`);
  const shot = beat.shotType.replace("_", "-");
  const ratio = aspectRatio === "9:16" ? "vertical 9:16 portrait composition" : "horizontal 16:9 composition";
  lines.push(`Framing: ${ratio}, ${shot} shot. ${COMPOSITION_LINE[beat.composition]}`);
  // Купол над головой не влезал в кадр, потому что здесь для каждой сцены стояло
  // «subject near the vertical center». Теперь место в кадре выбирается под то,
  // что должно быть видно, и это требование повторяется явно.
  if (beat.keyMoment) {
    lines.push(`Everything named above as the thing that must be visible is fully inside the frame, not cropped at any edge.`);
  }
  lines.push(`Camera angle: ${ANGLE_LINE[beat.cameraAngle]}.`);
  lines.push(`Camera: ${beat.camera || bible.cameraLanguage}. Single continuous take, no cuts inside the shot.`);
  lines.push(
    "Screen direction: keep the movement exactly as described relative to the camera. Do not turn the subject toward the lens " +
      "and do not have him run or jump into the camera unless the action says so.",
  );
  lines.push(STAGING_LINE[bible.staging]);
  // Физика общая и безопасная. Раньше здесь висели падающие тела, поток воздуха и летящие
  // обрывки — инструкции одной конкретной сцены с парашютом, приписанные ко всем подряд:
  // ткань рвалась в кадрах, где ничего не рвалось. Частности приходят из motion этого бита.
  lines.push(
    "Physics: real weight, speed and inertia — things respond to gravity and to contact, they settle and come to rest; " +
      "nothing hovers, floats or drifts in place; no slow motion unless the action asks for it.",
  );
  lines.push(
    "Realism: true human proportions, skin with real texture and no beauty smoothing, materials that behave like themselves, " +
      "contact shadows where objects touch, one dominant light source with matching exposure and shadow direction.",
  );

  // Люди в кадре: только те, кого назвала речь. Наблюдателей и прохожих быть не должно —
  // в прошлом ролике рядом с героем истории каждый раз вырастал лишний зритель.
  const text = `${beat.visualAction} ${beat.motion} ${beat.stateBefore} ${beat.stateAfter}`.toLowerCase();
  const inScene = bible.supportingCharacters.filter((c) =>
    c.name
      .split(/[\s/()]+/)
      .filter((w) => w.length >= 3)
      .some((w) => text.includes(w.toLowerCase())),
  );
  const cast: string[] = [];
  if (beat.gudiniVisible) cast.push(character.name);
  for (const c of inScene) cast.push(c.name);
  lines.push(
    `People in frame: exactly ${cast.length || "as described above"}${cast.length ? ` — ${cast.join(", ")}` : ""}. ` +
      "No other people at all: no bystanders, no onlookers, no crowd, no figures in the background.",
  );
  if (beat.gudiniVisible) {
    lines.push(characterBlock(character));
    // Эталоны сняты на ровном сером фоне, и Veo притаскивал этот фон в сцену вместо
    // описанного места: первая сцена «на крыльце» вышла в студии.
    if (character.referenceFiles.length) {
      lines.push(
        "The reference images define his face, hair and clothing only. Ignore their plain studio background completely — " +
          "the location of this shot is the one described above.",
      );
    }
  }
  if (inScene.length) {
    lines.push(`Characters in this shot: ${inScene.map((c) => `${c.name}: ${c.appearance}`).join("; ")}.`);
  }

  lines.push(`Style: ${bible.visualStyle}. Mood: ${bible.mood}. Lighting: ${bible.lighting}.`);
  lines.push(universePromptBlock(universe));
  lines.push(
    "No readable text anywhere in frame: no interface, no price tag, no document, no signage, no numbers on screens.",
  );
  if (bible.continuityRules.length) lines.push(`Continuity: ${bible.continuityRules.slice(0, 8).join("; ")}.`);
  // Хвост запретов один раз: текст и логотипы уже названы отдельной строкой выше,
  // и повторять их третий раз в конце промпта смысла нет
  lines.push(`${character.negative ? `${character.negative}. ` : ""}No split screen, no talking to camera.`);
  return lines.join("\n");
}

/** Известные имена и названия → описание, которое Veo принимает. Порядок: длинные сначала. */
const DEBRAND: [RegExp, string][] = [
  [/\bRobert Downey(?: Jr\.?)?\b/gi, "the actor"],
  [/\bIron Man armor\b/gi, "red-and-gold powered armor"],
  [/\bIron Man\b/gi, "the hero in red-and-gold powered armor"],
  [/\bTony Stark'?s?\b/gi, "the armored hero with the glowing chest reactor"],
  [/\bInfinity Gauntlet\b/gi, "golden gauntlet"],
  [/\bInfinity Stones?\b/gi, "glowing stones"],
  [/\bThanos\b/gi, "the giant purple titan with a golden gauntlet"],
  [/\bSteve Rogers\b/gi, "the older blond soldier"],
  [/\bCaptain America\b/gi, "the hero with the round star-spangled shield"],
  [/\bSam Wilson\b/gi, "the winged hero with the star-spangled shield"],
  [/\bBucky Barnes\b/gi, "the soldier with a silver metal arm"],
  [/\bNatasha Romanoff\b/gi, "the red-haired spy in a black suit"],
  [/\bYelena\b/gi, "the blonde fighter in a white tactical suit"],
  [/\bRed Guardian\b/gi, "the burly bearded man in a red suit"],
  [/\bJohn Walker\b/gi, "the soldier in a dark tactical suit"],
  [/\bSentinel robots?\b/gi, "giant purple mutant-hunting robots"],
  [/\b(?:Doctor|Dr\.?) Doom\b/gi, "the armored sorcerer in a green cloak and iron mask"],
  [/\bVictor von Doom\b/gi, "the armored sorcerer in a green cloak and iron mask"],
  [/\bProfessor X\b/gi, "the bald telepath in a hover-chair"],
  [/\bMagneto\b/gi, "the man in a red helmet and cape"],
  [/\bCyclops\b/gi, "the hero with a red visor"],
  [/\bX-Men\b/gi, "the mutant heroes"],
  [/\bX-Mansion\b/gi, "the mansion grounds"],
  [/\bFantastic Four\b/gi, "the four heroes in blue uniforms"],
  [/\bNew Avengers\b/gi, "the new hero team"],
  [/\bAvengers\b/gi, "the hero team"],
  [/\bEndgame\b/gi, "the final battle"],
  [/\bMarvel\b/gi, "the saga"],
  [/\b(?:Earth|Land)-828\b/gi, "the chrome tower city"],
];

/**
 * Промпт без имён чужих персонажей: замены из таблицы плюс имена персонажей истории
 * из Story Bible → их описание внешности. Используется только если Veo отклонил
 * промпт по правам третьих лиц; остальные сцены имена сохраняют.
 *
 * Две вещи эта замена трогать не имеет права. Первая — имя постоянного персонажа: оно
 * связано с эталонными картинками, и «a lean man in an orange jacket» вместо него означает
 * другого человека в кадре. Вторая — реконструкция реального события: там участники и есть
 * факт, поэтому имена в такой сцене не обезличиваются, и сцена честно остаётся несгенерированной,
 * если Veo её не принял.
 */
export function debrandPrompt(
  prompt: string,
  bible: Pick<StoryBible, "supportingCharacters"> & Partial<Pick<StoryBible, "reconstruction">>,
  protectName?: string,
): string {
  if (bible.reconstruction) return prompt;
  const guard = (protectName ?? "").trim().toLowerCase();
  let out = prompt;
  for (const c of bible.supportingCharacters) {
    const look = c.appearance.split(/[.;]/)[0].trim().toLowerCase();
    for (const alias of c.name.split("/").map((a) => a.trim()).filter((a) => a.length >= 3)) {
      if (guard && alias.toLowerCase() === guard) continue;
      const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      out = out.replace(re, look ? `a ${look}` : "the character");
    }
  }
  for (const [re, to] of DEBRAND) out = out.replace(re, to);
  return out.replace(/\s{2,}/g, " ");
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

/**
 * Правило одного клипа: AI-бит длиннее 8 с без явного continuityRequired не превращается
 * в цепочку extension ради покрытия — AI остаётся на первых 8 с, остаток бита уходит
 * автору. Голос непрерывен, поэтому AI не обязан закрывать весь смысловой блок.
 */
export function enforceShotBudget(beats: StoryBeat[]): StoryBeat[] {
  const out: StoryBeat[] = [];
  for (const b of beats) {
    const dur = b.end - b.start;
    if (b.displayMode === "author" || b.continuityRequired || dur <= PREFERRED_MAX_AI_SHOT_SECONDS + 1e-6) { out.push(b); continue; }
    const cut = b.start + PREFERRED_MAX_AI_SHOT_SECONDS;
    out.push({ ...b, end: cut, suggestedDuration: PREFERRED_MAX_AI_SHOT_SECONDS });
    out.push({
      ...b,
      id: `${b.id}a`,
      start: cut,
      displayMode: "author",
      requiresGeneration: false,
      gudiniVisible: false,
      continuityGroup: null,
      continuityRequired: false,
      universeAdaptation: "",
      visualAction: "",
      location: "",
      suggestedDuration: Math.round((b.end - cut) * 10) / 10,
      reduced: `остаток AI-бита после ${PREFERRED_MAX_AI_SHOT_SECONDS} с — автор (без continuityRequired)`,
    });
  }
  // соседние author-остатки сливаются с последующим author-битом
  const merged: StoryBeat[] = [];
  for (const b of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.displayMode === "author" && b.displayMode === "author" && prev.reduced && !b.reduced) {
      merged[merged.length - 1] = { ...b, start: prev.start, suggestedDuration: Math.round((b.end - prev.start) * 10) / 10 };
      continue;
    }
    merged.push(b);
  }
  return closeTinyAuthorGaps(merged);
}

/**
 * Автор на 1–3 с между двумя AI-сценами выглядит как мигание. Следующая AI-сцена
 * сдвигается встык к предыдущей (её длина сохраняется), а освободившийся хвост
 * отдаётся автору и сливается со следующим author-битом. AI — метафора смысла,
 * сдвиг окна на пару секунд ей не вредит, голос идёт непрерывно.
 */
export function closeTinyAuthorGaps(beats: StoryBeat[]): StoryBeat[] {
  const work = beats.map((b) => ({ ...b }));
  for (let i = 1; i < work.length - 1; i++) {
    const gap = work[i];
    const prev = work[i - 1];
    const next = work[i + 1];
    const d = gap.end - gap.start;
    if (gap.displayMode !== "author" || d >= MIN_AUTHOR_GAP_SECONDS || prev.displayMode === "author" || next.displayMode === "author") continue;
    // Сдвигать нельзя то, у чего время привязано к словам. Развязка, показанная на пару
    // секунд раньше, чем автор её произнёс, — это спойлер собственного ролика, а не косметика.
    if (next.purpose === "reveal" || next.purpose === "climax" || next.anchorPhrase) continue;
    const len = next.end - next.start;
    next.start = gap.start;
    next.end = Math.round((gap.start + len) * 1000) / 1000;
    next.suggestedDuration = Math.round(len * 10) / 10;
    const after = work[i + 2];
    if (after && after.displayMode === "author") {
      after.start = next.end;
      after.suggestedDuration = Math.round((after.end - after.start) * 10) / 10;
    } else {
      work.splice(i + 2, 0, {
        ...gap,
        id: `${next.id}t`,
        start: next.end,
        end: Math.round((next.end + d) * 1000) / 1000,
        suggestedDuration: Math.round(d * 10) / 10,
        reduced: "хвост после сдвига AI-сцены встык — автор",
      });
    }
    work.splice(i, 1);
    i--;
  }
  return work;
}

/** Группы непрерывности из битов: соседние AI-биты с одной меткой, одним режимом и continuityRequired. */
export function groupBeats(beats: StoryBeat[]): StoryBeat[][] {
  const groups: StoryBeat[][] = [];
  let cur: StoryBeat[] = [];
  for (const b of beats) {
    if (!isAi(b)) { if (cur.length) groups.push(cur); cur = []; continue; }
    const last = cur[cur.length - 1];
    const joins =
      last &&
      last.continuityRequired &&
      b.continuityRequired &&
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
    const continuity = gBeats.some((b) => b.continuityRequired);
    let covered = 0;
    let idx = 0;
    while (covered < span - 0.05) {
      const mode: FilmShot["mode"] = idx === 0 ? "text" : "extend";
      // extension — только при явном требовании непрерывности; иначе один клип
      if (mode === "extend" && (!continuity || idx > MAX_CHAIN_EXTENSIONS)) break;
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
        prompt: shotPrompt({ character, universe: cfg.universe, bible, beat, prev, mode, aspectRatio }),
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

/**
 * Куда смотрит камера. Раньше в промпт уходила одна фраза на все сцены, и ролик выглядел
 * снятым с одной точки; ракурс теперь приходит из плана и меняется от действия.
 */
export const ANGLE_LINE: Record<CameraAngle, string> = {
  eye_level: "camera at the subject's own eye level, level with the horizon",
  low_angle: "camera below the subject, tilted up at him, so he rises against the sky or ceiling",
  high_angle: "camera above the subject, tilted down at him, so the ground around him is visible",
  overhead: "camera directly above the subject looking straight down, the ground far below him",
  ground_level: "camera down on the ground close to the subject's feet, looking along the surface",
  over_shoulder: "camera just behind the subject's shoulder, seeing roughly what he sees",
  profile: "camera square to the subject's side, seeing him in clean profile",
};

/**
 * Где в кадре человек и, главное, для чего оставлено место. Именно эта строка чинит
 * купол, который не влезал в кадр: под ним место в кадре теперь резервируется явно.
 */
export const COMPOSITION_LINE: Record<Composition, string> = {
  center: "The subject sits near the centre of the frame with normal headroom.",
  low_space_above:
    "The subject sits LOW in the frame, in the bottom third. The whole upper half of the frame is kept clear for what is above him, " +
    "and that thing is shown whole, never cropped by the top edge.",
  high_space_below:
    "The subject sits HIGH in the frame, in the top third. The lower half of the frame is kept clear for the ground or drop below him.",
  offset_left: "The subject sits in the left third of the frame; the right side stays open for what he faces or what approaches.",
  offset_right: "The subject sits in the right third of the frame; the left side stays open for what he faces or what approaches.",
  subject_small_in_wide: "The subject is small inside a wide view; the place around him is the point of the shot, not his face.",
};

/**
 * Действие, в котором ничего не происходит. Ловится по главному глаголу: сцена, где герой
 * стоит, готовится или поправляет снаряжение, стоит тех же денег, что и сцена, где купол рвётся.
 */
export const STATIC_ACTION =
  /\b(?:stands?|standing|sits?|sitting|holds?|holding|looks? (?:at|around)|waits?|waiting|adjusts?|adjusting|tightens?|tightening|checks?|checking|prepares?|preparing|poses?|posing|thinks?|thinking|gazes?|gazing)\b/i;

/** Дольше этого зритель смотрит на говорящую голову без единой вставки — это провал удержания. */
export const MAX_AUTHOR_STRETCH_SECONDS = 12;
/** Позже этой секунды первая сцена уже не работает как hook. */
export const FIRST_SHOT_DEADLINE_SECONDS = 8;

/**
 * Куски ролика, где автор идёт слишком долго подряд. Считается по готовому таймлайну,
 * поэтому видит и то, что редьюсер снял по бюджету, и то, чего планировщик не показал.
 * Возвращает предупреждения, а не правит план: выдумать сцену за планировщика нельзя.
 */
export function authorStretchWarnings(timeline: TimelineSegment[], duration: number): string[] {
  const out: string[] = [];
  const ai = timeline.filter((s) => s.mode !== "author");
  if (!ai.length) {
    return duration > MAX_AUTHOR_STRETCH_SECONDS ? ["В ролике нет ни одной показанной сцены — весь ролик говорящая голова"] : out;
  }
  const first = ai[0].start;
  if (first > FIRST_SHOT_DEADLINE_SECONDS) {
    out.push(`Первая сцена появляется только на ${first.toFixed(1)} с — начало ролика без картинки не удержит зрителя`);
  }
  const longs: string[] = [];
  let cursor = 0;
  for (const s of ai) {
    if (s.start - cursor > MAX_AUTHOR_STRETCH_SECONDS + 1e-6) longs.push(`${cursor.toFixed(1)}–${s.start.toFixed(1)} с`);
    cursor = Math.max(cursor, s.end);
  }
  if (duration - cursor > MAX_AUTHOR_STRETCH_SECONDS + 1e-6) longs.push(`${cursor.toFixed(1)}–${duration.toFixed(1)} с`);
  if (longs.length) out.push(`Длинные куски без сцен (больше ${MAX_AUTHOR_STRETCH_SECONDS} с): ${longs.join(", ")}`);
  return out;
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
    overheadSeconds: Math.round(Math.max(0, generatedSeconds - aiSeconds) * 10) / 10,
    generationEfficiency: generatedSeconds > 0 ? Math.round((aiSeconds / generatedSeconds) * 1000) / 1000 : 1,
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
  const work = enforceShotBudget(beats).map((b) => ({ ...b }));
  const order: Array<"low" | "medium" | "high"> = ["low", "medium", "high"];
  for (;;) {
    const built = buildShots(work, character, bible, cfg);
    const stats = computeStats(work, built, duration, cfg);
    const overCoverage = stats.coverage > cfg.maxCoverage + 1e-9;
    const overBudget = stats.estimatedCost > cfg.budgetUsd + 1e-9;
    if (!overCoverage && !overBudget) return { beats: work, built, stats };
    // Самую раннюю сцену редьюсер не трогает, пока есть что снять позже. Иначе он
    // аккуратно оставлял кульминацию и развязку и вырезал ровно то, что держит начало
    // ролика: план с первой картинкой на двадцатой секунде — это план без зрителя.
    const earliest = work.find(isAi);
    let victim: StoryBeat | undefined;
    for (const p of order) {
      const candidates = work.filter((b) => isAi(b) && b.priority === p && !protectedBeat(b) && b !== earliest);
      if (candidates.length) { victim = candidates[candidates.length - 1]; break; }
    }
    // остались только защищённые и открывающая — снимаем и её, но последней
    if (!victim && earliest && !protectedBeat(earliest)) victim = earliest;
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
  const warnings = [...built.warnings, ...authorStretchWarnings(built.timeline, duration)];
  // Планировщик пишет русское имя героя в bible, а в английских полях зовёт его латиницей
  // («Каспер» → «Casper»), поэтому автозамена имени промахивается и в промпт уходят сразу
  // два человека: названный по имени герой и описание постоянного персонажа.
  // Сцена, в которой ничего не происходит. Человек, восемь секунд поправляющий лямку,
  // технически безупречен и совершенно не нужен: платим за клип, а событие рассказывает голос.
  const idle = beats.filter((b) => isAi(b) && (STATIC_ACTION.test(b.visualAction) || (b.stateBefore && b.stateBefore === b.stateAfter))).map((b) => b.id);
  if (idle.length) warnings.push(`Сцены без события (${idle.join(", ")}): герой стоит или готовится, но ничего не меняется`);
  // Два соседних кадра с одного ракурса — это тот самый «всегда одинаковый вид»,
  // с которого начался разбор. Правило есть в промпте, но модель его иногда пропускает.
  const shown = beats.filter(isAi);
  const repeats = shown.filter((b, i) => i > 0 && b.cameraAngle === shown[i - 1].cameraAngle).map((b) => b.id);
  if (repeats.length) warnings.push(`Соседние сцены сняты с одного ракурса (${repeats.join(", ")}) — ролик выглядит однообразно`);
  if (bible.playedByGudini) {
    const stray = beats.filter((b) => b.gudiniVisible && b.visualAction && !b.visualAction.includes(character.name));
    if (stray.length) {
      warnings.push(
        `Сцены, где роль исполняет ${character.name}, но в действии он назван иначе (${stray.map((b) => b.id).join(", ")}) — ` +
          `генератор может нарисовать другого человека`,
      );
    }
  }
  if (stats.reducedBeats) warnings.push(`Сцен переведено в автора редьюсером: ${stats.reducedBeats}`);
  if (stats.calls > 0 && stats.generationEfficiency < MIN_GENERATION_EFFICIENCY) {
    warnings.push(
      `Низкая эффективность генерации: на экране ${stats.aiSeconds} с из ${stats.generatedSeconds} сгенерированных (${Math.round(stats.generationEfficiency * 100)}%, желательно > 75%) — AI-биты короче 8 с или лишние продолжения`,
    );
  }
  return {
    version: PLAN_VERSION,
    createdAt: new Date().toISOString(),
    key: cfg.key,
    duration,
    character: { id: character.id, name: character.name, refHash: character.refHash, referenceCount: character.referenceFiles.length },
    universeId: cfg.universe.id,
    universe: { id: cfg.universe.id, name: cfg.universe.name, hash: cfg.universe.hash },
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
