import { mediaComplete, parseJson } from "../mediaLlm";
import type { Word } from "../transcribe";
import { characterBlock } from "./character";
import { universePlannerBlock, type UniverseProfile } from "./universe";
import type { CharacterProfile, StoryBible, StoryBeat, DisplayMode, BeatPurpose, Priority, ShotType, TransitionIntent } from "./types";

/**
 * Story Planner v2. Модель получает сценарий, чистую речь по фразам с временем, тему,
 * справку и постоянный Character Bible. Сначала понимает историю целиком (arc), потом
 * делит речь на смысловые биты и для каждого решает: AUTHOR / FULL_AI / HYBRID.
 * AI — только там, где сцена усиливает рассказ; identity Gudini модель не меняет.
 */

export const STORY_MODEL = process.env.AI_FILM_STORY_MODEL || "claude-sonnet-5";
export const STORY_VERSION = 3;

/** Границы AI-бита: короче — не прочитать, длиннее — одна сцена не удержит одно действие. */
export const MIN_AI_BEAT_SEC = 4;
export const MAX_AI_BEAT_SEC = 15;
export const MIN_BEAT_SEC = 2;

export type Phrase = { index: number; start: number; end: number; text: string };

export const MAX_PHRASE_SEC = 5;
export const MAX_PHRASE_WORDS = 14;

/**
 * Фразы из слов чистого таймлайна: по знакам конца предложения, по паузе ≥0.5 с,
 * по запятой после 6 слов, и жёстко — по длине (5 с или 14 слов).
 */
export function phrasesFromWords(words: Word[]): Phrase[] {
  const out: Phrase[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ index: out.length + 1, start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.word).join(" ").trim() });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push(w);
    const next = words[i + 1];
    const endsSentence = /[.!?…]$/.test(w.word);
    const comma = /[,;:—-]$/.test(w.word) && cur.length >= 6;
    const pause = next ? next.start - w.end >= 0.5 && cur.length >= 4 : false;
    const tooLong = cur.length >= MAX_PHRASE_WORDS || w.end - cur[0].start >= MAX_PHRASE_SEC;
    if (endsSentence || comma || pause || tooLong) flush();
  }
  flush();
  return out;
}

/** обратная совместимость с прежним именем */
export const sentencesFromWords = phrasesFromWords;

