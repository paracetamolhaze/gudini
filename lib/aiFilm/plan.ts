import crypto from "crypto";
import { characterBlock } from "./character";
import { universePromptBlock, type UniverseProfile } from "./universe";
import { veoPricePerSecond, round2 } from "./pricing";
import { normalizeVeoDuration, VEO_EXTEND_SECONDS } from "./veo";
import { auditPlan } from "./audit";
import { storySystemPrompt } from "./story";
import type {
  AiFilmPlan, BeatPurpose, CameraAngle, CharacterProfile, Composition, ContinuityGroup, EventDeadline, FilmShot, ObjectState, PlanIssue, PlanStats, StagingMode, StoryBeat, StoryBible, TimelineSegment,
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

/**
 * Можно ли снять два действия одним непрерывным кадром. Разное место снять без склейки
 * нельзя вообще; разная точка съёмки означает две разные сцены, а не одну.
 */
export function compatibleInOneShot(a: StoryBeat, b: StoryBeat): boolean {
  const place = (s: string) => s.trim().toLowerCase();
  if (place(a.location) && place(b.location) && place(a.location) !== place(b.location)) return false;
  if (a.cameraAngle !== b.cameraAngle) return false;
  if (a.displayMode !== b.displayMode) return false;
  return true;
}

/** Совместимый префикс окна: первый бит и всё, что снимается вместе с ним. */
export function compatiblePrefix(window: StoryBeat[]): StoryBeat[] {
  const out = [window[0]];
  for (let i = 1; i < window.length; i++) {
    if (!compatibleInOneShot(out[out.length - 1], window[i])) break;
    out.push(window[i]);
  }
  return out;
}

export type { EventDeadline } from "./types";

/**
 * Сроки КАЖДОГО события клипа отдельно. Прежняя версия возвращала один якорь первого бита
 * и назначала его всем изменениям сразу: коробка и отзыв требовались к одной и той же секунде.
 *
 * Якорь за пределами показанного отрезка не округляется, а отбрасывается: требовать событие
 * на десятой секунде восьмисекундного клипа бессмысленно, и это отдельная проблема плана.
 */
export function eventDeadlines(beats: StoryBeat[], shotStart: number, shownSeconds: number): EventDeadline[] {
  const shotEnd = shotStart + shownSeconds;
  // Целая секунда внутри показанного отрезка. Раньше округление шло вверх, и клип, от которого
  // в монтаж идут 3.6 с, получал требование «к 4-й секунде» — за собственным краем.
  const limit = Math.floor(shownSeconds + 1e-6);
  const out: EventDeadline[] = [];
  for (const b of beats) {
    if (!b.keyMoment) continue;
    const rel = b.anchorAtSec == null ? null : Math.round((b.start + b.anchorAtSec - shotStart) * 10) / 10;
    // Изменение уже произошло в предыдущем клипе цепочки — требовать его снова незачем.
    if (rel != null && rel < -1e-6) continue;
    const continues = b.end > shotEnd + 0.05;
    // Бит продолжается в следующем клипе, а его изменение приходится туда же: в этом клипе
    // оно не «рано», его здесь просто нет. Прежде тот же keyMoment требовался и «рано»
    // в первом клипе, и на второй секунде продолжения.
    if (continues && (rel == null || rel > shownSeconds + 1e-6)) continue;
    const inside = rel != null && rel <= shownSeconds + 1e-6;
    const bySec = inside && limit >= 1 ? Math.max(1, Math.min(Math.round(rel!), limit)) : null;
    out.push({
      beatId: b.id,
      eventIds: b.eventIds ?? [],
      keyMoment: b.keyMoment,
      bySec,
      // якорь есть, но приходится за пределы показанного отрезка: сцену нужно переставить
      beyond: rel != null && rel > shownSeconds + 1e-6,
    });
  }
  return out;
}

/** Прежнее имя: срок первого события клипа. */
export function changeDeadline(beats: StoryBeat[], shotStart: number, shownSeconds = Number.POSITIVE_INFINITY): number | null {
  return eventDeadlines(beats, shotStart, shownSeconds).find((d) => d.bySec != null)?.bySec ?? null;
}

/**
 * Сводка сцены без тех её кусков, которые УЖЕ сказаны про конкретные предметы. Убирается
 * только настоящий повтор: кусок выбрасывается, если всё значимое в нём есть в состоянии
 * этого предмета. Прежняя версия удаляла любое предложение, где встретилось имя предмета,
 * и «держит футляр на коленях, сидя в узком кресле» исчезало целиком вместе с позой и креслом.
 */
export function withoutObjectClauses(summary: string, objects: ObjectState[] | undefined): string {
  const text = (summary ?? "").trim();
  if (!text || !objects?.length) return text;
  const words = (v: string) => new Set(v.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
  const covered = objects.map((o) => ({
    name: o.id.replace(/[-_]+/g, " ").toLowerCase(),
    said: new Set([...words(o.before), ...words(o.after), ...words(o.id.replace(/[-_]+/g, " "))]),
  }));
  return text
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const hit = covered.find((c) => c.name && part.toLowerCase().includes(c.name));
      if (!hit) return true;
      // остаётся, если несёт хоть что-то, чего в состоянии предмета не сказано
      return [...words(part)].some((w) => !hit.said.has(w));
    })
    .join(", ");
}

/**
 * Постановка ОДНОГО монтажного окна: единственная фаза, расстановка людей, реквизит,
 * механика и состояния. Всё, что уходит в запрос и в проверки, берётся отсюда.
 *
 * Появилось после того, как новые поля сцены читались у первого бита, участники считались
 * по старым текстовым полям, а фаза окна выводилась двумя независимыми флагами: объединение
 * двух битов теряло реквизит второго, в кадре оказывался «ровно один участник» при двух
 * названных людях, а продолжение одновременно объявляло изменение сделанным и несделанным.
 */
export type BeatPhase = "whole" | "start" | "aftermath";

export type WindowStaging = {
  /**
   * Фаза окна целиком: «aftermath», только если ВСЕ его биты — последствия. Одно окно
   * может нести последствия одного события и совершение другого, и это разные фазы.
   */
  phase: BeatPhase;
  /** фаза каждого бита окна: из неё собираются действие, движение, механика и состояния */
  beatPhases: { beatId: string; phase: BeatPhase }[];
  /** действия окна; starts — действие только начинается и завершится в продолжении */
  actions: { beatId: string; text: string; starts: boolean }[];
  /** действия, завершённые раньше: их повторять нельзя */
  done: { beatId: string; text: string; keyMoment: string }[];
  /** движение тех битов, действие которых здесь совершается */
  motions: string[];
  /** условия, которые держатся весь клип */
  throughout: string[];
  /** предметы, которые меняются в этом окне: они в кадре, но не в одном и том же виде */
  stateful: string[];
  /** условия, появляющиеся со второй фазы окна */
  later: string[];
  /** расстановка людей, по порядку битов окна */
  who: string[];
  /** механика той фазы, которую показывает это окно */
  mechanics: string[];
};

