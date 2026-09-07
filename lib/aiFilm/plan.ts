import type { AiFilmPlan, FilmEpisode, FilmScene, FilmSequence, StoryBible } from "./types";

/**
 * План AI-фильма: эпизоды → последовательности → сцены Veo с промптами.
 *
 * Последовательность — цепочка «первая сцена + продолжения», которую Veo растит из
 * одного видео (extension): так соседние сцены реально продолжают друг друга, а не
 * генерируются заново. Новая последовательность начинается на переходе new_sequence
 * или когда цепочка упёрлась в предел длины. Последовательность, разорванная только
 * пределом, начинается с последнего кадра предыдущей (image-to-video) — шов не виден.
 *
 * Сцены к эпизодам привязаны по времени: сцена получает промпт того эпизода, на который
 * приходится её середина, плюс состояние предыдущего эпизода — для непрерывности.
 * Фильм генерируется чуть длиннее речи и подрезается при сборке — без растяжения.
 */

export const PLAN_VERSION = 1;
export const VEO_MODEL = process.env.AI_FILM_MODEL || "veo-3.1-fast-generate-001";
/** цена секунды без звука; уточняется по счёту Google (в консоли), переопределяется env */
export const VEO_PRICE_PER_SEC = Number(process.env.AI_FILM_PRICE_PER_SEC ?? 0.15);
export const FIRST_SCENE_SECONDS = 8;
export const EXTEND_SECONDS = 7;
export const MAX_SEQUENCE_SECONDS = 148;
export const SECONDS_PER_CALL_MINUTES = 2.5;

export type PlanOptions = {
  model?: string;
  pricePerSec?: number;
  maxSequenceSeconds?: number;
  key: string;
};

const NEGATIVE = "No text, no captions, no subtitles, no logos, no watermarks, no split screen, no talking to camera.";

function characterBlock(b: StoryBible): string {
  const c = b.mainCharacter;
  if (!c) return "";
  const parts = [c.description, c.appearance, c.clothes, c.signature ? `Distinctive details always visible: ${c.signature}.` : ""].filter(Boolean);
  return `Main character (same person in every shot): ${parts.join(". ").replace(/\.\./g, ".")}`;
}

/** Промпт одной сцены: стиль → герой → действие эпизода → камера → непрерывность. */
export function scenePrompt(bible: StoryBible, episode: FilmEpisode, prev: FilmEpisode | null, mode: FilmScene["mode"]): string {
  const lines: string[] = [];
  lines.push(`Style: ${bible.visualStyle}. Mood: ${bible.mood}.`);
  const ch = characterBlock(bible);
  if (ch) lines.push(ch);
  if (mode === "extend" && prev) lines.push(`Continue the same shot without a cut. Previous state: ${prev.stateAfter || prev.visualAction}`);
  else if (mode === "image" && prev) lines.push(`The clip starts from the given frame and continues the action. Previous state: ${prev.stateAfter || prev.visualAction}`);
  else if (prev && episode.transition !== "new_sequence") lines.push(`Same story, next moment. Previous state: ${prev.stateAfter}`);
  lines.push(`Action: ${episode.visualAction}`);
  if (episode.location) lines.push(`Location: ${episode.location}.`);
  lines.push(`Camera: ${bible.cameraLanguage}.`);
  if (bible.continuityRules.length) lines.push(`Continuity: ${bible.continuityRules.slice(0, 6).join("; ")}.`);
  lines.push(NEGATIVE);
  return lines.join("\n");
}

/** Эпизод, на который приходится больше всего времени сцены. */
function episodeFor(episodes: FilmEpisode[], from: number, to: number): FilmEpisode {
  let best = episodes[0];
  let bestOverlap = -1;
  for (const e of episodes) {
    const ov = Math.min(e.end, to) - Math.max(e.start, from);
    if (ov > bestOverlap) { bestOverlap = ov; best = e; }
  }
  return best;
}