export function storySystemPrompt(character: CharacterProfile, universe: UniverseProfile, coverage: { target: number; max: number }): string {
  return `Ты режиссёр и сценарист коротких вертикальных роликов (9:16). Автор ролика говорит на камеру непрерывно; его голос и субтитры идут весь ролик. Ты решаешь, что зритель ВИДИТ: самого автора (AUTHOR), AI-сцену на весь экран (FULL_AI) или AI-сцену в карточке над автором (HYBRID). AI генерируется дорого и не должен покрывать весь ролик: ориентир ${Math.round(coverage.target * 100)}% времени, не больше ${Math.round(coverage.max * 100)}%. Меньше — можно.

ГЛАВНЫЙ ГЕРОЙ ВСЕХ AI-СЦЕН — ПОСТОЯННЫЙ ПЕРСОНАЖ. Его identity задана и не меняется:
${characterBlock(character)}
Стиль всех сцен (зафиксирован): ${character.styleLock}.

${universePlannerBlock(universe)}

Ты описываешь только РОЛЬ ${character.name} в этой истории (глава клана, разведчик, наблюдатель событий, исследователь, герой визуальной метафоры), но визуально это всегда он: лицо, волосы, силуэт, цветовая схема и основной shinobi-образ не меняются; допустимы временная экипировка поверх, следы истории на одежде и предметы миссии. Никаких новых главных героев, generic people, «young entrepreneur» без связи с ним. Тема ролика переносится в его мир как понятная визуальная история: если ролик про игру, фильм, технологию или бизнес — покажи, как ${character.name} проживает это в правилах мира (миссия, испытание, находка, столкновение кланов), а не пересказывай чужой сюжет.

Сначала пойми историю целиком и заполни storyArc: что зритель должен понять; роль героя; начало; развитие; конфликт или изменение; кульминация; финальный смысл. Не перегружай символизмом: простая читаемая история.

Дополнительные персонажи: максимум 1–2 значимых на ролик, только если без них историю не показать; у каждого одна функция: opponent, guide, witness, partner, background. Не создавать толпы похожих людей, не путать, кто главный.

Раздели речь на биты по смыслу (обычно 4–12 с; биты покрывают ВСЕ фразы по порядку без пропусков и пересечений; границы — номера фраз). Для каждого бита выбери displayMode:
- "author": автор говорит панчлайн; важна его эмоция; плотное объяснение; прямой контакт со зрителем; AI ничего не добавляет.
- "full_ai": сильный hook; постановочная сцена; яркий пример; reveal; кульминация; история; визуальная метафора сильнее говорящей головы. AI-бит: 4–${MAX_AI_BEAT_SEC} с.
- "hybrid": полезно видеть автора и контекст одновременно; AI — дополнение. AI-бит: 4–${MAX_AI_BEAT_SEC} с.
Не злоупотребляй full_ai: обычно первым идёт hook на 5–8 с, дальше AI появляется 4–6 раз на 2 минуты речи.

Каждая AI-сцена: ONE SHOT = ONE CLEAR ACTION, понятная за 1–2 секунды. visualAction (английский) обязан содержать WHO (${character.name}), WHAT HE DOES, WHERE, WHAT CHANGES. Плохо: "${character.name} reflects on uncertainty while symbolic lights shift". Хорошо: "${character.name} enters an empty training ground. Every target post has fallen except one. He slowly picks up the single scroll left on it." Без десяти действий сразу, без сюрреалистического мусора, без текста/надписей/логотипов в кадре, без реальных известных людей, без названий франшиз, студий, фильмов и персонажей (описывай своими словами).
Кадр вертикальный 9:16 (для hybrid — горизонтальный 16:9): герой около центра по вертикали, запас над головой, ничего важного у краёв. shotType: close | medium | medium_wide | wide | full_body. Стейты: stateBefore/stateAfter (английский, коротко) — чтобы соседние сцены не противоречили (взял свиток — дальше он со свитком).
continuityGroup: одинаковая метка у ДВУХ соседних AI-битов только если это одна непрерывная сцена без монтажной склейки (вошёл → продолжает идти и находит предмет). Иначе null. Не строй длинные цепочки.
priority: "high" — hook, ключевой reveal, climax; "medium" — примеры, история; "low" — украшение, которое можно убрать без потери смысла. Бюджет ограничен: low-сцены уберут первыми.
transition: "cut" (по умолчанию) или "dissolve" (редко).
purpose: hook | setup | explain | example | reveal | emotion | transition | climax | resolution.

Ответь только JSON:
{"storyArc": {"understand": "...", "gudiniRole": "...", "beginning": "...", "development": "...", "conflict": "...", "climax": "...", "meaning": "..."},
 "bible": {"mood": "english", "lighting": "english", "cameraLanguage": "english", "locations": ["english"], "importantObjects": ["english"], "supportingCharacters": [{"name": "...", "function": "opponent|guide|witness|partner|background", "appearance": "english"}], "continuityRules": ["english", "..."]},
 "beats": [{"fromPhrase": 1, "toPhrase": 2, "meaning": "русский, 1 фраза", "storyBeat": "русский: место в истории", "displayMode": "author|full_ai|hybrid", "purpose": "...", "priority": "low|medium|high", "gudiniVisible": true, "universeAdaptation": "english: how the author's idea is translated into this world", "visualAction": "english", "location": "english", "stateBefore": "english", "stateAfter": "english", "continuityGroup": null, "transition": "cut", "shotType": "medium", "camera": "english"}]}
Для author-битов universeAdaptation/visualAction/location/state можно оставить пустыми строками, gudiniVisible=false.`;
}

type RawBeat = {
  fromPhrase: number;
  toPhrase: number;
  meaning?: string;
  storyBeat?: string;
  displayMode?: string;
  purpose?: string;
  priority?: string;
  gudiniVisible?: boolean;
  universeAdaptation?: string;
  visualAction?: string;
  location?: string;
  stateBefore?: string;
  stateAfter?: string;
  continuityGroup?: string | null;
  transition?: string;
  shotType?: string;
  camera?: string;
};

type RawStory = { storyArc?: Partial<StoryBible["storyArc"]>; bible?: any; beats?: RawBeat[] };

