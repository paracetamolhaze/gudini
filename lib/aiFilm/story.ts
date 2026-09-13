import { directorInstructions, researchContext } from "./directorPrompt";
import { mediaComplete, parseJson } from "../mediaLlm";
import type { Word } from "../transcribe";
import type { UniverseProfile } from "./universe";
import { STAGING_FOR } from "./types";
import { isDocumentary, mustShowEvent } from "./audit";
import type { CharacterProfile, StoryBible, StoryBeat, DisplayMode, BeatPurpose, Priority, ShotType, TransitionIntent, StoryType, CameraAngle, Composition, HoldKind, ObjectState, SceneState, StoryEvent, VisualTask } from "./types";

/**
 * Story Planner v2. Модель получает сценарий, чистую речь по фразам с временем, тему,
 * справку и постоянный Character Bible. Сначала понимает историю целиком (arc), потом
 * делит речь на смысловые биты и для каждого решает: AUTHOR / FULL_AI / HYBRID.
 * AI — только там, где сцена усиливает рассказ; identity Gudini модель не меняет.
 */

export const STORY_MODEL = process.env.AI_FILM_STORY_MODEL || "claude-sonnet-5";
/** 9 — общая процедура режиссуры: причинность, доказательство сцены, состояние, механика, камера. */
export const STORY_VERSION = 22;

/** Границы AI-бита: короче — не прочитать, длиннее — одна сцена не удержит одно действие. */
export const MIN_AI_BEAT_SEC = 4;
/**
 * Сколько секунд ПОКАЗА достаточно, чтобы прочитать событие. Клип у Veo всё равно не короче
 * четырёх секунд, но показать его можно меньше: распаковка и набранный отзыв читаются за три.
 * Раньше эти два ограничения были одним числом, и обязательные события выпадали из ролика.
 */
export const MIN_SHOWN_AI_SEC = 2.5;
export const MAX_AI_BEAT_SEC = 15;
/** Один независимый AI-бит — максимум один клип Veo на 8 с; длиннее только с continuityRequired. */
export const PREFERRED_MAX_AI_SHOT_SEC = 8;
export const MIN_BEAT_SEC = 2;
/**
 * Сколько секунд подряд зритель может смотреть на говорящую голову, прежде чем закроет ролик.
 * Планировщик собирал сцены в конце и оставлял первые двадцать секунд без единой вставки.
 */
export const MAX_AUTHOR_STRETCH_SEC = 12;

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

/**
 * Через сколько секунд от начала бита звучит якорная фраза. Ищется по пословной расшифровке:
 * номера фраз для этого слишком грубы, а именно к слову привязано видимое изменение.
 * null — слова в этом отрезке речи нет.
 */
export function anchorAbsolute(words: Word[], anchor: string, start: number, end: number): number | null {
  const target = anchor.toLowerCase().split(/\s+/).filter(Boolean);
  if (!target.length || !words.length) return null;
  const inside = words.filter((w) => w.end > start - 1e-6 && w.start < end + 1e-6);
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const flat = inside.map((w) => norm(w.word));
  const want = target.map(norm).filter(Boolean);
  for (let i = 0; i + want.length <= flat.length; i++) {
    if (want.every((t, k) => flat[i + k] === t)) {
      return Math.round(inside[i].start * 100) / 100;
    }
  }
  return null;
}

/** Прежнее имя: смещение якоря от начала отрезка. */
export function anchorOffset(words: Word[], anchor: string, start: number, end: number): number | null {
  const abs = anchorAbsolute(words, anchor, start, end);
  return abs == null ? null : Math.max(0, Math.round((abs - start) * 10) / 10);
}

export function storySystemPrompt(character: CharacterProfile, universe: UniverseProfile, coverage: { target: number; max: number }): string {
  return directorInstructions(character, universe, coverage.max) + `\n\nОтветь только JSON:
{"storyArc": {"understand": "...", "gudiniRole": "...", "beginning": "...", "development": "...", "conflict": "...", "climax": "...", "meaning": "..."},
 "bible": {"storyType": "news|history|philosophy|explainer", "mood": "english", "lighting": "english", "cameraLanguage": "english", "locations": ["english"], "importantObjects": ["english"], "playedByGudini": "имя героя, роль которого исполняет ${character.name}, или пустая строка", "supportingCharacters": [{"name": "...", "function": "opponent|guide|witness|partner|background", "appearance": "english"}], "continuityRules": ["english", "..."],
  "visualTasks": [{"id": "state", "learns": "русский: что зритель узнаёт из картинки", "role": "event|illustration|explanation", "fromPhrase": 1, "toPhrase": 2, "action": "english: one feasible observable action, empty for explanation"}],
  "events": [{"id": "order", "observable": "english: what the viewer sees change", "required": true, "basis": "confirmed|told|contradicted", "basisFact": "фраза из справки или пусто", "fromPhrase": 1, "toPhrase": 2, "objects": [{"id": "phone", "before": "english", "after": "english", "role": "change"}]}]},
 "beats": [{"fromPhrase": 1, "toPhrase": 2, "meaning": "русский, 1 фраза", "storyBeat": "русский: место в истории", "displayMode": "author|full_ai|hybrid", "purpose": "...", "priority": "low|medium|high", "gudiniVisible": false, "eventIds": ["order"], "visualTask": "state", "universeAdaptation": "english: what exactly from the speech is on screen", "visualAction": "english: who, where, what he does, what changes", "keyMoment": "english: the one visible change", "anchorPhrase": "слово из речи этого бита", "hold": "instant|settle|read", "motion": "english", "location": "english", "objects": [{"id": "parcel", "before": "english", "after": "english", "role": "change"}], "scene": {"who": "english", "worn": ["english"], "props": ["english"], "mechanics": "english"}, "stateBefore": "english", "stateAfter": "english", "continuityGroup": null, "continuityRequired": false, "transition": "cut", "shotType": "medium", "camera": "english", "cameraAngle": "eye_level|low_angle|high_angle|overhead|ground_level|over_shoulder|profile", "frameSubject": "english: what fills the frame", "composition": "center|low_space_above|high_space_below|offset_left|offset_right|subject_small_in_wide"}]}
Для author-битов universeAdaptation/visualAction/keyMoment/anchorPhrase/location/state/objects/scene оставляй пустыми, eventIds пустым списком, visualTask пустой строкой, gudiniVisible=false.`;
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
  keyMoment?: string;
  anchorPhrase?: string;
  hold?: string;
  visualTask?: string;
  motion?: string;
  location?: string;
  stateBefore?: string;
  stateAfter?: string;
  continuityGroup?: string | null;
  continuityRequired?: boolean;
  transition?: string;
  shotType?: string;
  camera?: string;
  cameraAngle?: string;
  frameSubject?: string;
  composition?: string;
  eventIds?: unknown;
  objects?: unknown;
  scene?: unknown;
};

export type RawStory = { storyArc?: Partial<StoryBible["storyArc"]>; bible?: any; beats?: RawBeat[]; visualTasks?: unknown; events?: unknown };

/**
 * Ограниченная корректировка: второй заход возвращает не новый план, а изменения к первому.
 * Сцена адресуется парой фраз из первого плана, событие и задача — идентификатором.
 * Связанные изменения вне замечаний объявляются в related с причиной, иначе не применяются.
 */
export type RawPatch = {
  bible?: { playedByGudini?: unknown; supportingCharacters?: unknown };
  events?: { update?: any[]; add?: any[]; remove?: unknown[] };
  visualTasks?: { update?: any[]; add?: any[]; remove?: unknown[] };
  beats?: { replace?: RawBeat[]; add?: RawBeat[]; remove?: { fromPhrase: number; toPhrase: number }[] };
  /** связанное изменение: что меняется, какому замечанию служит (for), почему без него нельзя */
  related?: { target?: unknown; for?: unknown; why?: unknown }[];
  note?: string;
};

/** Что второму заходу разрешено менять: адреса сцен, событий и задач из замечаний, роли. */
export type PatchScope = { beats: Set<string>; events: Set<string>; tasks: Set<string>; roles: boolean; phraseCount: number; characterName?: string };

const str = (v: unknown, d = "") => (typeof v === "string" && v.trim() ? v.trim() : d);
const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

/**
 * Идентификатор предмета или события: короткий слаг. Буквы любых алфавитов сохраняются:
 * прежняя версия вырезала кириллицу целиком, и событие с id «отзыв» молча исчезало из
 * контракта, а план с непокрытым событием становился «зелёным».
 */
const slugId = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

