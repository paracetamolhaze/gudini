/**
 * AI_FILM v2 — «Gudini Narrative Mode».
 *
 * Автор идёт непрерывно (голос, субтитры), а видеоряд переключается между
 * AUTHOR (его видео), FULL_AI (AI-сцена на весь кадр 9:16) и HYBRID (AI в карточке
 * сверху, автор снизу). AI генерируется только там, где сцена усиливает рассказ.
 * Главный герой всех AI-сцен — постоянный персонаж Gudini с эталонными картинками.
 */

export type DisplayMode = "author" | "full_ai" | "hybrid";
export type BeatPurpose = "hook" | "setup" | "explain" | "example" | "reveal" | "emotion" | "transition" | "climax" | "resolution";
export type Priority = "low" | "medium" | "high";
export type ShotType = "close" | "medium" | "medium_wide" | "wide" | "full_body";
export type TransitionIntent = "cut" | "dissolve";
export type GenerationProfile = "character" | "environment" | "continuation";

/**
 * Тип истории решает постановку, а не стиль. Стиль один — фотореализм; меняется то,
 * что камера снимает: наблюдение за происходящим, реконструкция эпохи или бытовой эпизод.
 */
export type StoryType = "news" | "history" | "philosophy" | "explainer";
export type StagingMode = "observational" | "period_reconstruction" | "everyday_life";

/**
 * Откуда смотрит камера. Раньше ракурс не выбирался вообще: в промпт уходила одна и та же
 * фраза про уровень глаз, и все сцены выглядели одинаково снятыми.
 */
export type CameraAngle = "eye_level" | "low_angle" | "high_angle" | "overhead" | "ground_level" | "over_shoulder" | "profile";

/**
 * Где в кадре стоит человек. «По центру» было зашито в сборщик для каждой сцены, поэтому
 * купол над головой просто не помещался в кадр: важное оказывалось за краем.
 */
export type Composition = "center" | "low_space_above" | "high_space_below" | "offset_left" | "offset_right" | "subject_small_in_wide";

/**
 * Состояние конкретного предмета до и после. Предмет назван идентификатором, а не описанием,
 * потому что проверки путали основной и запасной купол: «порванное стало целым» срабатывало
 * на переходе от разорванного основного к упакованному запасному.
 */
export type ObjectState = {
  /**
   * Короткий устойчивый идентификатор того, чьё состояние меняется. Это не обязательно
   * физический предмет: событием может быть решение, передача, отказ или смена отношений,
   * и тогда id называет их носителя — «seat», «keys-owner», «permission».
   */
  id: string;
  /** состояние до сцены, английский, коротко */
  before: string;
  /** состояние после сцены, английский, коротко */
  after: string;
  /**
   * Что это для события: «change» — обязательство, которое сцена обязана показать;
   * «keep» — условие, которое сохраняется и показывать как изменение нечего.
   * Раньше обязательность угадывалась по тому, назван ли предмет в тексте события,
   * и переименование внутренних имён меняло результат проверки.
   */
  role?: "change" | "keep";
};

/**
 * Существенные условия сцены одним согласованным местом. Появилось после ролика, в котором
 * надетый ранец пропал из запроса: сборщик брал состояние предметов и молча выбрасывал
 * сводку сцены, где он был назван. Поля заполняются по необходимости — обычному разговору
 * не нужны ни опоры, ни нагрузки.
 */
export type SceneState = {
  /** кто где находится, куда обращён, что держит */
  who?: string;
  /** что надето или закреплено на человеке и сохраняется между сценами */
  worn?: string[];
  /** реквизит, обязанный быть в кадре, даже если сам не меняется */
  props?: string[];
  /** что запускает действие, что с чем соприкасается, как меняется опора или нагрузка */
  mechanics?: string;
};

/**
 * Обязательное событие истории: то, без чего рассказ не состоится. Составляется ДО того,
 * как распределяется экранное время, и проверяется ПОСЛЕ всех преобразований плана.
 *
 * Раньше такого контракта не было, и план спокойно доходил до оплаты, показав вместо
 * получения посылки уже стоящую на столе коробку, а вместо отзыва — приземление.
 */
export type StoryEvent = {
  /** короткий идентификатор: order, delivery, jump, tear, reserve, landing, review */
  id: string;
  /** что зритель обязан УВИДЕТЬ, английский; не пересказ речи, а наблюдаемое изменение */
  observable: string;
  /** без этого события история не читается */
  required: boolean;
  /** на каких фразах речи событие звучит */
  fromPhrase: number;
  toPhrase: number;
  /** какие предметы и как меняются — по ним проверяется, что сцена действительно его показала */
  objects: ObjectState[];
};

/**
 * Проблема плана с тяжестью. `block` — план в таком виде до оплаты не допускается:
 * обязательное событие не показано или кадр физически невыполним. `warn` — замечание,
 * оно генерацию не запрещает. Живёт здесь, а не в разборе, чтобы план мог её хранить.
 */
