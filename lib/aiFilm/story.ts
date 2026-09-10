import { mediaComplete, parseJson } from "../mediaLlm";
import type { Word } from "../transcribe";
import { characterBlock } from "./character";
import { universePlannerBlock, type UniverseProfile } from "./universe";
import { STAGING_FOR } from "./types";
import type { CharacterProfile, StoryBible, StoryBeat, DisplayMode, BeatPurpose, Priority, ShotType, TransitionIntent, StoryType, CameraAngle, Composition } from "./types";

/**
 * Story Planner v2. Модель получает сценарий, чистую речь по фразам с временем, тему,
 * справку и постоянный Character Bible. Сначала понимает историю целиком (arc), потом
 * делит речь на смысловые биты и для каждого решает: AUTHOR / FULL_AI / HYBRID.
 * AI — только там, где сцена усиливает рассказ; identity Gudini модель не меняет.
 */

export const STORY_MODEL = process.env.AI_FILM_STORY_MODEL || "claude-sonnet-5";
/** 7 — в сцене обязано что-то происходить: события истории вместо подводок к ним. */
export const STORY_VERSION = 7;

/** Границы AI-бита: короче — не прочитать, длиннее — одна сцена не удержит одно действие. */
export const MIN_AI_BEAT_SEC = 4;
export const MAX_AI_BEAT_SEC = 15;
/** Один независимый AI-бит — максимум один клип Veo на 8 с; длиннее только с continuityRequired. */
export const PREFERRED_MAX_AI_SHOT_SEC = 8;
export const MIN_BEAT_SEC = 2;
/**
 * Сколько секунд подряд зритель может смотреть на говорящую голову, прежде чем закроет ролик.
 * Планировщик собирал сцены в конце и оставлял первые двадцать секунд без единой вставки.
 */
export const MAX_AUTHOR_STRETCH_SEC = 12;

/**
 * Сколько сцен нужно на речь такой длины, чтобы нигде не было длинного куска без картинки.
 * Считается по шагу «сцена плюс допустимый разрыв»; на 45 секундах это четыре сцены.
 */