/** Группировка эпизодов в последовательности: разрыв на new_sequence или по пределу длины. */
export function groupSequences(episodes: FilmEpisode[], maxSeconds = MAX_SEQUENCE_SECONDS): { episodes: FilmEpisode[]; byLimit: boolean }[] {
  const groups: { episodes: FilmEpisode[]; byLimit: boolean }[] = [];
  let cur: FilmEpisode[] = [];
  let byLimit = false;
  const secondsFor = (span: number) => (span <= FIRST_SCENE_SECONDS ? FIRST_SCENE_SECONDS : FIRST_SCENE_SECONDS + Math.ceil((span - FIRST_SCENE_SECONDS) / EXTEND_SECONDS) * EXTEND_SECONDS);
  for (const e of episodes) {
    if (cur.length) {
      const span = e.end - cur[0].start;
      if (secondsFor(span) > maxSeconds) {
        groups.push({ episodes: cur, byLimit });
        cur = [];
        byLimit = true;
      }
    }
    cur.push(e);
    if (e.transition === "new_sequence") {
      groups.push({ episodes: cur, byLimit });
      cur = [];
      byLimit = false;
    }
  }
  if (cur.length) groups.push({ episodes: cur, byLimit });
  return groups;
}

export function buildFilmPlan(bible: StoryBible, episodes: FilmEpisode[], duration: number, opts: PlanOptions): AiFilmPlan {
  if (!episodes.length) throw new Error("AI-фильм: нет эпизодов для плана");
  const model = opts.model || VEO_MODEL;
  const pricePerSec = opts.pricePerSec ?? VEO_PRICE_PER_SEC;
  const maxSeq = opts.maxSequenceSeconds ?? MAX_SEQUENCE_SECONDS;
  const groups = groupSequences(episodes, maxSeq);
  const sequences: FilmSequence[] = [];
  let prevEpisode: FilmEpisode | null = null;
  groups.forEach((g, gi) => {
    const start = g.episodes[0].start;
    const last = g.episodes[g.episodes.length - 1];
    // последняя последовательность тянется до конца ролика, чтобы фильм не кончился раньше речи
    const end = gi === groups.length - 1 ? Math.max(last.end, duration) : last.end;
    const span = Math.max(1, end - start);
    const scenes: FilmScene[] = [];
    let t = 0;
    let idx = 0;
    while (t < span) {
      const seconds = idx === 0 ? FIRST_SCENE_SECONDS : EXTEND_SECONDS;
      const mode: FilmScene["mode"] = idx === 0 ? (g.byLimit && gi > 0 ? "image" : "text") : "extend";
      const ep = episodeFor(g.episodes, start + t, start + t + seconds);
      const epIndex = episodes.indexOf(ep);
      // предыдущий эпизод истории — для непрерывности (для первой сцены это конец прошлой последовательности)
      const prev: FilmEpisode | null = episodes[epIndex - 1] ?? prevEpisode;
      scenes.push({
        id: `S${gi + 1}-${idx + 1}`,
        sequence: gi,
        index: idx,
        episodeId: ep.id,
        prompt: scenePrompt(bible, ep, prev, mode),
        seconds,
        mode,
      });
      t += seconds;
      idx++;
    }
    sequences.push({ index: gi, scenes, start, end, seconds: scenes.reduce((a, s) => a + s.seconds, 0) });
    prevEpisode = last;
  });
  const totalSeconds = sequences.reduce((a, s) => a + s.seconds, 0);
  const calls = sequences.reduce((a, s) => a + s.scenes.length, 0);
  return {
    version: PLAN_VERSION,
    createdAt: new Date().toISOString(),
    model,
    pricePerSec,
    key: opts.key,
    duration,
    bible,
    episodes,
    sequences,
    totalSeconds,
    estimatedCost: Math.round(totalSeconds * pricePerSec * 100) / 100,
    calls,
    estimatedMinutes: Math.ceil(calls * SECONDS_PER_CALL_MINUTES),
  };
}

/** Ключ кэша сцены: модель + промпт + режим + секунды + ключ источника (для extend/image — предыдущей сцены). */
export function sceneKey(scene: FilmScene, model: string, sourceKey: string | null): string {
  return `${model}|${scene.mode}|${scene.seconds}|${sourceKey ?? "-"}|${scene.prompt}`;
}
