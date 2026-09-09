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
/** Один независимый AI-бит — максимум один клип Veo на 8 с; длиннее только с continuityRequired. */
export const PREFERRED_MAX_AI_SHOT_SEC = 8;
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

${character.name} молчит, никогда не смотрит в камеру и не обращается к зрителю. Визуально он всегда один и тот же: лицо, волосы, силуэт и цветовая схема не меняются.

СКОЛЬКО ЛЮДЕЙ В КАДРЕ — РОВНО СТОЛЬКО, СКОЛЬКО В РЕЧИ. Это жёсткое правило.
- Речь про одного человека, безымянного или названного по имени («парень заказал», «Каспер прыгнул») → этого человека ИГРАЕТ ${character.name}. В кадре он ОДИН. В supportingCharacters этого человека НЕ добавлять: это тот же самый персонаж, а не второй. Имя героя истории запиши в bible.playedByGudini.
- Речь про мировых знаменитостей (Tony Stark, Thanos) → рисуй их самих; ${character.name} появляется рядом, только если речь подразумевает ещё одного участника, иначе gudiniVisible=false и playedByGudini пустой.
- Речь про двоих — двое, про троих — трое. Ни одного лишнего человека сверх этого.
- ЗАПРЕЩЕНО добавлять наблюдателей, свидетелей, прохожих, толпу и «кого-то рядом», кого нет в речи. Никаких фигур на заднем плане, которые просто смотрят.
Ничего не переводи в метафоры: если автор говорит про фильм, игру, компанию или человека — в кадре именно этот фильм, игра, компания, человек.

Сначала пойми историю целиком и заполни storyArc: что зритель должен понять; роль героя; начало; развитие; конфликт или изменение; кульминация; финальный смысл. Не перегружай символизмом: простая читаемая история.

Персонажи истории (supportingCharacters): ТОЛЬКО те, кого автор прямо называет или подразумевает, до 6 на ролик; у каждого имя, функция opponent, guide, witness, partner или background и короткое узнаваемое описание внешности. Если история про одного человека и его играет ${character.name}, список остаётся пустым. Не выдумывать людей ради «оживления» кадра.

Раздели речь на биты по смыслу (обычно 4–12 с; биты покрывают ВСЕ фразы по порядку без пропусков и пересечений; границы — номера фраз). Для каждого бита выбери displayMode:
- "author": автор говорит панчлайн; важна его эмоция; плотное объяснение; прямой контакт со зрителем; AI ничего не добавляет.
- "full_ai": сильный hook; постановочная сцена; яркий пример; reveal; кульминация; история; визуальная метафора сильнее говорящей головы. AI-бит: 4–${PREFERRED_MAX_AI_SHOT_SEC} с.
- "hybrid": полезно видеть автора и контекст одновременно; AI — дополнение. AI-бит: 4–${PREFERRED_MAX_AI_SHOT_SEC} с.
Длина AI-бита: один AI-бит = один клип Veo на 8 секунд, поэтому предпочитай 7–8 с (короче — секунды клипа пропадают). Если смысловой блок речи длиннее 8 с — НЕ растягивай AI на весь блок: выбери самую сильную часть (по фразам) до 8 с, остальное отдай "author", либо разбей блок на AI + author. Голос автора идёт непрерывно, AI не обязан закрывать весь смысл. Второй независимый AI-бит подряд — только если визуально нужна новая сцена.
continuityRequired: true только если действие обязано быть непрерывным без склейки (вошёл → идёт → находит) и не помещается в 8 с; тогда допустим бит до ${MAX_AI_BEAT_SEC} с (клип 8 с + продолжение 7 с). Это дорого — используй редко.
Не злоупотребляй full_ai: обычно первым идёт hook на 5–8 с, дальше AI появляется 4–6 раз на 2 минуты речи.

Каждая AI-сцена: ONE SHOT = ONE CLEAR ACTION, понятная за 1–2 секунды. visualAction (английский) обязан содержать WHO, WHAT HE DOES, WHERE, WHAT CHANGES.