export function minScenes(duration: number): number {
  const step = MIN_AI_BEAT_SEC + MAX_AUTHOR_STRETCH_SEC;
  return Math.max(1, Math.ceil((duration - MAX_AUTHOR_STRETCH_SEC) / step) + 1);
}

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
  return `Ты режиссёр коротких вертикальных роликов (9:16). Автор говорит на камеру непрерывно; его голос и субтитры идут весь ролик. Ты решаешь, что зритель ВИДИТ: самого автора (AUTHOR), снятую сцену на весь экран (FULL_AI) или сцену в карточке над автором (HYBRID). Генерация стоит денег и не должна покрывать весь ролик: ориентир ${Math.round(coverage.target * 100)}% времени, не больше ${Math.round(coverage.max * 100)}%. Меньше — можно.

ДВА ЖЁСТКИХ ТРЕБОВАНИЯ К СТРУКТУРЕ. Их выполняй ПЕРВЫМИ, до того как распределять оставшееся покрытие:
1. Первый бит ролика — full_ai, если в первых фразах есть хоть что-нибудь показуемое (предмет, действие, место, человек). Заказал, купил, приехал, открыл, увидел — всё это показуемо. Ролик, который начинается с двадцати секунд говорящей головы, зритель закрывает, и никакая сильная сцена в конце этого уже не исправит.
2. Между сценами не больше ${MAX_AUTHOR_STRETCH_SEC} секунд подряд одного автора. Если между двумя сценами получается длиннее — поставь сцену в середине этого куска.
Сначала заложи hook и вставки в длинные куски, и только ОСТАТОК ориентира тратьте на кульминацию и развязку. Лучше четыре коротких сцены по всей длине, чем две длинные в конце.

Работай в два шага. Сначала пойми, ЧТО должен показать кадр, и только потом опиши, КАК его снять, чтобы это можно было воспроизвести.

═══ 1. ИДЕНТИЧНОСТЬ (не меняется никогда) ═══
${characterBlock(character)}
${character.name} молчит, не смотрит в камеру и не обращается к зрителю. Его лицо, волосы, костюм и телосложение одинаковы во всех сценах.

═══ 2. СТИЛЬ (зафиксирован) ═══
${character.styleLock}
${universePlannerBlock(universe)}

═══ 3. ТИП ИСТОРИИ РЕШАЕТ ПОСТАНОВКУ ═══
Определи storyType по теме и речи и веди постановку соответственно:
- "news" — реальное событие. Наблюдательная камера: как будто оператор оказался рядом и снимает происходящее. Бытовая достоверность важнее красоты. Кадр — ПОСТАНОВОЧНАЯ РЕКОНСТРУКЦИЯ события, а не найденная запись: не описывай его как архив, документальные кадры, съёмку очевидца или запись с камеры наблюдения.
- "history" — прошлое. Реконструкция эпохи: одежда, техника, транспорт, архитектура, материалы и освещение того времени и места. Никаких современных предметов без основания в речи.
- "philosophy" — размышление. Понятный жизненный эпизод, через который мысль читается в действии. Здесь допустима приземлённая визуальная метафора, если она проясняет мысль и остаётся обычной сценой из жизни.
- "explainer" — разбор темы. Обычная узнаваемая ситуация, показывающая предмет разговора.
Никакого мистического дыма, голограмм, светящихся символов и «парящих мыслей», если этого нет в сценарии.

═══ 4. ФАКТЫ ОТДЕЛЕНЫ ОТ ПОСТАНОВКИ ═══
Если дана справка по теме — участник, поступок, место и исход берутся из неё. Не выдумывай их и не меняй. Постановочные детали (какой свет, откуда камера, во что одет прохожий) выбираешь ты, но они не должны превращаться в новые «факты».

═══ 5. ЧТО ДЕЛАЕТ КАДР ПОХОЖИМ НА СЪЁМКУ ═══
Настоящие пропорции людей. Кожа с порами и текстурой, без бьюти-фильтра. Ткань, металл, дерево и стекло ведут себя как эти материалы. Тени в местах касания. Свет имеет источник, и экспозиция ему соответствует. У предметов есть вес и инерция.
Камера физически может находиться там, откуда снимает. Крупность, объектив и движение выбираются под действие.
НЕ вешай на каждую сцену сразу 8K, HDR, epic, cinematic, боке, блики и тряску — от этого кадр выглядит хуже, а не лучше. Одна-две уместные характеристики.

═══ 6. В СЦЕНЕ ДОЛЖНО ЧТО-ТО ПРОИСХОДИТЬ ═══
Одно действие — это ОДНО СОБЫТИЕ, а не отсутствие событий. Человек, который стоит и поправляет лямку восемь секунд, — это провальная сцена, даже если она снята безупречно.
ПРОВЕРКА: stateBefore и stateAfter обязаны отличаться тем, что зритель УВИДИТ. Было закрыто — стало открыто. Было целым — стало разорванным. Было в руке — стало на земле. Если разницы нет, сцена не нужна, отдай этот бит автору.
ЗАПРЕЩЁННЫЕ действия как главные в сцене: стоит, сидит, держит, смотрит, ждёт, поправляет, готовится, позирует, думает, оглядывается. Это не события.
СОБЫТИЯ, которые надо показывать: заказывает и жмёт кнопку, распаковывает коробку, надевает, шагает с края, купол раскрывается, купол рвётся, дёргает кольцо запасного, приземляется, встаёт, пишет отзыв.

Показывай САМИ события истории по порядку, а не подводки к ним. Если в речи есть «заказал», «пришло», «прыгнул», «порвался», «раскрылся», «приземлился» — это и есть готовый список сцен. Не заменяй событие кадром, где герой к нему готовится.

Не дроби ОДНО событие на несколько платных сцен: «разбежался, прыгнул, перевернулся, раскрыл» — это одна сцена про прыжок, а не четыре. Но и не превращай событие в неподвижную позу.
Меньше одновременно движущихся людей и предметов — выше шанс, что кадр получится. Один человек и один предмет, с которым что-то происходит, — идеальная сцена.

ПРЕДМЕТЫ ИЗ РЕЧИ НАЗЫВАЙ ТОЧНО, со своими приметами: не «a small package», не «an object», не «some gear» — на месте обобщения генератор дорисовывает случайный мусор. Посылка — картонная коробка с почтовой наклейкой; парашют — конкретный купол конкретного цвета.

═══ 7. ВРЕМЯ И ЯКОРЬ ═══
Длительность генерации и длительность показа — разные вещи. Показано будет столько, сколько занимает бит речи; клип может быть длиннее.
Поэтому визуальный смысл должен читаться РАНО, в первые секунды, а главное изменение — попасть в начало или середину сцены, а не в её хвост.
anchorPhrase: слово или короткая фраза ИЗ РЕЧИ этого бита, на которой изменение уже должно быть видно («порвался», «открыл», «нашёл»). Копируй её из текста фразы, не придумывай.
motion (английский) — что происходит внутри клипа по порядку: что делает тело, что происходит с предметами, куда идёт камера. Пиши столько отрезков, сколько нужно действию, не больше трёх. Жёсткой разбивки 0-3/3-6/6-8 нет.

═══ 8. НЕПРЕРЫВНОСТЬ ЗАДАНА ЯВНО ═══
stateBefore / stateAfter (английский, коротко) — состояние предмета и человека до и после сцены. Указывай то, что не должно скакать между кадрами: цвет и форма предмета, целый он или повреждённый, в какой руке, куда направлены движение и взгляд, с какой стороны кадра, какой свет, что надето.
Повреждённое не появляется до повреждения и не становится целым после. Запасной предмет не меняет цвет между сценами.

═══ 9. РАКУРС И КОМПОЗИЦИЯ ВЫБИРАЮТСЯ ПОД ДЕЙСТВИЕ ═══
Это не формальность. Одинаковый ракурс во всех сценах — главная причина, по которой ролик выглядит дёшево.

cameraAngle — откуда смотрит камера:
- "eye_level" — обычный разговор, бытовое действие;
- "low_angle" — снизу вверх: прыжок, высота, превосходство, что-то нависает;
- "high_angle" — сверху вниз под углом: человек мал, обстановка вокруг важнее;
- "overhead" — строго сверху: падение, лежащий человек, раскладка предметов, вид на землю;
- "ground_level" — камера на земле: приземление, ноги, ползёт, уронил;
- "over_shoulder" — из-за плеча: он что-то рассматривает, экран, документ, вид его глазами;
- "profile" — строго сбоку: движение поперёк кадра, силуэт, скорость.
Подряд один и тот же ракурс не ставь: если в прошлой сцене был eye_level, в следующей выбери другой, если действие это позволяет.

composition — где человек в кадре и, главное, ДЛЯ ЧЕГО ОСТАВЛЕНО МЕСТО:
- "center" — человек по центру, вокруг ничего важного;
- "low_space_above" — человек внизу кадра, СВЕРХУ ОСТАВЛЕНО МЕСТО: купол, крона, потолок, небо, то, что над ним;
- "high_space_below" — человек вверху, место снизу: земля под ним, пропасть, то, куда он падает;
- "offset_left" / "offset_right" — человек сбоку, место в другой половине: он смотрит туда, оттуда что-то приближается;
- "subject_small_in_wide" — человек мелко в общем плане: важен масштаб места, а не он.
ПРАВИЛО: всё, что названо в keyMoment, обязано ПОМЕЩАТЬСЯ В КАДР ЦЕЛИКОМ. Если ключевой предмет над человеком — composition "low_space_above" и крупность не ближе medium_wide. Купол парашюта, который не влез в кадр, — это несостоявшаяся сцена.

camera (английский) начинается с позиции камеры и направления движения относительно неё, иначе генератор разворачивает человека в объектив. Формат: «Camera is <где, на каком расстоянии, на какой высоте, под каким углом>; <кто> moves <куда относительно камеры>». Направления: away from camera, toward camera, past camera on the left, across frame left to right, straight down below camera.
Одно мотивированное движение камеры либо неподвижная камера. Требования про падение, ветер, разлетающуюся ткань и прочую физику ставь ТОЛЬКО той сцене, где это происходит.
Плохо: "${character.name} reflects on uncertainty while symbolic lights shift". Хорошо: "Camera is above him looking straight down as he falls away from it; the canopy fills the top of the frame".
shotType: close | medium | medium_wide | wide | full_body. Кадр вертикальный 9:16, для hybrid — горизонтальный 16:9.

═══ 9a. ОДИН ПРЕДМЕТ — ОДНО НАЗВАНИЕ ═══
Ключевой предмет во ВСЕХ сценах называй одной и той же фразой, с цветом и материалом: «the bright orange nylon canopy», «the grey canvas reserve canopy». Не «a parachute» в одной сцене и «the chute» в другой — генератор рисует каждый клип отдельно и по разному описанию сделает разные предметы. Цвет назови обязательно, иначе он поменяется между сценами.

═══ 10. ЛЮДИ В КАДРЕ ═══
Значимые участники — только те, кого называет или подразумевает речь. Не добавляй второго участника события, свидетеля с репликой, «кого-то рядом».
Анонимный фон допустим, если он естественен для места (люди на улице, пассажиры в аэропорту, посетители кафе) — но он не участвует в действии и не смотрит в камеру. Массовку ради «кинематографичности» не создавать.
supportingCharacters: до 6 на ролик, только названные или подразумеваемые; имя, функция opponent|guide|witness|partner|background и короткое узнаваемое описание внешности.

═══ 11. ${character.name.toUpperCase()} — ГЛАВНОЕ ЛИЦО КАНАЛА, А НЕ ВТОРОЙ ЧЕЛОВЕК В КАДРЕ ═══
По умолчанию главного героя истории ИГРАЕТ ${character.name}. Это постановка: канал показывает историю силами своего персонажа, как переигранная сцена, а не как найденная запись.
- Герой истории назван по имени или описан обобщённо («парень», «Каспер», «один чувак») → его роль исполняет ${character.name}. Имя героя запиши в bible.playedByGudini, а отдельным человеком в supportingCharacters его НЕ заводи: в кадре один человек, а не двое.
- ВО ВСЕХ АНГЛИЙСКИХ ПОЛЯХ (visualAction, keyMoment, motion, stateBefore, stateAfter, camera) этого человека называй «${character.name}», а НЕ именем героя истории. Пиши «${character.name} pulls the reserve handle», а не «Casper pulls the reserve handle»: имя героя в промпте заставляет генератор рисовать какого-то другого человека вместо ${character.name}. Имя героя живёт только в bible.playedByGudini и в русских полях meaning и storyBeat.
- Такому биту ставь gudiniVisible=true. Если в сцене вообще есть человек и это герой истории — это он.
- ЕДИНСТВЕННОЕ исключение: широко узнаваемый публичный человек (действующий политик, глава компании, мировая знаменитость, известный спортсмен). Его показывают им самим, playedByGudini оставляй пустым, а ${character.name} может присутствовать в сцене как участник происходящего.
- Если в сцене нет людей вообще (предмет крупным планом, пустое место, пейзаж) — gudiniVisible=false, это нормально.
Костюм на нём не превращает окружающий мир в аниме и не переносит событие в другую вселенную: он просто так одет.

═══ 12. БЕЗ ТЕКСТА И ЭКРАНОВ ═══
Не проси у генератора читаемые интерфейсы, карточки товара, ценники, документы, мелкие цифры и длинные надписи — он их не выводит. Если что-то нужно прочитать, это скажет голос.

═══ 13. РАЗБИВКА РЕЧИ ═══
Сначала заполни storyArc: что зритель должен понять; роль ${character.name}; начало; развитие; конфликт или изменение; кульминация; смысл. Простая читаемая история без нагромождения символов.
Раздели речь на биты по смыслу (обычно 4–12 с; биты покрывают ВСЕ фразы по порядку без пропусков и пересечений; границы — номера фраз). displayMode:
- "author": панчлайн, эмоция автора, плотное объяснение, прямой контакт со зрителем — кадр ничего не добавит.
- "full_ai": сильный hook, показанный пример, reveal, кульминация, эпизод истории. AI-бит ${MIN_AI_BEAT_SEC}–${PREFERRED_MAX_AI_SHOT_SEC} с.
- "hybrid": полезно видеть автора и происходящее одновременно. AI-бит ${MIN_AI_BEAT_SEC}–${PREFERRED_MAX_AI_SHOT_SEC} с.
Один AI-бит — один клип. Если смысловой блок длиннее ${PREFERRED_MAX_AI_SHOT_SEC} с, не растягивай сцену на весь блок: возьми самую сильную часть, остальное отдай автору. Короткая сцена — это нормально: секунды клипа не «пропадают», важнее, чтобы показанное было к месту.
continuityRequired: true только если действие обязано идти без склейки (вошёл → идёт → находит) и не помещается в ${PREFERRED_MAX_AI_SHOT_SEC} с; тогда допустим бит до ${MAX_AI_BEAT_SEC} с. Это дорого — редко.
continuityGroup: одинаковая метка у ДВУХ соседних AI-битов только для такой непрерывной сцены, иначе null.
priority: "high" — hook, ключевой reveal, climax; "medium" — примеры и история; "low" — украшение, которое можно убрать. При нехватке бюджета low снимут первыми.
purpose: hook | setup | explain | example | reveal | emotion | transition | climax | resolution. transition: "cut" (обычно) или "dissolve" (редко).

РАСПРЕДЕЛЕНИЕ — это два жёстких требования из начала инструкции. Проверь себя перед ответом:
- первый бит full_ai, если в первых фразах есть что показать;
- нигде между сценами нет больше ${MAX_AUTHOR_STRETCH_SEC} секунд подряд одного автора;
- сцены стоят по всей длине речи, а не только в конце.
Если из-за этого не хватает покрытия на развязку — укоротите сцены, а не выбрасывайте начало.

Ответь только JSON:
{"storyArc": {"understand": "...", "gudiniRole": "...", "beginning": "...", "development": "...", "conflict": "...", "climax": "...", "meaning": "..."},
 "bible": {"storyType": "news|history|philosophy|explainer", "mood": "english", "lighting": "english", "cameraLanguage": "english", "locations": ["english"], "importantObjects": ["english"], "playedByGudini": "имя героя, роль которого исполняет ${character.name}, или пустая строка", "supportingCharacters": [{"name": "...", "function": "opponent|guide|witness|partner|background", "appearance": "english"}], "continuityRules": ["english", "..."]},
 "beats": [{"fromPhrase": 1, "toPhrase": 2, "meaning": "русский, 1 фраза", "storyBeat": "русский: место в истории", "displayMode": "author|full_ai|hybrid", "purpose": "...", "priority": "low|medium|high", "gudiniVisible": false, "universeAdaptation": "english: what exactly from the speech is on screen", "visualAction": "english: who, where, what he does, what changes", "keyMoment": "english: the one visible change", "anchorPhrase": "слово из речи этого бита", "motion": "english", "location": "english", "stateBefore": "english", "stateAfter": "english", "continuityGroup": null, "continuityRequired": false, "transition": "cut", "shotType": "medium", "camera": "english", "cameraAngle": "eye_level|low_angle|high_angle|overhead|ground_level|over_shoulder|profile", "composition": "center|low_space_above|high_space_below|offset_left|offset_right|subject_small_in_wide"}]}
Для author-битов universeAdaptation/visualAction/keyMoment/anchorPhrase/location/state оставляй пустыми строками, gudiniVisible=false.`;
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
  composition?: string;
};