const str = (v: unknown, d = "") => (typeof v === "string" && v.trim() ? v.trim() : d);
const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
const MODES: DisplayMode[] = ["author", "full_ai", "hybrid"];
const PURPOSES: BeatPurpose[] = ["hook", "setup", "explain", "example", "reveal", "emotion", "transition", "climax", "resolution"];
const SHOTS: ShotType[] = ["close", "medium", "medium_wide", "wide", "full_body"];
const FUNCS = ["opponent", "guide", "witness", "partner", "background"] as const;

export function normalizeBible(raw: RawStory, character: CharacterProfile, universe: UniverseProfile): StoryBible {
  const b = raw.bible ?? {};
  const a = raw.storyArc ?? {};
  const supporting = (Array.isArray(b.supportingCharacters) ? b.supportingCharacters : [])
    .map((c: any) => ({
      name: str(c?.name, "Supporting character"),
      function: (FUNCS as readonly string[]).includes(c?.function) ? c.function : "background",
      appearance: str(c?.appearance),
    }))
    .filter((c: any) => c.appearance)
    .slice(0, 2);
  return {
    characterId: character.id,
    universeId: universe.id,
    // стиль — из профиля персонажа, мир — из Universe Lock; модель их не меняет
    visualStyle: character.styleLock,
    world: `${universe.name}: ${universe.architecture}`,
    mood: str(b.mood, "calm, focused"),
    lighting: str(b.lighting, "soft natural light, consistent palette"),
    cameraLanguage: str(b.cameraLanguage, "steady medium shots, slow push-ins"),
    locations: arr(b.locations),
    importantObjects: arr(b.importantObjects),
    supportingCharacters: supporting,
    continuityRules: arr(b.continuityRules).slice(0, 8),
    storyArc: {
      understand: str(a.understand),
      gudiniRole: str(a.gudiniRole, `${character.name} lives the story`),
      beginning: str(a.beginning),
      development: str(a.development),
      conflict: str(a.conflict),
      climax: str(a.climax),
      meaning: str(a.meaning),
    },
  };
}

/**
 * Биты из ответа модели: границы по фразам → секунды; пропуски и пересечения чинятся;
 * биты встык от 0 до конца ролика; AI-биты короче MIN_AI_BEAT_SEC становятся author,
 * длиннее MAX_AI_BEAT_SEC режутся по фразам на независимые части.
 */