ПРЕДМЕТЫ ИЗ РЕЧИ НАЗЫВАЙ ТОЧНО. Если в речи есть вещь, она в кадре именно такая, какой её назвали, со своими приметами: «заказал за 5 долларов на маркетплейсе» → телефон в руке, на экране карточка товара с ценой и кнопкой заказа; пришедшая посылка → картонная коробка с почтовой наклейкой и пупыркой внутри. Обобщения запрещены: не «a small package», не «an object», не «some gear» — генератор дорисовывает вместо них случайный мусор (в прошлом ролике получился пакет чипсов).

motion (английский) — раскадровка движения внутри клипа по секундам, три отрезка: «0-3s: … 3-6s: … 6-8s: …». В каждом отрезке: что делает тело, куда движется камера, что происходит с предметами и одеждой. Физика настоящая: падение ускоряется, ткань и волосы бьёт ветром, обрывки уносит назад и вверх мимо камеры, ничто не висит в воздухе. Без замедления, если оно не нужно по смыслу. Плохо: "${character.name} reflects on uncertainty while symbolic lights shift". Хорошо: "${character.name} enters an empty training ground. Every target post has fallen except one. He slowly picks up the single scroll left on it." Без десяти действий сразу, без сюрреалистического мусора, без текста/надписей/логотипов в кадре, без крови и графического насилия. Известные персонажи и реальные люди в кадре рисуются как персонажи этого аниме: называй их прямо по имени (Tony Stark, Thanos, Bucky Barnes, Captain America, Doctor Doom) и добавляй короткий узнаваемый облик («Tony Stark in his red-and-gold armor with a glowing chest reactor», «Thanos, a giant purple titan with a golden gauntlet», «Bucky Barnes with his silver metal arm») — генератор знает, кто это. Места берутся из истории (город, поле битвы, лаборатория, корабль), деревня ниндзя не обязательна.
Кадр вертикальный 9:16 (для hybrid — горизонтальный 16:9): герой около центра по вертикали, запас над головой, ничего важного у краёв. shotType: close | medium | medium_wide | wide | full_body. Стейты: stateBefore/stateAfter (английский, коротко) — чтобы соседние сцены не противоречили (взял свиток — дальше он со свитком).
continuityGroup: одинаковая метка у ДВУХ соседних AI-битов только если это одна непрерывная сцена без монтажной склейки (вошёл → продолжает идти и находит предмет). Иначе null. Не строй длинные цепочки.
priority: "high" — hook, ключевой reveal, climax; "medium" — примеры, история; "low" — украшение, которое можно убрать без потери смысла. Бюджет ограничен: low-сцены уберут первыми.
transition: "cut" (по умолчанию) или "dissolve" (редко).
purpose: hook | setup | explain | example | reveal | emotion | transition | climax | resolution.

Ответь только JSON:
{"storyArc": {"understand": "...", "gudiniRole": "...", "beginning": "...", "development": "...", "conflict": "...", "climax": "...", "meaning": "..."},
 "bible": {"mood": "english", "lighting": "english", "cameraLanguage": "english", "locations": ["english"], "importantObjects": ["english"], "playedByGudini": "имя героя истории, которого играет ${character.name}, или пустая строка", "supportingCharacters": [{"name": "...", "function": "opponent|guide|witness|partner|background", "appearance": "english"}], "continuityRules": ["english", "..."]},
 "beats": [{"fromPhrase": 1, "toPhrase": 2, "meaning": "русский, 1 фраза", "storyBeat": "русский: место в истории", "displayMode": "author|full_ai|hybrid", "purpose": "...", "priority": "low|medium|high", "gudiniVisible": true, "universeAdaptation": "english: how the author's idea is translated into this world", "visualAction": "english", "motion": "english: 0-3s: ... 3-6s: ... 6-8s: ...", "location": "english", "stateBefore": "english", "stateAfter": "english", "continuityGroup": null, "continuityRequired": false, "transition": "cut", "shotType": "medium", "camera": "english"}]}
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
  motion?: string;
  location?: string;
  stateBefore?: string;
  stateAfter?: string;
  continuityGroup?: string | null;
  continuityRequired?: boolean;
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