/**
 * Существенные условия сцены из ответа модели. Пустые поля не хранятся: обычному разговору
 * не нужны ни опоры, ни нагрузки, и заставлять модель заполнять одинаковую анкету на каждый
 * кадр — тот же способ получить формальный текст вместо постановки.
 */
export function sceneState(v: unknown): SceneState | undefined {
  const raw = (v ?? {}) as Record<string, unknown>;
  const line = (x: unknown) => (typeof x === "string" ? x.trim().slice(0, 300) : "");
  const list = (x: unknown) =>
    (Array.isArray(x) ? x : [])
      .map((i) => String(i).trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 6);
  const out: SceneState = {};
  const who = line(raw.who);
  const mechanics = line(raw.mechanics);
  const worn = list(raw.worn);
  const props = list(raw.props);
  if (who) out.who = who;
  if (mechanics) out.mechanics = mechanics;
  if (worn.length) out.worn = worn;
  if (props.length) out.props = props;
  return Object.keys(out).length ? out : undefined;
}

/** Состояния предметов сцены или события: без id состояние бесполезно, такие записи выбрасываем. */
export function objectStates(v: unknown): ObjectState[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: ObjectState[] = [];
  for (const raw of v) {
    const id = slugId((raw as any)?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Роль сохраняется как есть: модель прямо говорит, что условие сохраняется, а не
    // меняется. Прежде поле выбрасывалось здесь, и неизменная лампа снова становилась
    // обязательным переходом — правильный план блокировался.
    const role = (raw as any)?.role;
    out.push({
      id,
      before: str((raw as any)?.before),
      after: str((raw as any)?.after),
      ...(role === "change" || role === "keep" ? { role } : {}),
    });
  }
  return out.slice(0, 8);
}
const MODES: DisplayMode[] = ["author", "full_ai", "hybrid"];
const PURPOSES: BeatPurpose[] = ["hook", "setup", "explain", "example", "reveal", "emotion", "transition", "climax", "resolution"];
const SHOTS: ShotType[] = ["close", "medium", "medium_wide", "wide", "full_body"];
const FUNCS = ["opponent", "guide", "witness", "partner", "background"] as const;
const STORY_TYPES: StoryType[] = ["news", "history", "philosophy", "explainer"];
const ANGLES: CameraAngle[] = ["eye_level", "low_angle", "high_angle", "overhead", "ground_level", "over_shoulder", "profile"];
const COMPOSITIONS: Composition[] = ["center", "low_space_above", "high_space_below", "offset_left", "offset_right", "subject_small_in_wide"];

/**
 * Ракурс из текстового описания камеры. Планировщик пишет позицию камеры словами и
 * отдельно выбирает ракурс из списка, и эти два ответа расходятся: в промпт уходило
 * «камера строго сверху» и тут же «камера снизу, смотрит вверх». Veo пытался выполнить
 * оба и выворачивал тело. Текст конкретнее, поэтому правдой считается он.
 */
export function angleFromCameraText(text: string): CameraAngle | null {
  // Смотрим только на то, что сказано о КАМЕРЕ. «he falls straight down» — это движение
  // человека, и по нему нельзя решать, что камера висит сверху: ровно на этом определитель
  // ошибся и подтвердил противоречие вместо того, чтобы его снять.
  // Позицию камеры ищем сразу после слова camera. Свободный поиск слов «below» и «above»
  // по всей фразе ловит «the ground far below» и «the canopy above him» — это про мир,
  // а не про точку съёмки.
  const t = text.toLowerCase();
  // Планировщик часто называет ракурс прямо словами — это самое надёжное, что есть в тексте.
  if (/\blow[- ]angle\b/.test(t)) return "low_angle";
  if (/\bhigh[- ]angle\b/.test(t)) return "high_angle";
  if (/\boverhead\b|\btop[- ]down\b/.test(t)) return "overhead";
  if (/\bground[- ]level\b/.test(t)) return "ground_level";
  const at = /camera\s+(?:is\s+|sits\s+|stands\s+|hangs\s+|lies\s+|placed\s+)?(?:just\s+|slightly\s+|directly\s+|straight\s+|high\s+)*([a-z ]{0,18})/.exec(t);
  const pos = at?.[1] ?? "";
  if (/^(?:below|beneath|under)\b/.test(pos)) return "low_angle";
  if (/^(?:on the ground|at ground level)/.test(pos)) return "ground_level";
  if (/^above/.test(pos)) return /looking (?:straight )?down/.test(t) && /straight|directly/.test(t) ? "overhead" : "high_angle";
  if (/bird'?s.?eye|top-?down|camera looking straight down/.test(t)) return "overhead";
  // Дальше — фразы, которые ищем по всей клаузе о камере. «below» и «above» так искать
  // нельзя (это чаще про мир: земля внизу, купол вверху), а вот «за плечом» и «перед ним»
  // в описании камеры всегда про точку съёмки.
  const clause = t.split(";")[0];
  if (/over (?:his|the) shoulder|behind (?:his|the) shoulder|from behind him/.test(clause)) return "over_shoulder";
  if (/in profile|square to his side|beside him|alongside him/.test(clause)) return "profile";
  if (/level with (?:him|his)|at (?:his )?eye level|at (?:chest|desk|table) height/.test(clause)) return "eye_level";
  if (/to (?:one|the) side|off to the side|slightly to the side/.test(clause)) return "profile";
  if (/in front of (?:him|gudini)|facing him|opposite him/.test(clause)) return "eye_level";
  return null;
}

/**
 * Направление движения относительно камеры после её переноса сверху вниз. Слова «прочь от
 * камеры» и «к камере» меняются местами: камера теперь с другой стороны, а движение тела
 * осталось прежним.
 */
export function flipCameraRelativeMotion(motion: string): string {
  const MARK = "@@FLIP@@";
  return motion
    .replace(/\baway from (?:the camera|it)\b/gi, MARK)
    .replace(/\btowards? (?:the camera|it)\b/gi, "away from the camera")
    .replace(/\baway from camera\b/gi, MARK)
    .replace(/\btowards? camera\b/gi, "away from the camera")
    .split(MARK)
    .join("toward the camera")
    .replace(/\bout of the bottom of frame\b/gi, "past the camera");
}



/**
 * Ракурс и композиция не должны противоречить друг другу. Камера строго сверху и место
 * в кадре, оставленное НАД человеком, — это взаимоисключающие требования: то, что над ним,
 * находится между ним и камерой и просто закроет кадр.
 */
export function reconcileFraming(
  beat: Pick<StoryBeat, "camera" | "cameraAngle" | "composition"> & Partial<Pick<StoryBeat, "visualAction" | "keyMoment" | "motion">>,
): boolean {
  let changed = false;

  // Сначала самое грубое: важное происходит НАД человеком, а камера стоит сверху. Тогда
  // это важное окажется между ним и камерой и закроет кадр целиком. Просить планировщика
  // исправить это бесполезно, он повторяет ту же ошибку, поэтому камера переставляется здесь.
  // Действие важнее точки съёмки: ради него сцена и снимается.
  const objectAbove = /\babove (?:him|his head|gudini)\b|\boverhead\b/i.test(`${beat.visualAction ?? ""} ${beat.keyMoment ?? ""}`);
  const camAbove = angleFromCameraText(beat.camera) ?? beat.cameraAngle;
  if (objectAbove && (camAbove === "overhead" || camAbove === "high_angle")) {
    // Камера переезжает вниз, но ДЕЙСТВИЕ не выдумывается. Прошлая версия дописывала
    // «он падает к камере» в любую сцену — даже туда, где герой стоит на полу и поднимает
    // книгу над головой. Сохраняем собственное движение героя, только переворачивая
    // направление относительно камеры.
    const tail = beat.camera.includes(";") ? beat.camera.slice(beat.camera.indexOf(";") + 1).trim() : "";
    const moved = tail ? flipCameraRelativeMotion(tail) : "";
    beat.camera =
      "Camera is below him looking up, so that both he and what is above him stay in frame" +
      (moved ? `; ${moved}` : "");
    beat.cameraAngle = "low_angle";
    beat.composition = "low_space_above";
    if (beat.motion) beat.motion = flipCameraRelativeMotion(beat.motion);
    return true;
  }

  const inferred = angleFromCameraText(beat.camera);
  if (inferred && inferred !== beat.cameraAngle) {
    beat.cameraAngle = inferred;
    changed = true;
  }
  const above = beat.cameraAngle === "overhead" || beat.cameraAngle === "high_angle";
  const below = beat.cameraAngle === "ground_level" || beat.cameraAngle === "low_angle";
  if (inferred) {
    // Текст описания камеры — единственная правда, подстраивается композиция. Первая
    // версия правила делала наоборот и перебивала ракурс: в промпте оказывались
    // «камера сверху смотрит вниз» и тут же «ракурс снизу вверх».
    if (above && beat.composition === "low_space_above") { beat.composition = "high_space_below"; changed = true; }
    if (below && beat.composition === "high_space_below") { beat.composition = "low_space_above"; changed = true; }
    return changed;
  }
  // Позицию камеры из текста понять не удалось — тогда правит композиция.
  if (beat.composition === "low_space_above" && above) { beat.cameraAngle = "low_angle"; changed = true; }
  if (beat.composition === "high_space_below" && below) { beat.cameraAngle = "high_angle"; changed = true; }
  return changed;
}

/**
 * Имя героя истории в текстах сцен заменяется на имя постоянного персонажа.
 * Вызывается только когда bible.playedByGudini не пуст, а нормализатор очищает это поле
 * для новостей — так что реального участника события подмена больше не затрагивает.
 */
/** Слово целиком, без учёта регистра; имя с апострофом тоже считается упоминанием. */
function namesPerson(text: string, name: string): boolean {
  const safe = name.replace(/[^A-Za-z0-9 ]/g, "").trim();
  if (!safe) return false;
  return new RegExp("(?:^|[^A-Za-z])" + safe + "(?:'s|’s)?(?![A-Za-z])", "i").test(text);
}

/**
 * Присутствие персонажа следует из того, кто назван в кадре, а не из отдельного флага модели.
 * В плане про Трампа флаг стоял true на сцене, где по аллее шёл сам Трамп в костюме: проверка
 * костюма решила, что Гудини переодели, и второй заход выбросил человека из кадра. Состав
 * участников и флаг присутствия теперь одно решение: назван персонаж — он в кадре; назван только
 * другой человек — персонажа в кадре нет; никто не назван — остаётся решение модели.
 */
export function reconcileParticipants(beats: StoryBeat[], bible: Pick<StoryBible, "supportingCharacters">, characterName: string): number {
  const others = (bible.supportingCharacters ?? []).map((c) => c.name).filter(Boolean);
  let changed = 0;
  for (const b of beats) {
    if (b.displayMode === "author") continue;
    const inFrame = `${b.scene?.who ?? ""} ${b.visualAction} ${b.motion}`;
    const namedSelf = namesPerson(inFrame, characterName);
    // другой человек: участник из списка или имя с фамилией, кроме упоминаний в родительном падеже
    // («with Ivana Trump's name» — надпись, а не человек в кадре)
    const properNames = [...inFrame.matchAll(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b(?!['’]s)/g)].map((m) => m[1]).filter((n) => !namesPerson(n, characterName));
    const namedOther = others.some((n) => namesPerson(inFrame, n)) || properNames.length > 0;
    const visible = namedSelf ? true : namedOther ? false : b.gudiniVisible;
    if (visible !== b.gudiniVisible) changed++;
    b.gudiniVisible = visible;
  }
  return changed;
}

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
    b.keyMoment = fix(b.keyMoment);
    b.motion = fix(b.motion);
    b.stateBefore = fix(b.stateBefore);
    b.stateAfter = fix(b.stateAfter);
    b.universeAdaptation = fix(b.universeAdaptation);
  }
  return count;
}

export function normalizeBible(raw: RawStory, character: CharacterProfile, universe: UniverseProfile, researchFacts: string[] = []): StoryBible {
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
  const storyType: StoryType = (STORY_TYPES as readonly string[]).includes(b.storyType) ? (b.storyType as StoryType) : "explainer";
  // События — контракт содержания. Без id и наблюдаемого изменения событие ничего не проверяет,
  // такие записи не сохраняем: пустой контракт хуже отсутствующего, он создаёт ложную уверенность.
  // Списки контракта модель иногда выносит на верхний уровень ответа вместо bible: план тогда
  // выходил без событий и задач, хотя они были написаны. Принимаются оба места.
  const top = raw as any;
  const rawEvents: unknown[] = Array.isArray(b.events) ? b.events : Array.isArray(top?.events) ? top.events : [];
  const events: StoryEvent[] = rawEvents
    .map((e: any) => ({
      id: slugId(e?.id),
      observable: str(e?.observable),
      required: e?.required !== false,
      fromPhrase: Math.max(1, Math.round(Number(e?.fromPhrase) || 1)),
      toPhrase: Math.max(1, Math.round(Number(e?.toPhrase) || Number(e?.fromPhrase) || 1)),
      objects: objectStates(e?.objects),
      // статус факта: подтверждение и опровержение требуют цитаты из справки, разбор её сверяет
      basis: (e?.basis === "confirmed" || e?.basis === "contradicted" ? e.basis : "told") as StoryEvent["basis"],
      basisFact: str(e?.basisFact),
    }))
    // Битые записи НЕ выбрасываются: молча удалённое обязательное событие превращало
    // непокрытый план в «зелёный». Они доезжают до разбора и там становятся ошибкой контракта.
    // Полностью пустая запись тоже остаётся: прежний фильтр по «id или observable» убирал
    // её без следа, и рядом с одним исправным событием контракт выглядел целым.
    .filter((e: StoryEvent) => e.id || e.observable || e.objects.length)
    .slice(0, 12);
  // Тот, кого играет постоянный персонаж, — это он сам, а не второй человек в кадре.
  // Без этого планировщик писал «Гудини играет Каспера» и одновременно заводил Каспера
  // отдельным персонажем, и в кадре оказывалось двое.
  //
  // Роль героя истории исполняет персонаж канала, в том числе в новости: это заявленная
  // постановка, и флаг reconstruction ниже как раз про то, что кадр — переигранная сцена,
  // а не запись события. Ограничение одно и живёт в промпте: узнаваемого публичного
  // человека подменять собой нельзя, его показывают им самим.
  // Визуальные задачи всей истории: без id и понимания для зрителя задача ничего не решает.
  // Неизвестная роль читается как иллюстрация — так сцена не пропадает молча.
  const rawTasks: unknown[] = Array.isArray(b.visualTasks) ? b.visualTasks : Array.isArray(top?.visualTasks) ? top.visualTasks : [];
  const visualTasks: VisualTask[] = rawTasks
    .map((t: any) => {
      const role: VisualTask["role"] = t?.role === "event" || t?.role === "explanation" ? t.role : "illustration";
      return {
        id: slugId(t?.id),
        learns: str(t?.learns),
        role,
        fromPhrase: Math.max(1, Math.round(Number(t?.fromPhrase) || 1)),
        toPhrase: Math.max(1, Math.round(Number(t?.toPhrase) || Number(t?.fromPhrase) || 1)),
        action: role === "explanation" ? "" : str(t?.action),
      };
    })
    // Объяснение без learns остаётся: его роль и есть решение о ритме. Раньше такая задача
    // выбрасывалась, и проверка ритма не видела, что отрезок отдан объяснению, а не забыт.
    .filter((t) => t.id && (t.learns || t.role === "explanation"))
    .slice(0, 16);
  const playedByGudini = str(b.playedByGudini);
  const cast = playedByGudini
    ? supporting.filter((c: any) => c.name.toLowerCase() !== playedByGudini.toLowerCase())
    : supporting;
  return {
    characterId: character.id,
    universeId: universe.id,
    storyType,
    eventsDropped: Math.max(0, Math.min(rawEvents.length, 12) - events.length),
    visualTasks,
    researchFacts: researchFacts.filter(Boolean),
    staging: STAGING_FOR[storyType],
    // кадры новости — реконструкция; происхождение хранится в плане, а не подразумевается
    reconstruction: storyType === "news" || storyType === "history",
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
    events,
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
export function beatsFromRaw(raw: RawBeat[], phrases: Phrase[], duration: number, words: Word[] = []): StoryBeat[] {
  if (!phrases.length) return [];
  const n = phrases.length;
  const clamp = (v: number) => Math.max(1, Math.min(n, Math.round(Number(v) || 1)));
  const items: { from: number; to: number; e: RawBeat; idx?: number }[] = [];
  let cursor = 1;
  (raw ?? []).forEach((e, idx) => {
    if (cursor > n) return;
    let from = clamp(e.fromPhrase);
    let to = clamp(e.toPhrase);
    if (to < from) to = from;
    if (from !== cursor) from = cursor;
    if (to < from) to = from;
    items.push({ from, to, e, idx });
    cursor = to + 1;
  });
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
    // Якорь обязан быть словом из речи этого бита: иначе тайминг привязан к выдумке,
    // а не к тому, что зритель услышит. Не нашли — оставляем пустым, а не «почти похожим».
    const spoken = phrases.slice(it.from - 1, it.to).map((p) => p.text).join(" ").toLowerCase();
    const anchorRaw = str(e.anchorPhrase);
    const anchorPhrase = anchorRaw && spoken.includes(anchorRaw.toLowerCase()) ? anchorRaw : "";
    // Секунда якоря внутри бита: раньше якорь никуда не влиял, и его смена оставляла
    // побайтно тот же промпт. Считается по пословной расшифровке, а не по номеру фразы.
    const anchorAbs = anchorPhrase ? anchorAbsolute(words, anchorPhrase, start, end) : null;
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
      keyMoment: mode !== "author" ? str(e.keyMoment) : "",
      anchorPhrase: mode !== "author" ? anchorPhrase : "",
      // удержание по смыслу события; неизвестное значение — «до состояния покоя»
      hold: (["instant", "settle", "read"] as string[]).includes(String(e.hold)) ? (e.hold as HoldKind) : "settle",
      anchorAtSec: null,
      anchorAbsSec: mode !== "author" ? anchorAbs : null,
      eventIds: mode !== "author" ? arr(e.eventIds).map(slugId).filter(Boolean).slice(0, 6) : [],
      visualTask: mode !== "author" ? slugId(e.visualTask) : "",
      objects: mode !== "author" ? objectStates(e.objects) : [],
      ...(mode !== "author" ? { scene: sceneState(e.scene) } : {}),
      location: str(e.location),
      motion: mode !== "author" ? str(e.motion) : "",
      stateBefore: str(e.stateBefore),
      stateAfter: str(e.stateAfter),
      continuityGroup: mode !== "author" && typeof e.continuityGroup === "string" && e.continuityGroup.trim() ? e.continuityGroup.trim() : null,
      continuityRequired: mode !== "author" && (e.continuityRequired === true || (typeof e.continuityGroup === "string" && e.continuityGroup.trim().length > 0)),
      transition: (e.transition === "dissolve" ? "dissolve" : "cut") as TransitionIntent,
      shotType: (SHOTS as string[]).includes(String(e.shotType)) ? (e.shotType as ShotType) : "medium",
      camera: str(e.camera),
      cameraAngle: (ANGLES as string[]).includes(String(e.cameraAngle)) ? (e.cameraAngle as CameraAngle) : "eye_level",
      // Именная группа, а не предложение: она подставляется внутрь строк кадра и ракурса.
      // Пустая строка допустима — тогда кадр описывается вокруг самого действия.
      frameSubject: mode !== "author" ? shortPhrase(str(e.frameSubject).replace(/[.;]+$/, ""), 90) : "",
      composition: (COMPOSITIONS as string[]).includes(String(e.composition)) ? (e.composition as Composition) : "center",
      suggestedDuration: Math.round((end - start) * 10) / 10,
      ...(reduced ? { reduced } : {}),
      ...(it.idx != null ? { sourceIndex: it.idx } : {}),
    };
  });

  // встык: с нуля, следующий начинается там, где кончился прошлый, последний — до конца ролика
  for (let i = 0; i < beats.length; i++) {
    beats[i].start = i === 0 ? 0 : beats[i - 1].end;
    if (i === beats.length - 1) beats[i].end = Math.max(beats[i].end, duration);
    if (beats[i].end < beats[i].start) beats[i].end = beats[i].start;
    beats[i].suggestedDuration = Math.round((beats[i].end - beats[i].start) * 10) / 10;
  }
  // Относительное смещение якоря считается ПОСЛЕ всех сдвигов границ. Паузы в речи
  // переносят начало бита, и смещение, посчитанное по исходной фразе, указывало не туда.
  for (const b of beats) {
    if (b.anchorAbsSec == null) { b.anchorAtSec = null; continue; }
    const rel = Math.round((b.anchorAbsSec - b.start) * 10) / 10;
    b.anchorAtSec = rel >= -1e-6 && rel <= b.end - b.start + 1e-6 ? Math.max(0, rel) : null;
  }

  // Камера и композиция сводятся к одному непротиворечивому описанию до того, как из них
  // соберут промпт: иначе Veo получает «камера сверху» и «камера снизу» в одном тексте.
  for (const b of beats) if (b.displayMode !== "author") reconcileFraming(b);

/**
 * Дотянуть короткую сцену до минимума за счёт соседа. Отдаёт время тот, кто может себе это
 * позволить: авторский бит остаётся не короче секунды, AI-сосед с событием — не короче
 * порога показа, AI-сосед без события — не короче минимального бита.
 *
 * Появилось после настоящего плана, где раскрытию запасного купола досталось 1.2 секунды:
 * правило «короче порога — автору» молча уносило вместе со сценой обязательное событие.
 */
function borrowTime(beats: StoryBeat[], index: number, need: number): boolean {
  const b = beats[index];
  const spare = (n: StoryBeat): number => {
    const len = n.end - n.start;
    if (n.displayMode === "author") return Math.max(0, len - 1.0);
    const floor = (n.eventIds ?? []).length ? MIN_SHOWN_AI_SEC : MIN_AI_BEAT_SEC;
    return Math.max(0, len - floor);
  };
  const prev = beats[index - 1];
  const next = beats[index + 1];
  // Сначала у предыдущего: сцена растёт назад, и момент события остаётся внутри неё.
  for (const donor of [prev, next]) {
    if (!donor) continue;
    const can = Math.min(spare(donor), need);
    if (can < need - 1e-6) continue;
    if (donor === prev) {
      prev.end = Math.round((prev.end - can) * 1000) / 1000;
      b.start = prev.end;
    } else {
      next.start = Math.round((next.start + can) * 1000) / 1000;
      b.end = next.start;
    }
    donor.suggestedDuration = Math.round((donor.end - donor.start) * 10) / 10;
    b.suggestedDuration = Math.round((b.end - b.start) * 10) / 10;
    return true;
  }
  return false;
}

  // Длительность генерации и длительность показа — разные вещи. Клип Veo короче четырёх
  // секунд не заказывается, но ПОКАЗАТЬ его можно и три секунды: распаковка коробки или
  // набранный отзыв читаются за это время. Раньше здесь всё короче четырёх секунд уходило
  // автору, и обязательные события истории пропадали из ролика при живом бюджете.
  //
  // Оставляем короткую сцену, только если она несёт событие: три секунды украшения ради
  // украшения не нужны никому. Открывающий бит пропускаем, им занимаемся ниже.
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    if (i === 0 || b.displayMode === "author") continue;
    const dur = b.end - b.start;
    if (dur >= MIN_AI_BEAT_SEC - 1e-6) continue;
    if (dur >= MIN_SHOWN_AI_SEC - 1e-6 && (b.eventIds ?? []).length) continue;
    // Сцена с событием сначала пробует дотянуться до минимума за счёт соседа, и только
    // потом уходит автору. Настоящий план отдал раскрытию запасного купола 1.2 секунды,
    // и обязательное событие исчезало из ролика вместе с этой сценой.
    if ((b.eventIds ?? []).length && borrowTime(beats, i, MIN_SHOWN_AI_SEC - dur)) continue;
    b.displayMode = "author";
    b.requiresGeneration = false;
    b.gudiniVisible = false;
    b.continuityGroup = null;
    b.reduced = (b.eventIds ?? []).length
      ? `показ короче ${MIN_SHOWN_AI_SEC} с — событие не прочитать`
      : `AI-бит короче ${MIN_AI_BEAT_SEC} с и без события`;
  }

  // Сначала все короткие сцены, потом открывающая: сосед мог сам стать автором.

  // Открывающая сцена короче минимума не выбрасывается, а дотягивается за счёт следующего
  // авторского бита. Хук в речи часто занимает три секунды («парень заказал парашют за
  // пять долларов»), и правило «короче четырёх — в автора» убивало ровно ту сцену, которая
  // держит первые секунды ролика. Соседу оставляем минимум секунду.
  // Делается ПОСЛЕ общей проверки: сосед мог сам быть коротким AI-битом и только что стать
  // автором — тогда занимать время у него уже можно.
  const first = beats[0];
  const firstShownEnough = first && first.end - first.start >= MIN_SHOWN_AI_SEC - 1e-6 && (first.eventIds ?? []).length > 0;
  if (first && first.displayMode !== "author" && !firstShownEnough && first.end - first.start < MIN_AI_BEAT_SEC - 1e-6) {
    let need = MIN_AI_BEAT_SEC - (first.end - first.start);
    // Считаем всю авторскую цепочку сразу за хуком: между ним и длинным объяснением
    // часто стоит ещё один коротышка, и проверка только ближайшего соседа промахивалась.
    let available = 0;
    let last = 0;
    for (let i = 1; i < beats.length && beats[i].displayMode === "author"; i++) {
      available += beats[i].end - beats[i].start;
      last = i;
    }
    if (available - 1.0 >= need) {
      first.end = Math.round((first.end + need) * 1000) / 1000;
      first.suggestedDuration = Math.round((first.end - first.start) * 10) / 10;
      // сдвигаем цепочку: съеденные целиком биты убираем, последний укорачиваем
      let cursor = first.end;
      const drop: number[] = [];
      for (let i = 1; i <= last; i++) {
        const b = beats[i];
        const len = b.end - b.start;
        if (cursor >= b.end - 1e-6) { drop.push(i); continue; }
        b.start = Math.max(cursor, b.start);
        b.suggestedDuration = Math.round((b.end - b.start) * 10) / 10;
        cursor = Math.max(cursor, b.start + Math.min(len, 0));
      }
      for (const i of drop.reverse()) beats.splice(i, 1);
      // после удаления биты снова встык
      for (let i = 1; i < beats.length; i++) beats[i].start = beats[i - 1].end;
    } else {
      first.displayMode = "author";
      first.requiresGeneration = false;
      first.gudiniVisible = false;
      first.continuityGroup = null;
      first.reduced = `AI-бит короче ${MIN_AI_BEAT_SEC} с`;
    }
  }
  return beats;
}

/**
 * Короткая фраза без обрыва слова: субъект кадра подставляется в запрос дважды, и срез по
 * символам давал «the wide fairway visible through the window behin».
 */
export function shortPhrase(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.5 ? cut.slice(0, at) : t.slice(0, max)).replace(/[\s,;:—-]+$/, "");
}

export async function planStory(args: {
  words: Word[];
  script: string;
  topic?: string;
  researchSummary?: string;
  /** факты справки по отдельности: доходят до контракта и разбора */
  researchFacts?: string[];
  budgetUsd?: number;
  character: CharacterProfile;
  universe: UniverseProfile;
  duration: number;
  coverage: { target: number; max: number };
  /** что было нарушено в прошлой попытке — второй заход с названными ошибками */
  retryNote?: string;
  /** наблюдатель запроса и ответа модели: нужен разбору качества, на конвейер не влияет */
  onCall?: (info: { system: string; user: string; raw: string; retry: boolean }) => void;
  /** подмена самого вызова модели: нужна проверкам разбора ответа, в конвейере не используется */
  complete?: (a: { system: string; user: string }) => Promise<string>;
}): Promise<{ bible: StoryBible; beats: StoryBeat[]; phrases: Phrase[]; raw: RawStory }> {
  const phrases = phrasesFromWords(args.words);
  if (phrases.length < 2) throw new Error("AI-фильм: в речи меньше двух фраз — не из чего строить историю");
  const list = phrases.map((p) => `${p.index}. [${p.start.toFixed(1)}–${p.end.toFixed(1)} с] ${p.text}`).join("\n");
  const user =
    `${args.topic ? `Тема ролика: ${args.topic}\n` : ""}` +
    `${researchContext(args.researchSummary, args.researchFacts)}` +
    `${args.budgetUsd == null ? "" : `Предел расходов Veo: $${args.budgetUsd}. При конфликте объёма и бюджета сохрани ключевые визуальные задачи.\n`}` +
    `Сценарий (что автор хотел сказать):\n${args.script.slice(0, 4000)}\n\n` +
    `Речь автора по фразам (чистый таймлайн, всего ${args.duration.toFixed(1)} с):\n${list}\n\n` +
    // Прежде здесь стояло «нужно НЕ МЕНЬШЕ N сцен»: модель выполняла число как задачу и под
    // правовые и числовые реплики ставила пустой реквизит. Число сцен следует из визуальных задач.
    `Речь длится ${args.duration.toFixed(0)} секунд. Сначала составь визуальные задачи всей истории, убери повторы по смыслу и отдай объяснения автору; ` +
    `число сцен следует из этих задач, а не из длины речи. Перед ответом проверь ритм всей последовательности вместе с авторскими кусками по номерам фраз.` +
    (args.retryNote
      ? `\n\nПРЕДЫДУЩИЙ ТВОЙ ПЛАН НА ЭТУ ЖЕ РЕЧЬ НАРУШИЛ ЖЁСТКИЕ ТРЕБОВАНИЯ К СТРУКТУРЕ:\n${args.retryNote}\n` +
        `Составь план заново и исправь именно это. Остальное можно оставить прежним.`
      : "");
  // без скрытых размышлений: на речи в 124 с модель потратила на них все 16 000 токенов и не выдала текст
  const system = storySystemPrompt(args.character, args.universe, args.coverage);
  const raw = args.complete
    ? await args.complete({ system, user })
    : await mediaComplete({ model: STORY_MODEL, maxTokens: 16000, stage: "AI Film Story", reasoning: "off", system, user });
  // Крючок для разбора качества планировщика: сохранить ровно то, что ушло в модель и что
  // она ответила, не подменяя это пересказом. На работу конвейера не влияет.
  args.onCall?.({ system, user, raw, retry: Boolean(args.retryNote) });
  // Ответ уже оплачен. Если он не разобрался, без его текста причину не найти: конец ответа
  // уходит в саму ошибку, а целиком его сохраняет onCall.
  let parsed: RawStory;
  try {
    parsed = parseJson<RawStory>(raw, "AI Film Story");
  } catch {
    const tail = raw.slice(-300).replace(/\s+/g, " ");
    throw new Error(`AI Film Story: ответ модели не разобрался как JSON (символов ${raw.length}, конец ответа: ...${tail})`);
  }
  return storyFromRaw(parsed, { ...args, phrases });
}

/** От разобранного ответа модели к библии и битам: общий путь первого захода и корректировки. */
export function storyFromRaw(
  parsed: RawStory,
  args: { words: Word[]; phrases: Phrase[]; duration: number; character: CharacterProfile; universe: UniverseProfile; researchFacts?: string[] },
): { bible: StoryBible; beats: StoryBeat[]; phrases: Phrase[]; raw: RawStory } {
  if (!parsed || !Array.isArray(parsed.beats) || !parsed.beats.length) {
    throw new Error("AI Film Story: неполная структура ответа — отсутствуют биты (beats)");
  }
  const { phrases } = args;
  const bible = normalizeBible(parsed, args.character, args.universe, args.researchFacts ?? []);
  // Задача хранит и секунды речи: по ним разбор ритма отличает объяснение от забытого отрезка.
  for (const t of bible.visualTasks ?? []) {
    const from = phrases.find((p) => p.index === t.fromPhrase);
    const to = phrases.find((p) => p.index === t.toPhrase) ?? from;
    if (from && to) {
      t.start = from.start;
      t.end = Math.max(from.start, to.end);
    }
  }
  const beats = beatsFromRaw(parsed.beats ?? [], phrases, args.duration, args.words);
  if (!beats.length) throw new Error("AI Film Story: модель не вернула биты");
  // Герой истории и постоянный персонаж — один человек: в тексте сцен остаётся одно имя,
  // иначе Veo рисует и «Каспера», и Гудини рядом.
  renameHeroToCharacter(beats, bible.playedByGudini, args.character.name);
  reconcileParticipants(beats, bible, args.character.name);
  reconcileEventRefs(bible, beats);
  return { bible, beats, phrases, raw: parsed };
}

/** Ответ модели в одной форме: списки контракта под bible, биты массивом. */
export function canonicalRaw(first: RawStory): RawStory {
  const raw: RawStory = JSON.parse(JSON.stringify(first ?? {}));
  raw.bible = raw.bible && typeof raw.bible === "object" ? raw.bible : {};
  if (!Array.isArray(raw.bible.events)) raw.bible.events = Array.isArray(raw.events) ? raw.events : [];
  if (!Array.isArray(raw.bible.visualTasks)) raw.bible.visualTasks = Array.isArray(raw.visualTasks) ? raw.visualTasks : [];
  delete raw.events;
  delete raw.visualTasks;
  raw.beats = Array.isArray(raw.beats) ? raw.beats : [];
  return raw;
}

/** Диапазоны фраз битов ответа в том виде, в каком их читает beatsFromRaw. */
export function rawBeatRanges(rawBeats: RawBeat[], n: number): ({ from: number; to: number } | null)[] {
  const clamp = (v: number) => Math.max(1, Math.min(n, Math.round(Number(v) || 1)));
  const out: ({ from: number; to: number } | null)[] = [];
  let cursor = 1;
  for (const e of rawBeats) {
    if (cursor > n) {
      out.push(null);
      continue;
    }
    let from = clamp(e.fromPhrase);
    let to = clamp(e.toPhrase);
    if (to < from) to = from;
    if (from !== cursor) from = cursor;
    if (to < from) to = from;
    out.push({ from, to });
    cursor = to + 1;
  }
  return out;
}

const rangeKey = (r: { from: number; to: number }) => `${r.from}-${r.to}`;

/**
 * Применить изменения второго захода к первому ответу. Незатронутые сцены, события, задачи,
 * участники и статусы фактов сохраняются по построению: в результате они те же объекты, что
 * в первом ответе. Изменение вне замечаний применяется только с объявленной причиной, иначе
 * отбрасывается и попадает в список отклонённых.
 */
export function applyPatch(first: RawStory, patch: RawPatch, scope: PatchScope): { raw: RawStory; applied: string[]; rejected: string[] } {
  const raw = canonicalRaw(first);
  const applied: string[] = [];
  const rejected: string[] = [];
  if (scope.roles && patch?.bible?.playedByGudini !== undefined &&
      patch.bible.playedByGudini !== raw.bible.playedByGudini) {
    const changed = new Set([...(patch.beats?.replace ?? []), ...(patch.beats?.remove ?? [])]
      .map(b => `${b.fromPhrase}-${b.toPhrase}`));
    const ranges = rawBeatRanges(raw.beats ?? [], scope.phraseCount);
    const missed = (raw.beats ?? []).flatMap((b, i) => {
      const r = ranges[i];
      return b.gudiniVisible && r && !changed.has(rangeKey(r)) ? [rangeKey(r)] : [];
    });
    if (missed.length) return { raw, applied, rejected: [`Переназначение роли неполно: не исправлены появления ${missed.join(", ")}; корректировка не применена`] };
  }
  const related = new Map<string, { for: string; why: string }>();
  for (const r of patch?.related ?? []) {
    const target = str(r?.target);
    if (target) related.set(target, { for: str(r?.for), why: str(r?.why, "причина не названа") });
  }
  // Связь изменения с замечанием проверяется по существу, а не по наличию объяснения: изменение
  // должно служить пункту из области (for) и быть с ним связано — тем же событием, той же
  // задачей или соседней фразой. Объяснение само по себе ничего не разрешает.
  const firstBeats = canonicalRaw(first).beats ?? [];
  const firstRanges = rawBeatRanges(firstBeats, scope.phraseCount);
  const forBeat = (key: string) => {
    const i = firstRanges.findIndex((r) => r && rangeKey(r) === key);
    return i >= 0 ? { beat: firstBeats[i], range: firstRanges[i]! } : null;
  };
  type Link = { range?: { from: number; to: number }; events?: string[]; task?: string; eventId?: string; taskId?: string; phrases?: { from: number; to: number } };
  const connected = (target: string, link: Link): boolean => {
    if (scope.beats.has(target)) {
      const fb = forBeat(target);
      if (!fb) return false;
      const ev = arr(fb.beat.eventIds).map(slugId);
      const task = slugId(fb.beat.visualTask);
      if (link.range && (Math.abs(link.range.from - fb.range.to) <= 1 || Math.abs(link.range.to - fb.range.from) <= 1)) return true;
      if (link.eventId && ev.includes(link.eventId)) return true;
      if (link.taskId && task === link.taskId) return true;
      if (link.events?.some((e) => ev.includes(e))) return true;
      if (link.task && task === link.task) return true;
      return false;
    }
    if (scope.events.has(target)) {
      if (link.events?.includes(target) || link.eventId === target) return true;
      const e = (canonicalRaw(first).bible.events as any[]).find((x) => slugId(x?.id) === target);
      if (e && link.phrases && link.phrases.from <= Number(e.toPhrase) && link.phrases.to >= Number(e.fromPhrase)) return true;
      return false;
    }
    if (scope.tasks.has(target)) return link.task === target || link.taskId === target;
    return false;
  };
  const allowed = (kind: string, key: string, inScope: boolean, link: Link = {}): boolean => {
    if (inScope) return true;
    const rel = related.get(key);
    if (!rel) {
      rejected.push(`${kind} ${key}: вне области замечаний, связанное изменение не объявлено`);
      return false;
    }
    if (!rel.for) {
      rejected.push(`${kind} ${key}: связанное изменение без указания, какому замечанию оно служит`);
      return false;
    }
    if (!connected(rel.for, link)) {
      rejected.push(`${kind} ${key}: объявлено связанным с «${rel.for}», но не связано с ним ни событием, ни задачей, ни соседством`);
      return false;
    }
    applied.push(`${kind} ${key}: связанное изменение ради «${rel.for}», причина: ${rel.why}`);
    return true;
  };

  // роли и участники: только когда замечание было про них
  if (patch?.bible && (patch.bible.playedByGudini !== undefined || patch.bible.supportingCharacters !== undefined)) {
    if (scope.roles) {
      if (patch.bible.playedByGudini !== undefined) raw.bible.playedByGudini = patch.bible.playedByGudini;
      if (patch.bible.supportingCharacters !== undefined) raw.bible.supportingCharacters = patch.bible.supportingCharacters;
      applied.push("роль и участники изменены по замечанию");
    } else {
      rejected.push("роль и участники: замечаний к ролям не было");
    }
  }

  // сцены — первыми: по ним видно, на какие события и задачи имеет право ссылаться заход
  const n = scope.phraseCount;
  const beats: RawBeat[] = raw.beats!;
  const ranges = () => rawBeatRanges(beats, n);
  const keyOf = (b: RawBeat) => `${Math.round(Number(b?.fromPhrase) || 0)}-${Math.round(Number(b?.toPhrase) || 0)}`;
  const touched = { events: new Set<string>(), tasks: new Set<string>() };
  const noteRefs = (b: RawBeat) => {
    for (const id of arr(b.eventIds)) touched.events.add(slugId(id));
    if (str(b.visualTask)) touched.tasks.add(slugId(b.visualTask));
  };
  const findIndex = (key: string) => ranges().findIndex((r) => r && rangeKey(r) === key);
  // Персонаж канала в сцене — решение о ролях. Если в первом плане его не было, корректировка
  // без замечания о ролях не вправе поставить его в кадр, даже внутри сцены из замечаний: так
  // «Gudini and a second teenager» вернулся бы через замену сцены о посадке.
  const nameOf = scope.characterName ?? "";
  const mentions = (b: RawBeat | undefined) => {
    if (!nameOf || !b) return false;
    const text = `${(b as any)?.scene?.who ?? ""} ${b.visualAction ?? ""} ${b.motion ?? ""} ${b.keyMoment ?? ""}`;
    return new RegExp("(?:^|[^A-Za-z])" + nameOf.replace(/[^A-Za-z0-9 ]/g, "") + "(?![A-Za-z])", "i").test(text);
  };
  const characterInFirst = beats.some((b) => b.displayMode !== "author" && mentions(b));
  const introducesCharacter = (b: RawBeat, was?: RawBeat) => !scope.roles && mentions(b) && !(was ? mentions(was) : characterInFirst);

  for (const r of patch?.beats?.remove ?? []) {
    const key = `${Math.round(Number(r?.fromPhrase) || 0)}-${Math.round(Number(r?.toPhrase) || 0)}`;
    const at = findIndex(key);
    if (at < 0) {
      rejected.push(`сцена ${key}: в первом плане такой нет`);
      continue;
    }
    const rg0 = ranges()[at]!;
    if (!allowed("сцена", key, scope.beats.has(key), { range: rg0, events: arr(beats[at].eventIds).map(slugId), task: slugId(beats[at].visualTask) })) continue;
    const rg = ranges()[at]!;
    beats[at] = { fromPhrase: rg.from, toPhrase: rg.to, displayMode: "author" };
    applied.push(`сцена ${key} снята, отрезок отдан автору`);
  }
  for (const b of patch?.beats?.replace ?? []) {
    const key = keyOf(b);
    const at = findIndex(key);
    if (at < 0) {
      rejected.push(`сцена ${key}: в первом плане такой нет, для новой сцены есть add`);
      continue;
    }
    if (!allowed("сцена", key, scope.beats.has(key), { range: ranges()[at]!, events: arr(b.eventIds).map(slugId), task: slugId(b.visualTask) })) continue;
    if (introducesCharacter(b, beats[at])) {
      rejected.push(`сцена ${key}: ставит ${nameOf} в кадр, где его не было, без замечания о ролях`);
      continue;
    }
    const rg = ranges()[at]!;
    beats[at] = { ...b, fromPhrase: rg.from, toPhrase: rg.to };
    noteRefs(b);
    applied.push(`сцена ${key} заменена`);
  }
  for (const b of patch?.beats?.add ?? []) {
    const from = Math.round(Number(b?.fromPhrase) || 0);
    const to = Math.round(Number(b?.toPhrase) || 0);
    const key = `${from}-${to}`;
    if (!(from >= 1 && to >= from && to <= n)) {
      rejected.push(`сцена ${key}: диапазон фраз вне речи`);
      continue;
    }
    const rs = ranges();
    const overlapping = beats.map((x, i) => ({ x, i, r: rs[i] })).filter(({ r }) => r && r.from <= to && r.to >= from);
    const inScope = overlapping.some(({ r }) => scope.beats.has(rangeKey(r!)));
    if (!allowed("сцена", key, inScope, { range: { from, to }, events: arr(b.eventIds).map(slugId), task: slugId(b.visualTask) })) continue;
    const ai = overlapping.filter(({ x }) => x.displayMode === "full_ai" || x.displayMode === "hybrid");
    if (ai.length) {
      rejected.push(`сцена ${key}: пересекает сцену ${ai.map(({ r }) => rangeKey(r!)).join(", ")} — сначала снимите или замените её`);
      continue;
    }
    if (introducesCharacter(b)) {
      rejected.push(`сцена ${key}: ставит ${nameOf} в кадр, которого в первом плане не было, без замечания о ролях`);
      continue;
    }
    // авторский бит режется вокруг новой сцены, соседние сцены не трогаются
    const pieces: RawBeat[] = [];
    for (const { x, r } of overlapping) {
      if (r!.from < from) pieces.push({ ...x, fromPhrase: r!.from, toPhrase: from - 1 });
      if (r!.to > to) pieces.push({ ...x, fromPhrase: to + 1, toPhrase: r!.to });
    }
    const keep = beats.filter((_, i) => !overlapping.some((o) => o.i === i));
    beats.splice(0, beats.length, ...keep, ...pieces, { ...b, fromPhrase: from, toPhrase: to });
    beats.sort((a, c) => (Number(a.fromPhrase) || 0) - (Number(c.fromPhrase) || 0));
    noteRefs(b);
    applied.push(`сцена ${key} добавлена`);
  }

  // события
  const events: any[] = raw.bible.events;
  for (const idRaw of patch?.events?.remove ?? []) {
    const id = slugId(typeof idRaw === "object" && idRaw !== null && "id" in idRaw ? idRaw.id : idRaw);
    const at = events.findIndex((e) => slugId(e?.id) === id);
    if (at < 0) {
      rejected.push(`событие ${id}: в контракте такого нет`);
      continue;
    }
    if (!allowed("событие", id, scope.events.has(id), { eventId: id })) continue;
    events.splice(at, 1);
    applied.push(`событие ${id} удалено из контракта`);
  }
  const mergeEvent = (e: any, kind: "update" | "add") => {
    const id = slugId(e?.id);
    if (!id) {
      rejected.push("событие без идентификатора");
      return;
    }
    const at = events.findIndex((x) => slugId(x?.id) === id);
    if (kind === "add" && at >= 0) {
      rejected.push(`событие ${id}: уже есть, для правки есть update`);
      return;
    }
    if (kind === "update" && at < 0) {
      rejected.push(`событие ${id}: в контракте такого нет, для нового есть add`);
      return;
    }
    const prev = at >= 0 ? events[at] : {};
    const ph = { from: Math.round(Number(e?.fromPhrase ?? prev.fromPhrase) || 0), to: Math.round(Number(e?.toPhrase ?? prev.toPhrase) || 0) };
    if (!allowed("событие", id, scope.events.has(id) || touched.events.has(id), { eventId: id, phrases: ph })) return;
    const merged = { ...prev, ...e, id };
    // статус факта не повышается до «подтверждено» без цитаты из справки
    if (merged.basis === "confirmed" && prev.basis !== "confirmed" && !str(merged.basisFact)) {
      merged.basis = prev.basis ?? "told";
      merged.basisFact = prev.basisFact ?? "";
      rejected.push(`событие ${id}: статус «подтверждено» без цитаты не принят`);
    }
    if (at >= 0) events[at] = merged;
    else events.push(merged);
    applied.push(`событие ${id} ${kind === "add" ? "добавлено" : "изменено"}`);
  };
  for (const e of patch?.events?.update ?? []) mergeEvent(e, "update");
  for (const e of patch?.events?.add ?? []) mergeEvent(e, "add");

  // задачи
  const tasks: any[] = raw.bible.visualTasks;
  for (const idRaw of patch?.visualTasks?.remove ?? []) {
    const id = slugId(typeof idRaw === "object" && idRaw !== null && "id" in idRaw ? idRaw.id : idRaw);
    const at = tasks.findIndex((t) => slugId(t?.id) === id);
    if (at < 0) {
      rejected.push(`задача ${id}: в плане такой нет`);
      continue;
    }
    if (!allowed("задача", id, scope.tasks.has(id), { taskId: id })) continue;
    tasks.splice(at, 1);
    applied.push(`задача ${id} удалена`);
  }
  const mergeTask = (t: any, kind: "update" | "add") => {
    const id = slugId(t?.id);
    if (!id) {
      rejected.push("задача без идентификатора");
      return;
    }
    const at = tasks.findIndex((x) => slugId(x?.id) === id);
    if (kind === "add" && at >= 0) {
      rejected.push(`задача ${id}: уже есть, для правки есть update`);
      return;
    }
    if (kind === "update" && at < 0) {
      rejected.push(`задача ${id}: в плане такой нет, для новой есть add`);
      return;
    }
    const prevT = at >= 0 ? tasks[at] : {};
    const phT = { from: Math.round(Number(t?.fromPhrase ?? prevT.fromPhrase) || 0), to: Math.round(Number(t?.toPhrase ?? prevT.toPhrase) || 0) };
    if (!allowed("задача", id, scope.tasks.has(id) || touched.tasks.has(id), { taskId: id, phrases: phT })) return;
    if (at >= 0) tasks[at] = { ...tasks[at], ...t, id };
    else tasks.push({ ...t, id });
    applied.push(`задача ${id} ${kind === "add" ? "добавлена" : "изменена"}`);
  };
  for (const t of patch?.visualTasks?.update ?? []) mergeTask(t, "update");
  for (const t of patch?.visualTasks?.add ?? []) mergeTask(t, "add");

  return { raw, applied, rejected };
}

/**
 * Второй заход как ограниченная корректировка: модель получает первый план целиком и
 * замечания, возвращает только изменения. Прежний второй заход переписывал план заново и
 * вместе с одним недостатком менял решения, которые были верны: участников, статус фактов,
 * отсутствие выдуманных механизмов.
 */
export async function planPatch(args: {
  words: Word[];
  script: string;
  topic?: string;
  researchSummary?: string;
  researchFacts?: string[];
  budgetUsd?: number;
  scope?: PatchScope;
  first: RawStory;
  remarks: string[];
  character: CharacterProfile;
  universe: UniverseProfile;
  duration: number;
  coverage: { target: number; max: number };
  onCall?: (info: { system: string; user: string; raw: string; retry: boolean }) => void;
  complete?: (a: { system: string; user: string }) => Promise<string>;
}): Promise<RawPatch> {
  const phrases = phrasesFromWords(args.words);
  const list = phrases.map((p) => `${p.index}. [${p.start.toFixed(1)}–${p.end.toFixed(1)} с] ${p.text}`).join("\n");
  const user =
    `${args.topic ? `Тема ролика: ${args.topic}\n` : ""}` +
    `${researchContext(args.researchSummary, args.researchFacts)}` +
    `${args.budgetUsd == null ? "" : `Предел расходов Veo: $${args.budgetUsd}.\n`}` +
    `Речь автора по фразам (чистый таймлайн, всего ${args.duration.toFixed(1)} с):\n${list}\n\n` +
    `ТВОЙ ПЕРВЫЙ ПЛАН НА ЭТУ РЕЧЬ, ЦЕЛИКОМ:\n${JSON.stringify(canonicalRaw(args.first))}\n\n` +
    `ЗАМЕЧАНИЯ К НЕМУ:\n${args.remarks.map((r) => `- ${r}`).join("\n")}\n\n` +
    (args.scope ? `ДОПУСТИМАЯ ОБЛАСТЬ ИЗМЕНЕНИЙ (точные адреса исходного плана):\n${JSON.stringify({ beats: [...args.scope.beats], events: [...args.scope.events], visualTasks: [...args.scope.tasks], roles: args.scope.roles })}\n\n` : "") +
    `ЗАДАЧА: исправь только то, к чему есть замечания, и верни ТОЛЬКО ИЗМЕНЕНИЯ, а не новый план.\n` +
    `- Сцены, события и задачи без замечаний не переписывай: они сохранятся как есть.\n` +
    `- Участники, playedByGudini, статусы фактов (basis) и отсутствие сцен с неподтверждённым механизмом сохраняются; менять роли можно только по замечанию о ролях.\n` +
    `- При переназначении playedByGudini исправь ВСЕ появления этой роли, включая последующие сцены без отдельного замечания: они открыты в области. Нельзя передать предмет одному актёру, а продолжить действие другим. Неполное переназначение отклоняется целиком.\n` +
    `- Если исправление требует связанных изменений в других сценах или событиях, перечисли их в related: target — что меняется, for — какое замечание это обслуживает (id события, задачи или fromPhrase-toPhrase сцены из замечаний), why — почему без этого исправление невозможно. Принимается только изменение, связанное с этим замечанием: то же событие или задача, либо соседняя сцена. Объяснение само по себе ничего не разрешает, роли через related не меняются.\n` +
    `- Сцена адресуется парой fromPhrase/toPhrase из твоего плана. Новая сцена (add) может занять только фразы авторских битов; чтобы изменить существующую сцену, используй replace с полным описанием бита.\n` +
    `- Событие и задача адресуются id. В update и add отдавай объект целиком.\n` +
    `Формат ответа, только JSON:\n` +
    `{"events": {"update": [], "add": [], "remove": []}, "visualTasks": {"update": [], "add": [], "remove": []}, ` +
    `"beats": {"replace": [], "add": [], "remove": [{"fromPhrase": 1, "toPhrase": 2}]}, ` +
    `"bible": {"playedByGudini": "", "supportingCharacters": []}, "related": [{"target": "id или fromPhrase-toPhrase", "for": "пункт из замечаний", "why": "почему без этого исправление невозможно"}], "note": "коротко, что исправлено"}\n` +
    `Поле bible включай только при замечании о ролях. Пустые списки можно опускать.`;
  const system = directorInstructions(args.character, args.universe, args.coverage.max) + "\nРежим корректировки: верни ТОЛЬКО ИЗМЕНЕНИЯ по контракту из задания, не полный план.";
  const raw = args.complete
    ? await args.complete({ system, user })
    : await mediaComplete({ model: STORY_MODEL, maxTokens: 16000, stage: "AI Film Story", reasoning: "off", system, user });
  args.onCall?.({ system, user, raw, retry: true });
  try {
    const parsed = parseJson<RawPatch>(raw, "AI Film Story");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        Array.isArray(parsed.beats) || Array.isArray(parsed.events) || Array.isArray(parsed.visualTasks)) {
      throw new Error("Ожидались изменения, а не полный план");
    }
    return parsed;
  } catch {
    const tail = raw.slice(-300).replace(/\s+/g, " ");
    throw new Error(`AI Film Story: изменения второго захода не разобрались как JSON (символов ${raw.length}, конец ответа: ...${tail})`);
  }
}