export type PlanIssue = {
  code: string;
  severity: "block" | "warn";
  beatIds: string[];
  eventIds?: string[];
  message: string;
};

/** Какая постановка соответствует типу истории. */
export const STAGING_FOR: Record<StoryType, StagingMode> = {
  news: "observational",
  history: "period_reconstruction",
  philosophy: "everyday_life",
  explainer: "everyday_life",
};

/** Постоянный персонаж: identity не зависит от проекта и не генерируется Claude. */
export type CharacterProfile = {
  id: string;
  name: string;
  role: "main_protagonist";
  description: string;
  appearance: string;
  clothes: string;
  signature: string;
  /** единый визуальный стиль всех роликов с этим персонажем */
  styleLock: string;
  /** мир/сеттинг, в котором живут истории */
  world: string;
  negative?: string;
  /** файлы эталонов относительно папки персонажа (до 3, порядок важен) */
  referenceImages: string[];
  /** абсолютные пути найденных эталонов */
  referenceFiles: string[];
  /** хэш байтов эталонов — часть ключа кэша сцен */
  refHash: string;
  /** где лежит профиль */
  dir: string;
};

export type SupportingCharacter = {
  name: string;
  function: "opponent" | "guide" | "witness" | "partner" | "background";
  appearance: string;
};

export type StoryArc = {
  /** что зритель должен понять */
  understand: string;
  /** роль Gudini в этой визуальной истории */
  gudiniRole: string;
  beginning: string;
  development: string;
  conflict: string;
  climax: string;
  meaning: string;
};

export type StoryBible = {
  characterId: string;
  /** Universe Lock: мир, в котором происходят все AI-сцены */
  universeId: string;
  /** о чём ролик: от этого зависит постановка кадра, но не стиль */
  storyType: StoryType;
  staging: StagingMode;
  /**
   * Кадры новости — постановочная реконструкция, а не найденная съёмка события.
   * Флаг хранится в плане, чтобы происхождение материала нельзя было перепутать позже.
   */
  reconstruction: boolean;
  /** стиль зафиксирован профилем персонажа */
  visualStyle: string;
  world: string;
  mood: string;
  lighting: string;
  cameraLanguage: string;
  locations: string[];
  importantObjects: string[];
  supportingCharacters: SupportingCharacter[];
  /** кого из людей истории играет постоянный персонаж (пусто — никого) */
  playedByGudini: string;
  continuityRules: string[];
  storyArc: StoryArc;
  /** обязательные события истории; проверяются на покрытие после всех преобразований плана */
  events: StoryEvent[];
  /** сколько записей контракта нормализатор не смог разобрать вовсе: разбор считает это ошибкой */
  eventsDropped?: number;
};

/** Смысловой блок речи. Покрывают всю речь встык; AI есть только у full_ai/hybrid. */
export type StoryBeat = {
  id: string;
  start: number;
  end: number;
  /** смысл фрагмента речи, русский */
  meaning: string;
  /** место в истории, русский */
  storyBeat: string;
  displayMode: DisplayMode;
  purpose: BeatPurpose;
  priority: Priority;
  requiresGeneration: boolean;
  gudiniVisible: boolean;
  /** как исходная мысль автора переведена в события мира (Universe Lock), английский */
  universeAdaptation: string;
  /** WHO / WHAT HE DOES / WHERE / WHAT CHANGES — английский, одно ясное действие */
  visualAction: string;
  location: string;
  /** существенные условия сцены: кто где, что надето, какой реквизит в кадре, что двигает действие */
  scene?: SceneState;
  /** движение по секундам внутри клипа: что делает тело, куда идёт камера, как ведут себя предметы */
  motion: string;
  /**
   * Одно видимое изменение, ради которого снимается сцена («the canopy tears open»).
   * Уходит в промпт отдельной строкой: у Veo одна цель, а не список действий.
   */
  keyMoment: string;
  /**
   * Слово или короткая фраза из речи, на которой это изменение должно быть уже видно.
   * Пишется в план для проверки тайминга; исполнение Veo этим не гарантируется.
   */
  anchorPhrase: string;
  /**
   * Абсолютная секунда речи, на которой звучит якорь. Хранится именно абсолютной: границы
   * битов сдвигаются при сведении встык, и относительное смещение после этого врало —
   * событие запрашивалось на 5-й секунде вместо 7-й.
   */
  anchorAbsSec: number | null;
  /**
   * Секунда внутри бита, пересчитанная из абсолютной после всех сдвигов границ.
   * null — якоря нет, он не найден в речи или оказался вне бита.
   */
  anchorAtSec: number | null;
  /** какие обязательные события эта сцена показывает */
  eventIds: string[];
  /** состояние предметов сцены по идентификаторам — основа проверок непрерывности */
  objects: ObjectState[];
  stateBefore: string;
  stateAfter: string;
  /** одинаковая метка у соседних AI-битов = одна непрерывная сцена (extension) */
  continuityGroup: string | null;
  /** планировщик явно требует непрерывное действие: только тогда разрешён extension */
  continuityRequired: boolean;
  transition: TransitionIntent;
  shotType: ShotType;
  camera: string;
  /** откуда смотрит камера — выбирается под действие, а не по умолчанию */
  cameraAngle: CameraAngle;
  /** где человек в кадре и для чего оставлено место */
  composition: Composition;
  /** сколько секунд AI просил планировщик (до нормализации под Veo) */
  suggestedDuration: number;
  /** почему бит переведён в author редьюсером (если переведён) */
  reduced?: string;
};

