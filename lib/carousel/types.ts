/**
 * Карусели — отдельный раздел сайта: идея → Claude готовит содержание и описания иллюстраций →
 * генератор рисует иллюстрации → сайт собирает карточки → правки → публикация в Instagram
 * сразу или по расписанию. С видеопроектами не пересекается ни хранилищем, ни очередью,
 * ни ключами: всё лежит в data/carousels/, запросы идут через отдельный ключ OpenRouter.
 */

export type SlideKind = "cover" | "content" | "final";

export type SlideRender = {
  /** отпечаток содержимого и оформления, по которому сделан файл */
  hash: string;
  file?: string;
  width?: number;
  height?: number;
  bytes?: number;
  /** коэффициент кегля после подгонки: 1 — без уменьшения */
  scale?: number;
  at: string;
  /** текст не поместился, шрифт не покрыл символы или нет иллюстрации: файла нет */
  error?: string;
};

export type ImageModelId = "google/gemini-3.1-flash-image" | "google/gemini-3-pro-image" | "openai/gpt-image-2";
export type TextPlacement = "top" | "bottom";

export type ImageReference = { kind: "account" | "anchor" | "source"; file: string };

/** Одна сгенерированная иллюстрация. Версии не удаляются: к любой можно вернуться. */
export type ImageVersion = {
  id: string;
  file: string;
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
  model: ImageModelId;
  resolution: string | null;
  kind: "generate" | "edit";
  /** промпт, ушедший в генератор целиком */
  prompt: string;
  instruction?: string;
  references: ImageReference[];
  cost: number;
  estimated: boolean;
  at: string;
};

export type SlideImageStatus = "none" | "generating" | "ready" | "error" | "uncertain";

export type SlideImage = {
  /** что изображено именно на этом слайде (от Claude, по-английски) */
  brief: string;
  /** кадр, ракурс, где главный объект */
  composition: string;
  /** где на карточке текст — там иллюстрация должна быть спокойной */
  textPlacement: TextPlacement;
  versions: ImageVersion[];
  currentId?: string;
  /**
   * Растёт при выборе версии и правке описания. Задание запоминает значение при старте:
   * если за время генерации пользователь что-то поменял, новая версия сохраняется, но не
   * становится текущей — поздний ответ не перезаписывает более новую правку.
   */
  rev: number;
  status: SlideImageStatus;
  error?: string;
  /** запрос к генератору отправлен, результат ещё не записан — после перезапуска исход неизвестен */
  inFlight?: { at: string; jobId: string; spendId: string };
  attempts: number;
};

export type Slide = {
  id: string;
  kind: SlideKind;
  /** короткая метка над заголовком: «Ошибка №2», «Шаг 3» */
  kicker: string;
  title: string;
  body: string;
  bullets: string[];
  /** призыв на заключительной карточке */
  cta: string;
  image?: SlideImage;
  render?: SlideRender;
};

export type CarouselStyleId = "graphite" | "paper" | "sunset" | "ocean" | "contrast";
export type CarouselFormat = "portrait" | "square";
export type CarouselLanguage = "ru" | "uk" | "en";
export type CarouselMode = "text_cards" | "illustrated";

export type CarouselRequest = {
  idea: string;
  /** старые карусели: отдельное поле пожеланий; в новом сценарии пожелания пишутся в идее */
  wishes: string;
  slideCount: number;
  language: CarouselLanguage;
  /** цветовой шаблон старых текстовых карточек */
  style: CarouselStyleId;
  format: CarouselFormat;
  imageModel?: ImageModelId;
};

/** Оформление аккаунта: задаётся один раз, карусель при создании сохраняет свою копию. */
export type DesignSettings = {
  accent: string;
  textColor: string;
  scrimColor: string;
  titleFont: "display" | "condensed";
  /** подпись автора внизу карточек, например @аккаунт */
  author: string;
  logoFile?: string;
  /** предпочтительный стиль иллюстраций своими словами */
  illustrationStyle: string;
  /** необязательный визуальный референс стиля */
  referenceFile?: string;
  updatedAt?: string;
};

/** Общая визуальная концепция серии от Claude. */
export type VisualConcept = {
  idea: string;
  style: string;
  palette: string;
  lighting: string;
  characters: { name: string; look: string }[];
  objects: string[];
};

export type JobType = "generate" | "render" | "regenerate_slide" | "instruct" | "images" | "image" | "publish" | "verify_publish";
export type JobState = "queued" | "running" | "done" | "error";

