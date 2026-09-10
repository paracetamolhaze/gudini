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
  stateBefore: string;
  stateAfter: string;
  /** одинаковая метка у соседних AI-битов = одна непрерывная сцена (extension) */
  continuityGroup: string | null;
  /** планировщик явно требует непрерывное действие: только тогда разрешён extension */
  continuityRequired: boolean;
  transition: TransitionIntent;
  shotType: ShotType;
  camera: string;
  /** сколько секунд AI просил планировщик (до нормализации под Veo) */
  suggestedDuration: number;
  /** почему бит переведён в author редьюсером (если переведён) */
  reduced?: string;
};

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