/** Область корректировки из замечаний: адреса сцен, событий и задач, право менять роли. */
export function scopeFromIssues(
  issues: { code: string; beatIds: string[]; eventIds?: string[] }[],
  beats: StoryBeat[],
  bible: Pick<StoryBible, "visualTasks" | "events" | "storyType" | "researchFacts">,
  raw: RawStory,
  phraseCount: number,
  characterName?: string,
): PatchScope {
  const ranges = rawBeatRanges(canonicalRaw(raw).beats ?? [], phraseCount);
  const scope: PatchScope = { beats: new Set(), events: new Set(), tasks: new Set(), roles: false, phraseCount, characterName };
  const ROLE_CODES = new Set(["role-miscast", "costume-conflict", "hero-flag-mismatch"]);
  for (const i of issues) {
    if (ROLE_CODES.has(i.code)) scope.roles = true;
    for (const id of i.eventIds ?? []) scope.events.add(id);
    for (const bid of i.beatIds) {
      const b = beats.find((x) => x.id === bid || bid.startsWith(`${x.id}/`));
      if (!b) continue;
      const r = b.sourceIndex != null ? ranges[b.sourceIndex] : null;
      if (r) scope.beats.add(rangeKey(r));
      for (const id of b.eventIds ?? []) scope.events.add(id);
      if (b.visualTask) scope.tasks.add(b.visualTask);
    }
  }
  if (scope.roles) {
    for (const b of beats.filter(b => b.gudiniVisible && b.displayMode !== "author")) {
      const r = b.sourceIndex != null ? ranges[b.sourceIndex] : null;
      if (r) scope.beats.add(rangeKey(r));
      for (const id of b.eventIds ?? []) scope.events.add(id);
      if (b.visualTask) scope.tasks.add(b.visualTask);
    }
  }
  // сцены, которые заявляют событие из замечаний: их можно править, чтобы событие засчиталось
  for (const b of beats) {
    if (b.displayMode === "author" || !(b.eventIds ?? []).some((id) => scope.events.has(id))) continue;
    const r = b.sourceIndex != null ? ranges[b.sourceIndex] : null;
    if (r) scope.beats.add(rangeKey(r));
    if (b.visualTask) scope.tasks.add(b.visualTask);
  }
  // задачи над фразами событий из замечаний: чтобы объяснение можно было переоформить в сцену.
  // Авторские отрезки открываются только под события, которые обязаны быть показаны: под
  // неподтверждённый механизм и опровергнутое утверждение сцену ставить нельзя, и приглашать
  // туда корректировку незачем.
  const facts = bible.researchFacts ?? [];
  const documentary = isDocumentary({ storyType: bible.storyType ?? "news" });
  for (const e of bible.events ?? []) {
    if (!scope.events.has(e.id)) continue;
    for (const t of bible.visualTasks ?? []) {
      if (t.fromPhrase <= e.toPhrase && t.toPhrase >= e.fromPhrase) scope.tasks.add(t.id);
    }
    if (!mustShowEvent(e, facts, documentary)) continue;
    for (const [idx, r] of ranges.entries()) {
      const rb = canonicalRaw(raw).beats?.[idx];
      if (r && rb && rb.displayMode === "author" && r.from <= e.toPhrase && r.to >= e.fromPhrase) scope.beats.add(rangeKey(r));
    }
  }
  return scope;
}