/**
 * Срок одного события внутри клипа: что показать и к какой секунде клипа. Живёт в контракте,
 * а не в сборщике, потому что по нему проверяет и разбор готового плана.
 */
export type EventDeadline = { beatId: string; eventIds: string[]; keyMoment: string; bySec: number | null; beyond?: boolean };

export type FilmShot = {
  id: string;
  groupId: string;
  index: number;
  beatIds: string[];
  displayMode: Exclude<DisplayMode, "author">;
  gudiniVisible: boolean;
  generationProfile: GenerationProfile;
  model: string;
  mode: "text" | "extend";
  /** сколько секунд клипа реально попадёт в ролик */
  usedSeconds: number;
  /** сколько секунд генерирует Veo (нормализовано: 4/6/8, extension 7, референсы 8) */
  veoSeconds: number;
  aspectRatio: "16:9" | "9:16";
  resolution: "720p";
  useReferences: boolean;
  /** обязательные события, которые обязан показать именно этот запрос */
  eventIds: string[];
  /**
   * К какой секунде клипа изменение обязано быть видно. Считается из якоря в речи и из
   * того, какой отрезок клипа реально попадёт в монтаж: раньше в промпте стояло общее
   * «происходит рано», и смена якоря промпт не меняла вовсе.
   */
  changeBySec: number | null;
  /** сроки всех событий клипа по отдельности: раньше все изменения получали срок первого */
  deadlines: EventDeadline[];
  prompt: string;
  /** предыдущий shot цепочки — только для extend */
  dependsOn: string | null;
  /** цена этого вызова */
  cost: number;
};

export type ContinuityGroup = {
  id: string;
  displayMode: Exclude<DisplayMode, "author">;
  /** отрезок ролика, который закрывает клип группы */
  start: number;
  end: number;
  shotIds: string[];
  chain: boolean;
  aspectRatio: "16:9" | "9:16";
};

export type TimelineSegment = {
  start: number;
  end: number;
  mode: DisplayMode;
  groupId?: string;
  beatIds: string[];
};

export type PlanStats = {
  speechSeconds: number;
  /** секунд ролика с AI на экране */
  aiSeconds: number;
  /** секунд, которые генерирует Veo (с округлением до поддерживаемых) */
  generatedSeconds: number;
  /** сгенерировано сверх того, что попадёт на экран */
  overheadSeconds: number;
  /** aiSeconds / generatedSeconds; для sparse-монтажа желательно > 0.75 */
  generationEfficiency: number;
  coverage: number;
  calls: number;
  groups: number;
  independentGroups: number;
  chains: number;
  longestChainCalls: number;
  estimatedCost: number;
  estimatedWallMinutes: number;
  concurrency: number;
  reducedBeats: number;
};

export type PlanPricing = {
  model: string;
  resolution: "720p";
  audio: false;
  pricePerSec: number;
  source: "policy" | "env";
};

export type AiFilmPlan = {
  version: number;
  createdAt: string;
  key: string;
  duration: number;
  character: { id: string; name: string; refHash: string; referenceCount: number };
  universeId: string;
  universe: { id: string; name: string; hash: string };
  bible: StoryBible;
  beats: StoryBeat[];
  groups: ContinuityGroup[];
  shots: FilmShot[];
  timeline: TimelineSegment[];
  pricing: PlanPricing;
  budgetUsd: number;
  stats: PlanStats;
  warnings: string[];
  /**
   * Типизированные проблемы плана с тяжестью. Раньше тяжесть определялась подсчётом строк
   * предупреждений, и план с непоказанным обязательным событием доходил до кнопки оплаты.
   */
  issues: PlanIssue[];
  /**
   * Отпечаток режиссёрского промпта и сборщика запросов. Версии формата плана недостаточно:
   * одиннадцать коммитов подряд меняли инструкции, не трогая номер версии, и сохранённый
   * план со старыми промптами считался актуальным.
   */
  compilerFingerprint: string;
};

export type AiFilmShotResult = {
  shotId: string;
  key: string;
  gcsUri: string;
  file: string;
  operation: string;
  veoSeconds: number;
  cost: number;
  createdAt: string;
};

export type GroupClip = {
  groupId: string;
  /** файл клипа относительно папки проекта */
  file: string;
  seconds: number;
};

export type AiFilmState = {
  request?: "plan" | "generate";
  plan?: AiFilmPlan;
  status?: "planned" | "generated" | "failed";
  generatedAt?: string;
  spent?: number;
  error?: string;
};