export function beatsFromRaw(raw: RawBeat[], phrases: Phrase[], duration: number): StoryBeat[] {
  if (!phrases.length) return [];
  const n = phrases.length;
  const clamp = (v: number) => Math.max(1, Math.min(n, Math.round(Number(v) || 1)));
  const items: { from: number; to: number; e: RawBeat }[] = [];
  let cursor = 1;
  for (const e of raw ?? []) {
    let from = clamp(e.fromPhrase);
    let to = clamp(e.toPhrase);
    if (to < from) to = from;
    if (from !== cursor) from = cursor;
    if (from > n) break;
    if (to < from) to = from;
    items.push({ from, to, e });
    cursor = to + 1;
  }
  if (!items.length) items.push({ from: 1, to: n, e: { fromPhrase: 1, toPhrase: n, displayMode: "author" } });
  if (cursor <= n) items[items.length - 1].to = n;

  // длинные AI-биты режем по фразам на части ≤ MAX_AI_BEAT_SEC
  const split: typeof items = [];
  for (const it of items) {
    const isAi = it.e.displayMode === "full_ai" || it.e.displayMode === "hybrid";
    const dur = phrases[it.to - 1].end - phrases[it.from - 1].start;
    if (!isAi || dur <= MAX_AI_BEAT_SEC || it.to === it.from) { split.push(it); continue; }
    let from = it.from;
    while (from <= it.to) {
      let to = from;
      while (to + 1 <= it.to && phrases[to].end - phrases[from - 1].start <= MAX_AI_BEAT_SEC) to++;
      if (to < it.to && phrases[it.to - 1].end - phrases[to].start < MIN_AI_BEAT_SEC) to = it.to;
      split.push({ from, to, e: { ...it.e, continuityGroup: null } });
      from = to + 1;
    }
  }

  const beats: StoryBeat[] = split.map((it, i) => {
    const e = it.e;
    let mode = (MODES as string[]).includes(String(e.displayMode)) ? (e.displayMode as DisplayMode) : "author";
    const start = phrases[it.from - 1].start;
    const end = phrases[it.to - 1].end;
    const isAi = mode !== "author";
    let reduced: string | undefined;
    if (isAi && !str(e.visualAction)) { mode = "author"; reduced = "нет действия в кадре"; }
    return {
      id: `B${i + 1}`,
      start,
      end,
      meaning: str(e.meaning),
      storyBeat: str(e.storyBeat),
      displayMode: mode,
      purpose: (PURPOSES as string[]).includes(String(e.purpose)) ? (e.purpose as BeatPurpose) : "explain",
      priority: (["low", "medium", "high"] as string[]).includes(String(e.priority)) ? (e.priority as Priority) : "medium",
      requiresGeneration: mode !== "author",
      gudiniVisible: mode !== "author" && e.gudiniVisible !== false,
      universeAdaptation: mode !== "author" ? str(e.universeAdaptation) : "",
      visualAction: str(e.visualAction),
      location: str(e.location),
      stateBefore: str(e.stateBefore),
      stateAfter: str(e.stateAfter),
      continuityGroup: mode !== "author" && typeof e.continuityGroup === "string" && e.continuityGroup.trim() ? e.continuityGroup.trim() : null,
      transition: (e.transition === "dissolve" ? "dissolve" : "cut") as TransitionIntent,
      shotType: (SHOTS as string[]).includes(String(e.shotType)) ? (e.shotType as ShotType) : "medium",
      camera: str(e.camera),
      suggestedDuration: Math.round((end - start) * 10) / 10,
      ...(reduced ? { reduced } : {}),
    };
  });

  // встык: с нуля, следующий начинается там, где кончился прошлый, последний — до конца ролика
  for (let i = 0; i < beats.length; i++) {
    beats[i].start = i === 0 ? 0 : beats[i - 1].end;
    if (i === beats.length - 1) beats[i].end = Math.max(beats[i].end, duration);
    if (beats[i].end < beats[i].start) beats[i].end = beats[i].start;
    beats[i].suggestedDuration = Math.round((beats[i].end - beats[i].start) * 10) / 10;
  }
  // AI-бит короче минимума — автор (AI за 2–3 секунды не прочитать)
  for (const b of beats) {
    if (b.displayMode !== "author" && b.end - b.start < MIN_AI_BEAT_SEC - 1e-6) {
      b.displayMode = "author";
      b.requiresGeneration = false;
      b.gudiniVisible = false;
      b.continuityGroup = null;
      b.reduced = `AI-бит короче ${MIN_AI_BEAT_SEC} с`;
    }
  }
  return beats;
}

export async function planStory(args: {
  words: Word[];
  script: string;
  topic?: string;
  researchSummary?: string;
  character: CharacterProfile;
  universe: UniverseProfile;
  duration: number;
  coverage: { target: number; max: number };
}): Promise<{ bible: StoryBible; beats: StoryBeat[]; phrases: Phrase[] }> {
  const phrases = phrasesFromWords(args.words);
  if (phrases.length < 2) throw new Error("AI-фильм: в речи меньше двух фраз — не из чего строить историю");
  const list = phrases.map((p) => `${p.index}. [${p.start.toFixed(1)}–${p.end.toFixed(1)} с] ${p.text}`).join("\n");
  const user =
    `${args.topic ? `Тема ролика: ${args.topic}\n` : ""}` +
    `${args.researchSummary ? `Справка по теме (факты, чтобы не выдумывать): ${args.researchSummary.slice(0, 1500)}\n\n` : ""}` +
    `Сценарий (что автор хотел сказать):\n${args.script.slice(0, 4000)}\n\n` +
    `Речь автора по фразам (чистый таймлайн, всего ${args.duration.toFixed(1)} с):\n${list}`;
  const raw = await mediaComplete({ model: STORY_MODEL, maxTokens: 16000, stage: "AI Film Story", system: storySystemPrompt(args.character, args.universe, args.coverage), user });
  const parsed = parseJson<RawStory>(raw, "AI Film Story");
  const bible = normalizeBible(parsed, args.character, args.universe);
  const beats = beatsFromRaw(parsed.beats ?? [], phrases, args.duration);
  if (!beats.length) throw new Error("AI Film Story: модель не вернула биты");
  return { bible, beats, phrases };
}