type RawStory = { storyArc?: Partial<StoryBible["storyArc"]>; bible?: any; beats?: RawBeat[] };

const str = (v: unknown, d = "") => (typeof v === "string" && v.trim() ? v.trim() : d);
const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
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
  if (/level with (?:him|his)|at (?:his )?eye level|at chest height/.test(clause)) return "eye_level";
  if (/in front of (?:him|gudini)|facing him|opposite him/.test(clause)) return "eye_level";
  return null;
}

/**
 * Ракурс и композиция не должны противоречить друг другу. Камера строго сверху и место
 * в кадре, оставленное НАД человеком, — это взаимоисключающие требования: то, что над ним,
 * находится между ним и камерой и просто закроет кадр.
 */
export function reconcileFraming(beat: Pick<StoryBeat, "camera" | "cameraAngle" | "composition">): boolean {
  let changed = false;
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
  const storyType: StoryType = (STORY_TYPES as readonly string[]).includes(b.storyType) ? (b.storyType as StoryType) : "explainer";
  // Тот, кого играет постоянный персонаж, — это он сам, а не второй человек в кадре.
  // Без этого планировщик писал «Гудини играет Каспера» и одновременно заводил Каспера
  // отдельным персонажем, и в кадре оказывалось двое.
  //
  // Роль героя истории исполняет персонаж канала, в том числе в новости: это заявленная
  // постановка, и флаг reconstruction ниже как раз про то, что кадр — переигранная сцена,
  // а не запись события. Ограничение одно и живёт в промпте: узнаваемого публичного
  // человека подменять собой нельзя, его показывают им самим.
  const playedByGudini = str(b.playedByGudini);
  const cast = playedByGudini
    ? supporting.filter((c: any) => c.name.toLowerCase() !== playedByGudini.toLowerCase())
    : supporting;
  return {
    characterId: character.id,
    universeId: universe.id,
    storyType,
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
    // Якорь обязан быть словом из речи этого бита: иначе тайминг привязан к выдумке,
    // а не к тому, что зритель услышит. Не нашли — оставляем пустым, а не «почти похожим».
    const spoken = phrases.slice(it.from - 1, it.to).map((p) => p.text).join(" ").toLowerCase();
    const anchorRaw = str(e.anchorPhrase);
    const anchorPhrase = anchorRaw && spoken.includes(anchorRaw.toLowerCase()) ? anchorRaw : "";
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
      composition: (COMPOSITIONS as string[]).includes(String(e.composition)) ? (e.composition as Composition) : "center",
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
  // Камера и композиция сводятся к одному непротиворечивому описанию до того, как из них
  // соберут промпт: иначе Veo получает «камера сверху» и «камера снизу» в одном тексте.
  for (const b of beats) if (b.displayMode !== "author") reconcileFraming(b);

  // AI-бит короче минимума — автор (AI за 2–3 секунды не прочитать). Открывающий бит
  // пропускаем: им занимаемся ниже, когда соседи уже приведены в порядок.
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    if (i === 0) continue;
    if (b.displayMode !== "author" && b.end - b.start < MIN_AI_BEAT_SEC - 1e-6) {
      b.displayMode = "author";
      b.requiresGeneration = false;
      b.gudiniVisible = false;
      b.continuityGroup = null;
      b.reduced = `AI-бит короче ${MIN_AI_BEAT_SEC} с`;
    }
  }

  // Открывающая сцена короче минимума не выбрасывается, а дотягивается за счёт следующего
  // авторского бита. Хук в речи часто занимает три секунды («парень заказал парашют за
  // пять долларов»), и правило «короче четырёх — в автора» убивало ровно ту сцену, которая
  // держит первые секунды ролика. Соседу оставляем минимум секунду.
  // Делается ПОСЛЕ общей проверки: сосед мог сам быть коротким AI-битом и только что стать
  // автором — тогда занимать время у него уже можно.
  const first = beats[0];
  if (first && first.displayMode !== "author" && first.end - first.start < MIN_AI_BEAT_SEC - 1e-6) {
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

export async function planStory(args: {
  words: Word[];
  script: string;
  topic?: string;
  researchSummary?: string;
  character: CharacterProfile;
  universe: UniverseProfile;
  duration: number;
  coverage: { target: number; max: number };
  /** что было нарушено в прошлой попытке — второй заход с названными ошибками */
  retryNote?: string;
}): Promise<{ bible: StoryBible; beats: StoryBeat[]; phrases: Phrase[] }> {
  const phrases = phrasesFromWords(args.words);
  if (phrases.length < 2) throw new Error("AI-фильм: в речи меньше двух фраз — не из чего строить историю");
  const list = phrases.map((p) => `${p.index}. [${p.start.toFixed(1)}–${p.end.toFixed(1)} с] ${p.text}`).join("\n");
  const user =
    `${args.topic ? `Тема ролика: ${args.topic}\n` : ""}` +
    `${args.researchSummary ? `Справка по теме (факты, чтобы не выдумывать): ${args.researchSummary.slice(0, 1500)}\n\n` : ""}` +
    `Сценарий (что автор хотел сказать):\n${args.script.slice(0, 4000)}\n\n` +
    `Речь автора по фразам (чистый таймлайн, всего ${args.duration.toFixed(1)} с):\n${list}\n\n` +
    // Число модель выполняет заметно охотнее, чем правило: «не больше 12 секунд подряд»
    // она трактует как пожелание, а «нужно минимум 4 сцены» — как задачу.
    `СЧИТАЙ САМ: речь длится ${args.duration.toFixed(0)} секунд. Чтобы нигде не было больше ${MAX_AUTHOR_STRETCH_SEC} секунд подряд без картинки, ` +
    `на этой длине нужно НЕ МЕНЬШЕ ${minScenes(args.duration)} сцен, и первая из них — в самом начале. ` +
    `Расставь их по всей длине речи и проверь себя по номерам фраз перед тем, как отвечать.` +
    (args.retryNote
      ? `\n\nПРЕДЫДУЩИЙ ТВОЙ ПЛАН НА ЭТУ ЖЕ РЕЧЬ НАРУШИЛ ЖЁСТКИЕ ТРЕБОВАНИЯ К СТРУКТУРЕ:\n${args.retryNote}\n` +
        `Составь план заново и исправь именно это. Остальное можно оставить прежним.`
      : "");
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