export type JobParams = {
  slideId?: string;
  slideIds?: string[];
  hint?: string;
  instruction?: string;
  /** image: новая иллюстрация или правка текущей поручением */
  mode?: "regenerate" | "edit";
  /** regenerate_slide: вместе с текстом нарисовать и новую иллюстрацию */
  withImage?: boolean;
  /** images: повторить в том числе слайды с неизвестным исходом (явное решение пользователя) */
  includeUncertain?: boolean;
  /** generate: «planned» — содержание уже записано, при возобновлении остаются иллюстрации и сборка */
  stage?: "planned";
  /** publish: публикация по расписанию */
  scheduleId?: string;
};

export type CarouselJob = {
  id: string;
  type: JobType;
  state: JobState;
  step: string;
  progress: number;
  params: JobParams;
  error?: string;
  /** итог для пользователя: что изменено, какие слайды требуют правки */
  note?: string;
  attempts: number;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  heartbeatAt?: string;
  runnerPid?: number;
};

export type PublishStage = "prepare" | "children" | "container" | "publish_sent" | "verifying" | "done";
export type PublishStatus = "idle" | "queued" | "running" | "published" | "failed" | "uncertain";

export type PublishItem = { slideId: string; file: string; containerId?: string; createdAt?: string };

/** Аккаунт Instagram, выбранный для конкретной публикации: переключение активного его не меняет. */
export type PublishAccount = { id: string; igUserId: string; label: string | null; via: "ig" | "fb" };

export type PublishState = {
  status: PublishStatus;
  stage?: PublishStage;
  /** ревизия карусели, которую пользователь просмотрел и отправил */
  revision?: number;
  items: PublishItem[];
  caption?: string;
  account?: PublishAccount;
  scheduleId?: string;
  igUserId?: string;
  accountLabel?: string;
  containerId?: string;
  containerCreatedAt?: string;
  publishSentAt?: string;
  publishAttempts: number;
  mediaId?: string;
  permalink?: string;
  publishedAt?: string;
  /** пояснение к итогу, не ошибка: например, пост вышел, но ссылку Instagram не вернул */
  note?: string;
  error?: string;
  /** можно ли просто повторить: в Instagram ничего не ушло или проверка это подтвердила */
  retryable?: boolean;
  log: { at: string; text: string }[];
};

export type ScheduleStatus = "scheduled" | "queued" | "publishing" | "published" | "failed" | "uncertain" | "canceled" | "missed";

export type ScheduleSnapshot = {
  revision: number;
  items: { slideId: string; file: string }[];
  caption: string;
  approvedAt: string;
};

export type ScheduleState = {
  id: string;
  status: ScheduleStatus;
  /** момент публикации в UTC */
  runAt: string;
  timeZone: string;
  /** время, которое выбрал пользователь, в его часовом поясе: 2026-09-14T10:00 */
  localTime: string;
  account: PublishAccount;
  snapshot: ScheduleSnapshot;
  createdAt: string;
  updatedAt: string;
  permalink?: string;
  error?: string;
  history: { at: string; text: string }[];
};

export type CarouselCost = {
  /** итог по карусели, $ */
  usd: number;
  calls: number;
  text?: number;
  images?: number;
  /** запросы с неизвестным исходом, учтённые по оценке */
  uncertain?: number;
  /** расход старых карусель, созданных до журнала раздела */
  legacyUsd?: number;
};

export type Carousel = {
  id: string;
  schema: 1 | 2;
  createdAt: string;
  updatedAt: string;
  /** растёт при каждом изменении содержимого; публикация сверяет её с просмотренной */
  revision: number;
  title: string;
  request: CarouselRequest;
  style: CarouselStyleId;
  format: CarouselFormat;
  language: CarouselLanguage;
  /** подпись внизу старых текстовых карточек */
  footer: string;
  story: string[];
  slides: Slide[];
  caption: string;
  hashtags: string[];
  /** утверждения, которые Claude советует проверить перед публикацией */
  claimsToCheck: string[];
  /** text_cards — старые карточки без иллюстраций; illustrated — новый сценарий с генерацией */
  mode: CarouselMode;
  imageModel?: ImageModelId;
  imageResolution?: string | null;
  design?: DesignSettings;
  visual?: VisualConcept;
  /** опора серии: иллюстрация, которую получают как референс следующие слайды */
  anchor?: { slideId: string; versionId: string; file: string };
  job: CarouselJob | null;
  publish: PublishState;
  schedule?: ScheduleState;
  cost: CarouselCost;
};