/**
 * Реквизит без фазы: если в тексте предмета названо состояние, которое в этой сцене меняется,
 * остаётся только сам предмет. «the folding phone, now fully open and flat» → «the folding
 * phone»: раскрытие покажет действие, а строка присутствия не обязана спорить с началом кадра.
 */
export function neutralProp(text: string, changing: ObjectState[]): string {
  const raw = (text ?? "").trim();
  if (!raw) return "";
  const words = (v: string) => new Set(v.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
  const head = raw.split(/,| now | already | already,|; /)[0].trim();
  const tail = raw.slice(head.length);
  if (!tail.trim()) return raw;
  const tailWords = words(tail);
  const assertsPhase = changing.some((o) => {
    const after = words(o.after);
    const before = words(o.before);
    // хвост говорит о конечном состоянии и не повторяет исходное — это фаза, а не примета
    const saysAfter = [...after].some((w) => tailWords.has(w) && !before.has(w));
    return saysAfter;
  });
  return assertsPhase ? head : raw;
}

export function composeWindow(beats: StoryBeat[], phases: BeatPhase[] | BeatPhase): WindowStaging {
  const list: BeatPhase[] = Array.isArray(phases) ? phases : beats.map(() => phases);
  const beatPhases = beats.map((b, i) => ({ beatId: b.id, phase: list[i] ?? "whole" }));
  const phase: BeatPhase = beatPhases.every((p) => p.phase === "aftermath")
    ? "aftermath"
    : beatPhases.some((p) => p.phase === "start")
      ? "start"
      : "whole";
  // Реквизит называет ПРЕДМЕТ, а не его фазу. Модель писала «the black folding phone, now
  // fully open and flat» в строку «присутствует весь кадр», и запрос одновременно требовал
  // начинать с полураскрытого телефона и держать раскрытый на протяжении всего клипа.
  // Состояние предмета приходит из objects и из действия, поэтому фаза здесь отрезается.
  const changing = beats.flatMap((b) => (b.objects ?? []).filter((o) => o.after.trim() && o.before.trim() && o.before.trim() !== o.after.trim()));
  const clean = (v: string[] | undefined) => (v ?? []).map((x) => neutralProp(x, changing)).filter(Boolean);
  const first = beats[0];
  const all = [...new Set([...clean(first.scene?.worn), ...clean(first.scene?.props)])];
  // Предмет, который в этом окне меняется, не может «держаться весь кадр»: у него есть до
  // и после. Прежде «burning wooden workbench» стоял в строке присутствия рядом с началом
  // кадра, где стол ещё цел. Такие предметы уходят в отдельную строку, привязанную к действию.
  const changingNames = new Set(changing.flatMap((o) => o.id.replace(/[-_]+/g, " ").split(" ").filter((w) => w.length >= 3)));
  const mentionsChanging = (t: string) => [...changingNames].some((w) => t.toLowerCase().includes(w));
  const throughout = all.filter((t) => !mentionsChanging(t));
  const stateful = all.filter((t) => mentionsChanging(t));
  const later: string[] = [];
  for (const b of beats.slice(1)) {
    for (const item of [...clean(b.scene?.worn), ...clean(b.scene?.props)]) {
      if (!throughout.includes(item) && !later.includes(item)) later.push(item);
    }
  }
  const who = [...new Set(beats.map((b) => b.scene?.who?.trim()).filter(Boolean) as string[])];
  // Завершённое действие не повторяется ни в действии, ни в движении, ни в механике —
  // и решается это ПО КАЖДОМУ БИТУ. Прежде фаза бралась у последнего бита окна, и клип
  // с последствием первого действия и совершением второго снова требовал сломать печать.
  const isDone = (i: number) => beatPhases[i].phase === "aftermath";
  const isStart = (i: number) => beatPhases[i].phase === "start";
  const actions = beats
    .map((b, i) => ({ beatId: b.id, text: b.visualAction, starts: isStart(i) }))
    .filter((_, i) => !isDone(i) && beats[i].visualAction);
  const done = beats
    .map((b, i) => ({ beatId: b.id, text: b.visualAction, keyMoment: b.keyMoment }))
    .filter((_, i) => isDone(i));
  // Движение и механика описывают ЗАВЕРШЁННЫЙ переход, поэтому берутся только у битов,
  // которые в этом окне действительно завершаются. Прежде окно с фазой «начало» просило
  // вынуть инструмент движением и механикой и тут же запрещало это до продолжения.
  const motions = beats.map((b, i) => (isDone(i) || isStart(i) ? "" : b.motion)).filter(Boolean);
  const mechanics = [...new Set(beats.map((b, i) => (isDone(i) || isStart(i) ? "" : b.scene?.mechanics?.trim() ?? "")).filter(Boolean))];
  return { phase, beatPhases, actions, done, motions, throughout, stateful, later, who, mechanics };
}

/** Состояния предметов сцены одной строкой: «main-canopy — packed and intact; parcel — sealed». */
export function stateLine(objects: ObjectState[] | undefined, side: "before" | "after"): string {
  return (objects ?? [])
    .map((o) => ({ id: o.id, text: side === "before" ? o.before : o.after }))
    .filter((o) => o.text)
    .map((o) => `${o.id.replace(/-/g, " ")} — ${o.text}`)
    .join("; ");
}

/**
 * Правила непрерывности, относящиеся именно к этой сцене. Раньше в промпт бытового кадра
 * уезжал весь список, включая указания про порванный купол, которого в кадре нет.
 */
export function applicableContinuity(rules: string[], objects: ObjectState[], text: string): string[] {
  if (!rules.length) return [];
  const words = new Set(
    [...objects.flatMap((o) => o.id.split("-")), ...text.toLowerCase().split(/[^a-z0-9]+/)].filter((w) => w.length >= 4),
  );
  return rules.filter((r) => {
    const rw = r.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    return rw.some((w) => words.has(w));
  });
}

/** Синтетическая сцена для отпечатка: любое изменение сборщика меняет её текст. */
const PROBE_BEAT: StoryBeat = {
  id: "probe", start: 0, end: 8, meaning: "", storyBeat: "", displayMode: "full_ai",
  purpose: "explain", priority: "medium", requiresGeneration: true, gudiniVisible: true,
  universeAdaptation: "", visualAction: "he opens a box", keyMoment: "the box opens",
  anchorPhrase: "", anchorAtSec: null, anchorAbsSec: null, eventIds: ["probe"], objects: [{ id: "box", before: "sealed", after: "open" }],
  location: "a room", motion: "he lifts the lid", stateBefore: "sealed", stateAfter: "open",
  continuityGroup: null, continuityRequired: false, transition: "cut", shotType: "medium", frameSubject: "",
  camera: "Camera is at eye level in front of him", cameraAngle: "eye_level", composition: "center",
  suggestedDuration: 8,
};

/**
 * Отпечаток режиссёрского промпта и сборщика запросов. Считается по их фактическому выводу,
 * поэтому меняется от любой правки инструкций или сборки — в отличие от номера версии,
 * который одиннадцать коммитов подряд оставался прежним, и сохранённый план со старыми
 * промптами считался актуальным.
 */
export function compilerFingerprint(character: CharacterProfile, universe: UniverseProfile, coverage = coverageConfig()): string {
  const bible: StoryBible = {
    characterId: character.id, universeId: universe.id, storyType: "explainer", staging: "everyday_life",
    reconstruction: false, visualStyle: character.styleLock, world: universe.name, mood: "calm",
    lighting: "daylight", cameraLanguage: "steady", locations: [], importantObjects: [],
    supportingCharacters: [], playedByGudini: "", continuityRules: ["the box stays the same colour"],
    storyArc: { understand: "", gudiniRole: "", beginning: "", development: "", conflict: "", climax: "", meaning: "" },
    events: [],
  };
  // Отпечаток считается по обеим веткам сборщика — одиночный клип и продолжение —
  // и по настоящим настройкам покрытия: прежде он брал константы 0.5/0.65, поэтому
  // смена ограничения покрытия меняла реальные промпты, не меняя отпечатка.
  const second: StoryBeat = { ...PROBE_BEAT, id: "probe2", start: 8, end: 14, visualAction: "he lifts the lid", keyMoment: "the lid comes off", anchorAtSec: 1, anchorAbsSec: 9 };
  const single = shotPrompt({ character, universe, bible, beats: [PROBE_BEAT], prev: null, mode: "text", aspectRatio: "9:16", deadlines: eventDeadlines([PROBE_BEAT], 0, 8), shownSeconds: 8 });
  const pair = shotPrompt({ character, universe, bible, beats: [PROBE_BEAT, second], prev: PROBE_BEAT, mode: "extend", aspectRatio: "16:9", deadlines: eventDeadlines([PROBE_BEAT, second], 0, 6), shownSeconds: 6 });
  return shortHash([storySystemPrompt(character, universe, coverage), single, pair, JSON.stringify(coverage)].join("\n---\n"));
}

/** Промпт shot: WHO / WHAT / WHERE / WHAT CHANGES, кадр, камера, непрерывность, запреты. */
export function shotPrompt(args: {
  character: CharacterProfile;
  universe: UniverseProfile;
  bible: StoryBible;
  prev: StoryBeat | null;
  /** биты, попадающие в этот клип, по порядку; первый задаёт кадр и камеру */
  beats: StoryBeat[];
  mode: "text" | "extend";
  aspectRatio: "16:9" | "9:16";
  /** сроки каждого события этого клипа */
  deadlines?: EventDeadline[];
  /** сколько секунд клипа реально попадёт в монтаж */
  shownSeconds?: number;
  /** изменение бита приходится на следующий клип цепочки: здесь действие только начинается */
  unfinished?: boolean;
  /** изменение уже произошло в предыдущем клипе цепочки: здесь идут его последствия */
  changeDone?: boolean;
  /** постановка этого окна: реквизит, расстановка, механика, фаза */
  staging?: WindowStaging;
  /** чем закончился предыдущий клип этой же цепочки */
  previousMoment?: string;
}): string {
  const { character, universe, bible, beats, prev, mode, aspectRatio, deadlines, shownSeconds, previousMoment } = args;
  // Фаза окна одна, и из неё следует всё остальное. Прежде «начало действия» и «последствия»
  // считались двумя независимыми флагами и могли оказаться истинными одновременно.
  const staging = args.staging ?? composeWindow(beats, args.changeDone ? "aftermath" : args.unfinished ? "start" : "whole");
  const unfinished = staging.phase === "start";
  const changeDone = staging.phase === "aftermath";
  const beat = beats[0];
  const lines: string[] = [];
  // Порядок важен: Veo сильнее слушает начало промпта, поэтому сперва действие и движение,
  // а стиль, мир и запреты уходят вниз. Раньше первые полторы тысячи знаков были служебными,
  // и на само действие оставалась одна фраза — отсюда выдуманные предметы в кадре.
  // Постановка сцены и состояния предметов — РАЗНЫЕ части условия, и одно не заменяет
  // другое. Прежде сюда шло `stateLine(objects) || stateBefore`, и непустой список предметов
  // молча выбрасывал сводку: из запроса про прыжок исчез надетый оранжевый ранец, потому что
  // в objects стоял только harness. Теперь сводка остаётся, а из неё убирается лишь то,
  // что уже сказано про конкретные предметы.
  const objectsBefore = stateLine(beat.objects, "before");
  const summaryBefore = withoutObjectClauses(beat.stateBefore, beat.objects);
  const before = [objectsBefore, summaryBefore].filter(Boolean).join("; ");
  if (mode === "extend") {
    // Момент, с которого продолжается кадр, — это конец ПРЕДЫДУЩЕГО КЛИПА, а не конец
    // всего бита. Раньше сюда уходило конечное состояние бита, и продолжение начиналось
    // с уже открытой коробки, снова требуя открыть закрытую.
    const from = previousMoment || prev?.stateAfter || prev?.visualAction || "the scene continues";
    lines.push(`Continue the same shot without a cut. Previous moment: ${from}.`);
  } else if (before) {
    lines.push(`Before: ${before}.`);
  }
  // Снаряжение и реквизит сцены: то, что обязано быть в кадре, даже если само не меняется.
  // Предмет, нужный действию, исчезал из запроса ровно потому, что у него не было перехода.
  if (staging.throughout.length) lines.push(`Present in frame throughout: ${staging.throughout.join("; ")}.`);
  if (staging.stateful.length) lines.push(`In frame, in the state the action describes at that moment: ${staging.stateful.join("; ")}.`);
  // Условие, которое появляется только во второй части окна, не выдаётся за условие всего клипа.
  if (staging.later.length) lines.push(`Appears with the later action in this clip: ${staging.later.join("; ")}.`);
  if (staging.who.length) lines.push(`Positions: ${staging.who.join(" Then: ")}.`);
  // Все действия клипа по порядку. Отсюда брался один «главный» бит, и второе действие
  // объединённой сцены исчезало из запроса, оставаясь только в списке идентификаторов.
  // Завершённые действия и действия этого окна разделены по битам. Прежде фаза бралась
  // у последнего бита: окно с последствием первого действия и совершением второго снова
  // требовало сломать печать, которая была сломана в предыдущем клипе.
  for (const d of staging.done) {
    lines.push(
      `Already done in the previous clip, do not repeat it${d.keyMoment ? `: do not show ${d.keyMoment} again` : ""}. ` +
        `That action stays finished: ${d.text}.`,
    );
  }
  if (!staging.actions.length) {
    const rest = stateLine(beat.objects, "after") || beat.stateAfter || beat.visualAction;
    lines.push(`This clip shows only what follows from it: ${rest}.`);
  } else if (staging.actions.length === 1) {
    const only = staging.actions[0];
    lines.push(only.starts ? `Action, of which only the beginning fits in this clip: ${only.text}` : `Action: ${only.text}`);
  } else {
    // Действие, которое в этом окне только начинается, помечается отдельно: иначе заголовок
    // «всё это внутри одного кадра» спорил с концом того же запроса, где оно запрещено.
    const anyStarts = staging.actions.some((a) => a.starts);
    lines.push(
      anyStarts
        ? `Action, in this order inside one continuous take; the last of them only begins here and finishes in the continuation:`
        : `Action, in this order and all of it inside one continuous take:`,
    );
    staging.actions.forEach((a, i) =>
      lines.push(`${i + 1}. ${a.text}${a.starts ? " — only the beginning of this, it is not finished inside this clip" : ""}`),
    );
  }
  // Одно изменение ради которого снимается сцена — сразу после действия и до всего
  // остального: у генератора должна быть одна цель, а не список равноправных задач.
  // Срок у КАЖДОГО изменения свой. Раньше все ключевые моменты клипа склеивались в одну
  // строку с общим сроком первого якоря: коробка и отзыв требовались к одной секунде.
  // Пустой список сроков — это не «сроков не передали», а «в этом клипе ничего не должно
  // завершиться»: так бывает у первого клипа цепочки, изменение которого приходится на
  // продолжение. Прежний запасной путь подставлял туда keyMoment бита, и одно и то же
  // изменение требовалось дважды: «рано» в первом клипе и к своей секунде во втором.
  const marks = deadlines ?? beats.filter((b) => b.keyMoment).map((b) => ({ beatId: b.id, eventIds: b.eventIds ?? [], keyMoment: b.keyMoment, bySec: null as number | null }));
  if (marks.length === 1) {
    const d = marks[0];
    lines.push(
      `The one thing that must be visible: ${d.keyMoment}.` +
        (d.bySec != null ? ` It has to be visible by second ${d.bySec} of the clip.` : " It happens early in the shot, not at the very end."),
    );
  } else if (marks.length > 1) {
    lines.push("What must be visible, each at its own time:");
    marks.forEach((d, i) =>
      lines.push(`${i + 1}. ${d.keyMoment}${d.bySec != null ? ` — by second ${d.bySec} of the clip` : " — early in the shot"}`),
    );
  }
  // Показанная длина входит в текст: один и тот же кадр на три и на восемь секунд — разные
  // задачи, и прежде промпт этого не различал вовсе.
  if (shownSeconds != null && shownSeconds > 0) {
    lines.push(`Only the first ${shownSeconds.toFixed(1)} seconds of this clip are used in the edit; everything above must happen inside them.`);
  }
  // Движение завершённого действия не повторяется: «he lifts the lid» после уже открытой
  // коробки — это второе открывание. Движение берётся по тем же битам, что и действие.
  if (staging.motions.length) lines.push(`Motion in order: ${staging.motions.join(" Then: ")}`);
  if (beat.location) lines.push(`Location: ${beat.location}.`);
  // Незавершённый кадр: изменение приходится на следующий клип цепочки, поэтому здесь
  // действие только начинается, а состояние к концу клипа остаётся исходным. Прежде сюда
  // уходило конечное состояние бита, и первый клип требовал того же, что и продолжение.
  const tail = beats[beats.length - 1];
  const tailPhase = staging.beatPhases[staging.beatPhases.length - 1]?.phase ?? "whole";
  const after = tailPhase === "start"
    ? stateLine(tail.objects, "before") || tail.stateBefore
    : stateLine(tail.objects, "after") || tail.stateAfter;
  if (after) {
    lines.push(tailPhase === "start" ? `At the end of this clip: ${after} — the action is still under way.` : `After: ${after}.`);
  }
  if (tailPhase === "start") {
    lines.push(
      `This clip is the beginning of a longer take: the action starts here and is NOT finished inside it. ` +
        `${tail.keyMoment ? `Do not show ${tail.keyMoment} in this clip — it happens in the continuation.` : "The change happens in the continuation."}`,
    );
  }
  const shot = beat.shotType.replace("_", "-");
  const ratio = aspectRatio === "9:16" ? "vertical 9:16 portrait composition" : "horizontal 16:9 composition";
  // Кадр строится вокруг доказательства события. Полный рост ведущего ничего не добавляет
  // там, где смысл сцены — шарнир, кнопка или место контакта.
  const subject = frameSubject(beat);
  lines.push(`Framing: ${ratio}, ${shot} shot${subject ? ` on ${subject}` : ""}. ${compositionLine(subject, beat.composition)}`);
  // В кадре должно быть ровно столько, чтобы событие читалось: иногда это весь предмет
  // целиком, иногда — место контакта крупно. Прежнее безусловное «всё названное целиком
  // в кадре» спорило с крупной деталью и заставляло отъезжать от самого важного.
  if (marks.length) {
    lines.push(`Frame it so that ${marks.map((d) => d.keyMoment).filter(Boolean).join("; ") || "the change named above"} is unmistakable on screen: whatever part of the action proves it must be inside the frame, large enough to read and not cropped away.`);
  }
  lines.push(`Camera angle: ${angleLine(subject, beat.cameraAngle)}.`);
  // точка planner-текста не удваивается: «onto the button.. Single continuous take» читается как опечатка
  lines.push(`Camera: ${(beat.camera || bible.cameraLanguage).replace(/[.;,\s]+$/, "")}. Single continuous take, no cuts inside the shot.`);
  lines.push(
    "Screen direction: keep the movement exactly as described relative to the camera. Do not turn the subject toward the lens " +
      "and do not have him run or jump into the camera unless the action says so.",
  );
  lines.push(STAGING_LINE[bible.staging]);
  // Механика именно этой сцены: что запускает действие, что с чем соприкасается, как меняется
  // опора и нагрузка. Общие слова «real physics» ничего не описывают и не спасают кадр, где
  // тело сохраняет одну позу в несовместимых состояниях, поэтому наблюдаемые указания сцены
  // идут первыми, а общая строка остаётся короткой подстраховкой.
  if (staging.mechanics.length) lines.push(`How it physically happens: ${staging.mechanics.join(" Then: ")}`);
  lines.push(
    "Bodies and materials behave as themselves: weight and inertia, contact where things touch, " +
      "nothing hovers or drifts in place, and the body posture changes with what supports it.",
  );
  lines.push(
    "Realism: true human proportions and joints, skin with real texture and no beauty smoothing, " +
      "one dominant light source with matching exposure and shadow direction.",
  );

  // Люди в кадре: только те, кого назвала речь. Наблюдателей и прохожих быть не должно —
  // в прошлом ролике рядом с героем истории каждый раз вырастал лишний зритель.
  const text = beats
    .map((b) => `${b.visualAction} ${b.motion} ${b.stateBefore} ${b.stateAfter} ${b.scene?.who ?? ""}`)
    .join(" ")
    .toLowerCase();
  const inScene = bible.supportingCharacters.filter((c) => mentionsPerson(c.name, text, bible.supportingCharacters.map((x) => x.name)));
  const cast: string[] = [];
  if (beats.some((b) => b.gudiniVisible)) cast.push(character.name);
  for (const c of inScene) cast.push(c.name);
  // Участники берутся из СОГЛАСОВАННОГО списка: постоянный персонаж и объявленные
  // персонажи истории, найденные в тексте окна (включая расстановку). Имена из свободного
  // текста больше не добываются: заглавная буква человека не доказывает, и «The», «On»
  // становились участниками, а «Alice Smith» — тремя людьми сразу.
  // Если расстановка называет кого-то ещё, точное число не заявляется: считать людей по
  // словам нельзя, а спорить с собственной строкой Positions — тем более.
  const byPositions = staging.who.length > 0;
  const who = byPositions
    ? `People taking part in the action: only those named above in Positions${cast.length ? ` (${cast.join(", ")} among them)` : ""}, and nobody else.`
    : `People taking part in the action: exactly ${cast.length || "as described above"}${cast.length ? ` — ${cast.join(", ")}` : ""}.`;
  // Запрет был абсолютным — «никаких людей на фоне вообще», — и спорил с разрешением
  // планировщика на естественный фон: улица и аэропорт выходили вымершими. Запрещаем
  // добавлять УЧАСТНИКОВ, а не всякое присутствие людей в общественном месте.
  lines.push(
    `${who} ` +
      "No other participants: nobody else acts, reacts, helps or watches the action. " +
      "Incidental passers-by are allowed only where the place would naturally have them, out of focus, never interacting with him and never looking at the camera.",
  );
  if (beats.some((b) => b.gudiniVisible)) {
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
  // Раньше запрещался интерфейс вообще, и заказ на телефоне показать было нечем. Запрещаем
  // читаемый текст, а не сам экран: действие с телефоном видно, содержимое — нет.
  lines.push(
    "Nothing readable in frame: no legible words, numbers, prices, documents or signage. " +
      "Using a phone or a screen is fine as long as what is on it stays unreadable.",
  );
  const applicable = applicableContinuity(bible.continuityRules, beats.flatMap((b) => b.objects ?? []), text);
  if (applicable.length) lines.push(`Continuity: ${applicable.slice(0, 6).join("; ")}.`);
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
    // Оставляемое окно выбирается ВОКРУГ обязательного момента, а не всегда с начала бита.
    // Прежде длинный бит обрезался по первым восьми секундам, и момент, который планировщик
    // привязал к своей реплике на 67-й секунде, оказывался в отрезанном хвосте: план получал
    // запрет за «событие звучит позже, чем заканчивается клип», хотя выбор модели был верным.
    let from = b.start;
    if (b.anchorAbsSec != null && b.anchorAbsSec > b.start + PREFERRED_MAX_AI_SHOT_SECONDS - 1) {
      const wanted = b.anchorAbsSec - (PREFERRED_MAX_AI_SHOT_SECONDS - 2);
      from = Math.max(b.start, Math.min(wanted, b.end - PREFERRED_MAX_AI_SHOT_SECONDS));
      from = Math.round(from * 100) / 100;
    }
    const cut = Math.round(Math.min(b.end, from + PREFERRED_MAX_AI_SHOT_SECONDS) * 100) / 100;
    const authorPart = (start: number, end: number, id: string) => ({
      ...b,
      id,
      start,
      end,
      displayMode: "author" as const,
      requiresGeneration: false,
      gudiniVisible: false,
      continuityGroup: null,
      continuityRequired: false,
      universeAdaptation: "",
      visualAction: "",
      location: "",
      suggestedDuration: Math.round((end - start) * 10) / 10,
      reduced: `часть AI-бита вне восьмисекундного окна — автор (без continuityRequired)`,
    });
    if (from > b.start + 0.05) out.push(authorPart(b.start, from, `${b.id}p`));
    // Момент внутри бита пересчитывается от нового начала окна: абсолютное время события
    // не изменилось, изменились границы клипа.
    const rel = b.anchorAbsSec == null ? null : Math.round((b.anchorAbsSec - from) * 10) / 10;
    out.push({
      ...b,
      start: from,
      end: cut,
      anchorAtSec: rel != null && rel >= -1e-6 && rel <= cut - from + 1e-6 ? Math.max(0, rel) : null,
      suggestedDuration: Math.round((cut - from) * 10) / 10,
    });
    if (cut < b.end - 0.05) out.push(authorPart(cut, b.end, `${b.id}a`));
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
    const prevBeat = beats[beats.indexOf(first) - 1] ?? null;
    const continuity = gBeats.some((b) => b.continuityRequired);
    // Каждый независимый запрос по тексту — своя группа со своим отрезком таймлайна.
    // Сборщик видео умеет склеивать только цепочку text → extend: второй text внутри
    // одной группы подменял собой исходник, и в ролик попадало только последнее видео,
    // а первая сцена исчезала молча — длина группы сходилась, содержимое нет.
    const segments: { id: string; shotIds: string[]; start: number; end: number }[] = [];
    let seg: { id: string; shotIds: string[]; start: number; end: number } | null = null;
    let covered = 0;
    let idx = 0;
    // true, когда прошлый клип оборвался на несовместимом бите: остаток группы — отдельная
    // сцена, а не продолжение. Раньше остаток просто пропадал: covered прыгал на всю длину
    // генерации, и второе действие исчезало из запросов, оставаясь «показанным» в таймлайне.
    let splitByIncompatibility = false;
    /** последний бит предыдущего клипа — по нему проверяется стык, а не только окно */
    let prevShotTail: StoryBeat | null = null;
    /** чем закончился предыдущий клип этой же цепочки */
    let prevShotEnd: string | null = null;
    /** биты, чьё изменение уже показано в этой цепочке: в продолжении его не повторяют */
    const doneBeats = new Set<string>();
    while (covered < span - 0.05) {
      const from = first.start + covered;
      // Бит, с которого начинается этот клип. Смена места ровно на границе окна раньше
      // не замечалась: compatiblePrefix сравнивает биты ВНУТРИ окна, а на стыке клипов
      // сравнивать было нечего, и сад становился «продолжением того же кадра» кухни.
      const head = gBeats.find((b) => b.end > from + 1e-6) ?? gBeats[gBeats.length - 1];
      const boundarySplit = prevShotTail != null && !compatibleInOneShot(prevShotTail, head);
      // Счётчик продолжений принадлежит ТЕКУЩЕЙ группе, а не всей группе битов: после
      // двух самостоятельных сцен третьей не доставалось продолжения, и её окно оставалось
      // без материала — план обещал десять секунд, а запрос был один на восемь.
      const chainStep = seg != null && continuity && !splitByIncompatibility && !boundarySplit;
      if (seg != null && !chainStep && !splitByIncompatibility && !boundarySplit) break;
      if (chainStep && seg!.shotIds.length > MAX_CHAIN_EXTENSIONS) break;
      const mode: FilmShot["mode"] = chainStep ? "extend" : "text";
      const veoSeconds = mode === "text"
        ? normalizeVeoDuration(Math.min(span - covered, 8), "text", { references: useReferences })
        : VEO_EXTEND_SECONDS;
      const to = Math.min(last.end, from + veoSeconds);
      // Все биты, попадающие в этот клип, по порядку. Раньше отсюда брался ОДИН бит с
      // наибольшим пересечением, а остальные оставались только в beatIds: из двух
      // последовательных действий «вскрывает посылку» и «достаёт парашют» в промпт уходило
      // первое, и второе действие просто исчезало из ролика.
      const inside = gBeats.filter((b) => b.end > from + 1e-6 && b.start < to - 1e-6);
      const window = inside.length ? inside : [gBeats.find((b) => b.end > from + 1e-6) ?? gBeats[gBeats.length - 1]];
      // Несовместимые по месту или точке съёмки действия в один непрерывный кадр не
      // объединяются: берём совместимый префикс, остальное уедет в следующий клип.
      const merged = compatiblePrefix(window);
      splitByIncompatibility = merged.length < window.length;
      const beat = merged[0];
      const prev = mode === "extend" ? (gBeats[gBeats.indexOf(beat) - 1] ?? beat) : prevBeat;
      const eventIds = [...new Set(merged.flatMap((b) => b.eventIds ?? []))];
      // Сколько секунд клипа реально попадёт в монтаж: от начала клипа до конца последнего
      // вошедшего бита, но не больше длины самого клипа.
      const shownSeconds = Math.round(Math.min(veoSeconds, Math.max(merged[merged.length - 1].end - from, 0)) * 100) / 100;
      const deadlines = eventDeadlines(merged, from, shownSeconds);
      // Действие последнего бита не помещается в этот клип целиком: изменение придёт
      // в продолжение, поэтому здесь оно не должно ни требоваться, ни считаться сделанным.
      // Но длина бита сама по себе этого не решает: если момент изменения приходится на ЭТОТ
      // клип, событие здесь и происходит, а дальше идёт его последствие.
      const tailId = merged[merged.length - 1].id;
      const changeHere = deadlines.some((d) => d.beatId === tailId && d.bySec != null);
      // Фаза окна решается ОДИН раз, и остальное следует из неё. Раньше «начало действия»
      // и «последствия» считались двумя независимыми флагами: в цепочке 8+7+7 второй клип
      // одновременно говорил «изменение уже произошло» и «футляр остаётся закрытым».
      // Фаза считается для КАЖДОГО бита окна: последствия одного события и совершение
      // другого спокойно живут в одном клипе, и различать их должен компилятор.
      const phases: BeatPhase[] = merged.map((b) => {
        const changeOfThisBeat = deadlines.some((d) => d.beatId === b.id && d.bySec != null);
        if (doneBeats.has(b.id) && !changeOfThisBeat) return "aftermath";
        return !changeOfThisBeat && b.end > from + shownSeconds + 0.05 ? "start" : "whole";
      });
      const staging = composeWindow(merged, phases);
      const unfinished = phases[phases.length - 1] === "start";
      if (mode === "text") {
        // конец отрезка — конец реально вошедших битов, а не длина генерации: клип на 8 с,
        // из которого в монтаж идут 4, занимает в ролике четыре секунды
        seg = { id: segments.length ? `G${gi + 1}s${segments.length + 1}` : `G${gi + 1}`, shotIds: [], start: from, end: from };
        segments.push(seg);
      }
      const owner = seg!;
      const shot: FilmShot = {
        id: `${owner.id}-${owner.shotIds.length + 1}`,
        groupId: owner.id,
        index: owner.shotIds.length,
        beatIds: merged.map((b) => b.id),
        displayMode,
        gudiniVisible: merged.some((b) => b.gudiniVisible),
        generationProfile: mode === "extend" ? "continuation" : beat.gudiniVisible ? "character" : "environment",
        model: groupModel,
        mode,
        usedSeconds: shownSeconds,
        veoSeconds,
        aspectRatio,
        resolution: RESOLUTION,
        useReferences: mode === "text" && useReferences,
        eventIds,
        changeBySec: deadlines.find((d) => d.bySec != null)?.bySec ?? null,
        deadlines,
        phases: staging.beatPhases,
        prompt: shotPrompt({
          character, universe: cfg.universe, bible, beats: merged, prev, mode, aspectRatio, deadlines, shownSeconds,
          staging, previousMoment: mode === "extend" ? prevShotEnd ?? undefined : undefined,
        }),
        dependsOn: mode === "extend" ? owner.shotIds[owner.shotIds.length - 1] : null,
        cost: round2(veoSeconds * priceOf(groupModel)),
      };
      shots.push(shot);
      owner.shotIds.push(shot.id);
      const tail = merged[merged.length - 1];
      // Конец клипа: либо достигнутое состояние, либо «действие ещё идёт» — с ним и будет
      // склеиваться продолжение.
      const reached = stateLine(tail.objects, "after") || tail.stateAfter || tail.visualAction;
      const midway = `${stateLine(tail.objects, "before") || tail.stateBefore || tail.visualAction} — the action is under way and ${tail.keyMoment || "the change"} has not happened yet`;
      prevShotEnd = unfinished ? midway : reached;
      // Завершённым считается тот бит, чьё изменение в этом окне действительно показано.
      staging.beatPhases.forEach((p) => { if (p.phase === "whole") doneBeats.add(p.beatId); });
      prevShotTail = tail;
      owner.end = Math.max(owner.end, Math.min(tail.end, from + shownSeconds));
      const advanced = Math.max(Math.min(tail.end - from, shownSeconds), 0.5);
      covered += Math.min(advanced, veoSeconds);
      idx++;
    }
    // последний отрезок дотягивается до конца группы битов, иначе в таймлайне останется щель
    if (segments.length) segments[segments.length - 1].end = Math.max(segments[segments.length - 1].end, last.end);
    for (const s of segments) {
      groups.push({ id: s.id, displayMode, start: s.start, end: s.end, shotIds: s.shotIds, chain: s.shotIds.length > 1, aspectRatio });
    }
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
 * ЧТО занимает кадр. Это решение планировщика (frameSubject): им может быть лицо, расстояние
 * между двумя людьми, место контакта пальца с кнопкой, движение толпы или пустое помещение.
 * Сборщик только переносит решение в запрос и своего героя кадра не назначает.
 *
 * Появилось после трёх снятых дублей: планировщик просил крупный кадр на руку и устройство,
 * а сборщик всё равно дописывал «человек в центре кадра с нормальным отступом над головой»
 * и «камера сверху вниз на него, вокруг видна земля». Два указания спорили в одном запросе.
 */
export function frameSubject(beat: Pick<StoryBeat, "frameSubject">): string {
  return (beat.frameSubject ?? "").trim().replace(/[.;]+$/, "");
}

/**
 * Где в кадре субъект и, главное, для чего оставлено место. Формулировка ничего не добавляет
 * от себя — ни отступа над головой, ни земли вокруг: только то, что означает выбор планировщика.
 */
export function compositionLine(subject: string, composition: Composition): string {
  const s = subject ? subject[0].toUpperCase() + subject.slice(1) : "What this shot is about";
  switch (composition) {
    case "low_space_above":
      return `${s} sits LOW in the frame, in the bottom third; the whole upper half stays clear for what is above, and that thing is shown whole, never cropped by the top edge.`;
    case "high_space_below":
      return `${s} sits HIGH in the frame, in the top third; the lower half stays clear for the ground or the drop below.`;
    case "offset_left":
      return `${s} sits in the left third of the frame; the right side stays open for what it faces or what approaches.`;
    case "offset_right":
      return `${s} sits in the right third of the frame; the left side stays open for what it faces or what approaches.`;
    case "subject_small_in_wide":
      return `${s} is small inside a wide view; the scale of the place is the point of this shot.`;
    default:
      return `${s} sits near the centre of the frame.`;
  }
}

/**
 * Откуда смотрит камера — тоже относительно субъекта кадра, а не относительно человека.
 * Прежний текст описывал только человека: «он вырастает на фоне неба», «вокруг него видна
 * земля». В сцене про кнопку это уводило камеру от кнопки.
 */
export function angleLine(subject: string, angle: CameraAngle): string {
  const s = subject || "the action";
  switch (angle) {
    case "low_angle":
      return `camera below ${s}, tilted up at it`;
    case "high_angle":
      return `camera above ${s}, tilted down at it`;
    case "overhead":
      return `camera directly above ${s}, looking straight down at it`;
    case "ground_level":
      return `camera down at surface level, close to ${s}`;
    case "over_shoulder":
      return `camera just behind the shoulder of the person doing it, seeing ${s} as he sees it`;
    case "profile":
      return `camera square to the side of ${s}, seeing it in clean profile`;
    default:
      return `camera level with ${s}, seeing it straight on`;
  }
}

/**
 * Есть ли в действии событие. Проверка именно такая, а не поиск статичных глаголов:
 * «садится за стол и вскрывает коробку» — это событие, хотя начинается со слова «садится».
 * Ловим отсутствие глагола изменения, а не присутствие глагола покоя.
 */
export const EVENT_ACTION =
  /\b(?:tears?|rips?|opens?|unpacks?|unwraps?|pulls?|yanks?|drops?|falls?|jumps?|leaps?|steps? off|lands?|throws?|tosses?|breaks?|snaps?|deploys?|inflates?|collapses?|catches?|hits?|slams?|spills?|pours?|cuts?|lifts?|pushes?|shoves?|closes?|clicks?|presses?|taps?|types?|hands?|slides?|swings?|kicks?|rolls?|crashes?|bursts?|shreds?|flips?|tips?|pours?|dumps?|grabs?|releases?|launches?|takes? off|climbs?|runs?|walks? (?:away|out|in|into|past)|turns? (?:on|off|over))\b/i;

/**
 * Существительные, которые пишутся как глаголы изменения: «looking down at the drop»
 * засчитывалось за событие из-за слова drop. Перед проверкой такие обороты вырезаются.
 */
const NOUN_HOMOGRAPH = /\b(?:the|a|an|his|her|its|that|this)\s+(?:drop|fall|land|landing|break|catch|cut|push|turn|roll|jump|step|climb|run|walk|throw|kick|swing|release|launch)s?\b/gi;

/** Есть ли в тексте настоящее действие, а не существительное, похожее на глагол. */
export function hasEvent(text: string): boolean {
  return EVENT_ACTION.test(text.replace(NOUN_HOMOGRAPH, " "));
}

/** Дольше этого зритель смотрит на говорящую голову без единой вставки — это провал удержания. */
export const MAX_AUTHOR_STRETCH_SECONDS = 12;
/** Позже этой секунды первая сцена уже не работает как hook. */
export const FIRST_SHOT_DEADLINE_SECONDS = 8;

/**
 * Куски ролика, где автор идёт слишком долго подряд. Считается по готовому таймлайну,
 * поэтому видит и то, что редьюсер снял по бюджету, и то, чего планировщик не показал.
 * Возвращает предупреждения, а не правит план: выдумать сцену за планировщика нельзя.
 */
export function authorStretchIssues(timeline: TimelineSegment[], duration: number): PlanIssue[] {
  const out: PlanIssue[] = [];
  const ai = timeline.filter((s) => s.mode !== "author");
  if (!ai.length) {
    if (duration > MAX_AUTHOR_STRETCH_SECONDS) {
      out.push({ code: "no-ai-scenes", severity: "block", beatIds: [], message: "В ролике нет ни одной показанной сцены — весь ролик говорящая голова" });
    }
    return out;
  }
  const first = ai[0].start;
  if (first > FIRST_SHOT_DEADLINE_SECONDS) {
    out.push({
      code: "first-scene-late",
      severity: "warn",
      beatIds: ai[0].beatIds,
      message: `Первая сцена появляется только на ${first.toFixed(1)} с — начало ролика без картинки не удержит зрителя`,
    });
  }
  const longs: string[] = [];
  let cursor = 0;
  for (const s of ai) {
    if (s.start - cursor > MAX_AUTHOR_STRETCH_SECONDS + 1e-6) longs.push(`${cursor.toFixed(1)}–${s.start.toFixed(1)} с`);
    cursor = Math.max(cursor, s.end);
  }
  if (duration - cursor > MAX_AUTHOR_STRETCH_SECONDS + 1e-6) longs.push(`${cursor.toFixed(1)}–${duration.toFixed(1)} с`);
  if (longs.length) {
    out.push({
      code: "author-stretch-long",
      severity: "warn",
      beatIds: [],
      message: `Длинные куски без сцен (больше ${MAX_AUTHOR_STRETCH_SECONDS} с): ${longs.join(", ")}`,
    });
  }
  return out;
}

/**
 * Окно группы, под которое не собрано материала. Раньше метаданные группы растягивались
 * поверх недостающих секунд: план обещал десятисекундный отрезок, запрос был один на восемь,
 * и расхождение всплывало только при сборке — уже после оплаты запросов.
 */
export function uncoveredGroupIssues(built: BuiltShots): PlanIssue[] {
  const out: PlanIssue[] = [];
  for (const g of built.groups) {
    const covered = built.shots.filter((s) => s.groupId === g.id).reduce((a, s) => a + s.usedSeconds, 0);
    const need = g.end - g.start;
    if (covered + 0.3 < need) {
      out.push({
        code: "group-not-covered",
        severity: "block",
        beatIds: built.shots.filter((s) => s.groupId === g.id).flatMap((s) => s.beatIds),
        message: `Отрезок ${g.start.toFixed(1)}–${g.end.toFixed(1)} с длиннее собранного материала (${covered.toFixed(1)} с): сцену нужно разделить или укоротить`,
      });
    }
  }
  return out;
}

/**
 * Назван ли ЭТОТ человек в тексте окна. Полное имя — доказательство; отдельная часть имени
 * годится, только если она не общая с другим объявленным персонажем.
 *
 * Прежде совпадало любое слово имени длиной от трёх букв, и при двух Смитах сцена с Alice
 * Smith получала ещё и Robert Smith вместе с его внешностью.
 */
export function mentionsPerson(name: string, text: string, declared: string[]): boolean {
  const low = text.toLowerCase();
  const full = name.trim().toLowerCase();
  if (!full) return false;
  if (containsWord(low, full)) return true;
  const parts = full.split(/[\s/()-]+/).filter((w) => w.length >= 3);
  const others = declared.filter((d) => d.trim().toLowerCase() !== full);
  return parts.some((w) => {
    const shared = others.some((d) => d.toLowerCase().split(/[\s/()-]+/).includes(w));
    return !shared && containsWord(low, w);
  });
}

/**
 * Встречается ли слово или имя ЦЕЛИКОМ, а не как часть другого слова. Без границ «bench»
 * приводил в кадр персонажа Ben, «Anna» — отсутствующую Ann, а «banner» — её же.
 * Границы считаются по буквам и цифрам любого алфавита: дефис и пробел словом не считаются,
 * поэтому «Jean-Luc Picard» находится целиком.
 */
export function containsWord(text: string, phrase: string): boolean {
  const p = phrase.trim().toLowerCase();
  if (!p) return false;
  const low = text.toLowerCase();
  const letter = (c: string) => c !== "" && /[\p{L}\p{N}]/u.test(c);
  for (let from = 0; ; from += 1) {
    const at = low.indexOf(p, from);
    if (at < 0) return false;
    const before = at > 0 ? low[at - 1] : "";
    const after = at + p.length < low.length ? low[at + p.length] : "";
    if (!letter(before) && !letter(after)) return true;
    from = at;
  }
}

/** Прежнее имя: те же нарушения структуры одними сообщениями. */
export function authorStretchWarnings(timeline: TimelineSegment[], duration: number): string[] {
  return authorStretchIssues(timeline, duration).map((i) => i.message);
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
    // Сцена, показывающая обязательное событие, снимается в последнюю очередь. Прежде
    // редьюсер смотрел только на приоритет и порядок: при бюджете на одну сцену он
    // оставлял необязательную вставку в начале и снимал обязательный отзыв, после чего
    // план блокировался как непокрытый — хотя за те же деньги он собирался целым.
    const requiredIds = new Set((bible.events ?? []).filter((e) => e.required && e.objects.length).map((e) => e.id));
    const carriesRequired = (b: StoryBeat) => (b.eventIds ?? []).some((id) => requiredIds.has(id));
    // Очередь жертв: сначала всё необязательное, потом открывающая сцена, и только потом
    // то, что несёт обязательное событие. Внутри каждой очереди порядок прежний:
    // low → medium → high, с конца ролика к началу.
    // Художественная защита (hook / reveal / climax с high) сильнее обычного порядка, но
    // слабее обязательного события: иначе необязательное вступление вытесняло обязательный
    // отзыв, план получал «событие не показано», хотя обратный выбор укладывался в те же деньги.
    // Защита снимается только ради обязательного события: если обязательных сцен в плане
    // нет, поведение прежнее — защищённую сцену не трогаем и честно сообщаем, что план
    // не помещается, вместо тихого удаления хука.
    const hasRequiredAi = work.some((b) => isAi(b) && carriesRequired(b));
    const tiers: Array<(b: StoryBeat) => boolean> = [
      (b) => !carriesRequired(b) && b !== earliest && !protectedBeat(b),
      (b) => !carriesRequired(b) && !protectedBeat(b),
      ...(hasRequiredAi
        ? [(b: StoryBeat) => !carriesRequired(b) && b !== earliest, (b: StoryBeat) => !carriesRequired(b)]
        : []),
      (b) => b !== earliest && !protectedBeat(b),
      (b) => !protectedBeat(b),
    ];
    let victim: StoryBeat | undefined;
    for (const allowed of tiers) {
      for (const p of order) {
        const candidates = work.filter((b) => isAi(b) && b.priority === p && allowed(b));
        if (candidates.length) { victim = candidates[candidates.length - 1]; break; }
      }
      if (victim) break;
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
  // Разбор идёт по битам ПОСЛЕ редьюсера и по собранным запросам: события пропадали
  // именно на этих шагах, а не в ответе модели.
  const issues: PlanIssue[] = [
    ...auditPlan(beats, bible, character, built.shots),
    ...authorStretchIssues(built.timeline, duration),
    ...uncoveredGroupIssues(built),
  ];
  const warnings = [...built.warnings];
  // Планировщик пишет русское имя героя в bible, а в английских полях зовёт его латиницей
  // («Каспер» → «Casper»), поэтому автозамена имени промахивается и в промпт уходят сразу
  // два человека: названный по имени герой и описание постоянного персонажа.
  // Сцена, в которой ничего не происходит. Человек, восемь секунд поправляющий лямку,
  // технически безупречен и совершенно не нужен: платим за клип, а событие рассказывает голос.
  // Сцена обстановки или реакции не обязана менять предмет: требование «в кадре должно
  // что-то ломаться» и заставляло планировщика выдумывать действия там, где истории нужен
  // результат или контекст. Спрашиваем изменение с тех сцен, которые заявили событие.
  const CONTEXT: BeatPurpose[] = ["setup", "transition", "emotion"];
  const idle = beats
    .filter((b) => isAi(b) && b.visualAction)
    .filter((b) => (b.eventIds ?? []).length > 0 || !CONTEXT.includes(b.purpose))
    .filter((b) => !hasEvent(`${b.visualAction} ${b.keyMoment}`) || (b.stateBefore && b.stateBefore === b.stateAfter))
    .map((b) => b.id);
  if (idle.length) warnings.push(`Сцены без события (${idle.join(", ")}): герой стоит или готовится, но ничего не меняется`);
  // Склейка внутри одной сцены. Veo снимает один непрерывный кадр, и «then cuts to» он
  // выполняет как умеет: либо игнорирует, либо ломает кадр пополам.
  const cuts = beats.filter((b) => isAi(b) && /\b(?:cuts? to|cut away|then we see|jump cut)\b/i.test(`${b.visualAction} ${b.motion}`)).map((b) => b.id);
  if (cuts.length) {
    // Это не пожелание, а невыполнимое указание, поэтому нарушение типизировано и видно
    // воротам перед оплатой: прежде оно жило строкой в warnings, ворота его не видели,
    // и план со склейкой доходил до запуска Veo.
    issues.push({
      code: "cut-inside-shot",
      severity: "block",
      beatIds: cuts,
      message: `Склейка внутри одной сцены (${cuts.join(", ")}): Veo снимает один непрерывный кадр, монтаж внутри него невозможен`,
    });
  }
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
  // Нарушения показываются тем же списком, что и раньше: сайт и лог читают warnings.
  warnings.push(...issues.map((a) => `${a.severity === "block" ? "ОБЯЗАТЕЛЬНО: " : ""}${a.message}${a.beatIds.length ? ` (${a.beatIds.join(", ")})` : ""}`));
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
    issues,
    compilerFingerprint: compilerFingerprint(character, cfg.universe),
  };
}

/** Старый план (другая версия схемы) — не интерпретировать, просить пересобрать. */
export function planVersionError(plan: { version?: number } | null | undefined): string | null {
  if (!plan) return null;
  if (plan.version !== PLAN_VERSION) return "AI Film plan устарел, пересоберите план";
  return null;
}