/**
 * Сцена сослалась на событие, которого модель не переписала в контракт. Само содержание при
 * этом на месте: у сцены есть и наблюдаемое изменение, и предметы с состояниями. Такая запись
 * добавляется в контракт НЕобязательной — ссылка перестаёт висеть в пустоте, а обязательства
 * не меняются: обязательным событие делает только модель, и непокрытое обязательное событие
 * по-прежнему запрещает оплату.
 *
 * Без этого исправный план — заказ, прыжок, купол, запасной, приземление, отзыв — не проходил
 * ворота из-за бухгалтерии: во втором заходе модель оставила в контракте четыре события из
 * семи, хотя сцены описывали все семь.
 */
export function reconcileEventRefs(bible: StoryBible, beats: StoryBeat[]): number {
  const known = new Set(bible.events.map((e) => e.id));
  let added = 0;
  for (const b of beats) {
    if (b.displayMode === "author") continue;
    for (const id of b.eventIds ?? []) {
      if (!id || known.has(id)) continue;
      // Подтвердить нечем — ссылка остаётся битой, и разбор скажет об этом прямо.
      if (!b.keyMoment || !(b.objects ?? []).length) continue;
      bible.events.push({
        id,
        observable: b.keyMoment,
        required: false,
        fromPhrase: 1,
        toPhrase: 1,
        objects: b.objects.map((o) => ({ ...o })),
      });
      known.add(id);
      added++;
    }
  }
  return added;
}