/** Имя героя истории в текстах сцен заменяется на имя постоянного персонажа. */
export function renameHeroToCharacter(beats: StoryBeat[], hero: string, characterName: string): number {
  const name = hero.trim();
  if (!name || name.toLowerCase() === characterName.toLowerCase()) return 0;
  const safe = name.replace(/[^A-Za-z0-9 ]/g, "").trim();
  const re = safe ? new RegExp("\\b" + safe + "('s|’s)?" + "\\b", "gi") : null;
  if (!re) return 0;
  let count = 0;
  const fix = (v: string) =>
    v.replace(re, (m) => {
      count++;
      return /['’]s$/.test(m) ? `${characterName}'s` : characterName;
    });
  for (const b of beats) {
    b.visualAction = fix(b.visualAction);
    b.motion = fix(b.motion);
    b.stateBefore = fix(b.stateBefore);
    b.stateAfter = fix(b.stateAfter);
    b.universeAdaptation = fix(b.universeAdaptation);
  }
  return count;
}

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
    .slice(0, 6);
  // Тот, кого играет постоянный персонаж, — это он сам, а не второй человек в кадре.
  // Без этого планировщик писал «Гудини играет Каспера» и одновременно заводил Каспера
  // отдельным персонажем, и в кадре оказывалось двое.
  const playedByGudini = str(b.playedByGudini);
  const cast = playedByGudini
    ? supporting.filter((c: any) => c.name.toLowerCase() !== playedByGudini.toLowerCase())
    : supporting;
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
    supportingCharacters: cast,
    playedByGudini,
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

  // длинный AI-бит режем по фразам: AI остаётся только первая часть (≤ MAX_AI_BEAT_SEC),
  // остальное — автор. Две одинаковые сцены подряд с одним промптом — это не история,
  // а дубль за деньги (план «Думсдей» получил один и тот же кадр дважды).
  const split: (typeof items[number] & { tail?: boolean })[] = [];
  for (const it of items) {
    const isAi = it.e.displayMode === "full_ai" || it.e.displayMode === "hybrid";
    const dur = phrases[it.to - 1].end - phrases[it.from - 1].start;
    if (!isAi || dur <= MAX_AI_BEAT_SEC || it.to === it.from) { split.push(it); continue; }
    let to = it.from;
    while (to + 1 <= it.to && phrases[to].end - phrases[it.from - 1].start <= MAX_AI_BEAT_SEC) to++;
    // хвост любой длины — автор: для author-бита минимума нет
    split.push({ from: it.from, to, e: it.e });
    if (to < it.to) split.push({ from: to + 1, to: it.to, e: { ...it.e, displayMode: "author", continuityGroup: null, continuityRequired: false }, tail: true });
  }

  const beats: StoryBeat[] = split.map((it, i) => {
    const e = it.e;
    let mode = (MODES as string[]).includes(String(e.displayMode)) ? (e.displayMode as DisplayMode) : "author";
    const start = phrases[it.from - 1].start;
    const end = phrases[it.to - 1].end;
    const isAi = mode !== "author";
    let reduced: string | undefined;
    if (isAi && !str(e.visualAction)) { mode = "author"; reduced = "нет действия в кадре"; }
    if (it.tail) reduced = `продолжение AI-бита длиннее ${MAX_AI_BEAT_SEC} с — автор`;
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
      motion: mode !== "author" ? str(e.motion) : "",
      stateBefore: str(e.stateBefore),
      stateAfter: str(e.stateAfter),
      continuityGroup: mode !== "author" && typeof e.continuityGroup === "string" && e.continuityGroup.trim() ? e.continuityGroup.trim() : null,
      continuityRequired: mode !== "author" && (e.continuityRequired === true || (typeof e.continuityGroup === "string" && e.continuityGroup.trim().length > 0)),
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
  // без скрытых размышлений: на речи в 124 с модель потратила на них все 16 000 токенов и не выдала текст
  const raw = await mediaComplete({ model: STORY_MODEL, maxTokens: 16000, stage: "AI Film Story", reasoning: "off", system: storySystemPrompt(args.character, args.universe, args.coverage), user });
  const parsed = parseJson<RawStory>(raw, "AI Film Story");
  const bible = normalizeBible(parsed, args.character, args.universe);
  const beats = beatsFromRaw(parsed.beats ?? [], phrases, args.duration);
  if (!beats.length) throw new Error("AI Film Story: модель не вернула биты");
  // Герой истории и постоянный персонаж — один человек: в тексте сцен остаётся одно имя,
  // иначе Veo рисует и «Каспера», и Гудини рядом.
  renameHeroToCharacter(beats, bible.playedByGudini, args.character.name);
  return { bible, beats, phrases };
}
