/**
 * AI_FILM — второй стиль монтажа: сверху цельный сгенерированный фильм по истории,
 * снизу автор с субтитрами и своим звуком. Типы плана и состояния.
 */

export type StoryBible = {
  /** единый визуальный стиль всех сцен, английский */
  visualStyle: string;
  mainCharacter: {
    description: string;
    appearance: string;
    clothes: string;
    /** заметные детали, по которым герой узнаётся: номер на форме, шрам, кепка */
    signature: string;
  } | null;
  locations: string[];
  importantObjects: string[];
  mood: string;
  cameraLanguage: string;
  storyArc: string;
  continuityRules: string[];
};

export type FilmEpisode = {
  id: string;
  /** секунды на чистом таймлайне речи */
  start: number;
  end: number;
  /** смысл фрагмента речи, русский — для показа пользователю */
  meaning: string;
  /** что происходит в кадре, английский — основа промпта */
  visualAction: string;
  location: string;
  /** состояние героя/сцены после эпизода — для continuity */
  stateAfter: string;
  /** переход к следующему эпизоду: продолжение той же сцены или сюжетный переход */
  transition: "continue" | "match_cut" | "new_sequence";
};

export type FilmScene = {
  id: string;
  sequence: number;
  index: number;
  episodeId: string;
  /** полный промпт для Veo: стиль + герой + действие + камера + continuity */
  prompt: string;
  /** секунды генерации: 8 для первой сцены последовательности, 7 для продолжений */
  seconds: number;
  /** "text" — по тексту, "image" — от последнего кадра предыдущей последовательности, "extend" — продолжение */
  mode: "text" | "image" | "extend";
};

export type FilmSequence = {
  index: number;
  scenes: FilmScene[];
  /** покрываемый отрезок речи */
  start: number;
  end: number;
  /** сумма секунд генерации */
  seconds: number;
};

export type AiFilmPlan = {
  version: number;
  createdAt: string;
  model: string;
  pricePerSec: number;
  /** ключ входных данных: расшифровка + сценарий + версия */
  key: string;
  duration: number;
  bible: StoryBible;
  episodes: FilmEpisode[];
  sequences: FilmSequence[];
  /** секунд генерации всего и оценка стоимости */
  totalSeconds: number;
  estimatedCost: number;
  /** сколько вызовов Veo и примерное время */
  calls: number;
  estimatedMinutes: number;
};

export type AiFilmSceneResult = {
  sceneId: string;
  key: string;
  gcsUri: string;
  file: string;
  operation: string;
  seconds: number;
  cost: number;
  createdAt: string;
};

export type AiFilmState = {
  /** что просил пользователь последним: план или генерация */
  request?: "plan" | "generate";
  plan?: AiFilmPlan;
  status?: "planned" | "generated" | "failed";
  generatedAt?: string;
  spent?: number;
  error?: string;
};
