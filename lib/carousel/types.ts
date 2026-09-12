/**
 * Карусели — отдельный раздел сайта: идея → Claude пишет слайды и подпись → рендер
 * карточек → правки → публикация в Instagram. С видеопроектами не пересекается ни
 * хранилищем, ни очередью: всё лежит в data/carousels/<id>/.
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
  /** текст не поместился или шрифт не покрыл символы: файла нет */
  error?: string;
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
  render?: SlideRender;
};

export type CarouselStyleId = "graphite" | "paper" | "sunset" | "ocean" | "contrast";
export type CarouselFormat = "portrait" | "square";
export type CarouselLanguage = "ru" | "uk" | "en";

export type CarouselRequest = {
  idea: string;
  wishes: string;
  slideCount: number;
  language: CarouselLanguage;
  style: CarouselStyleId;
  format: CarouselFormat;
};

export type JobType = "generate" | "render" | "regenerate_slide" | "instruct" | "publish" | "verify_publish";
export type JobState = "queued" | "running" | "done" | "error";

export type JobParams = {
  slideId?: string;
  hint?: string;
  instruction?: string;
  /** generate: «planned» — тексты уже записаны, при возобновлении остаётся только рендер */
  stage?: "planned";
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

export type PublishState = {
  status: PublishStatus;
  stage?: PublishStage;
  /** ревизия карусели, которую пользователь просмотрел и отправил */
  revision?: number;
  items: PublishItem[];
  caption?: string;
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

export type Carousel = {
  id: string;
  schema: 1;
  createdAt: string;
  updatedAt: string;
  /** растёт при каждом изменении содержимого; публикация сверяет её с просмотренной */
  revision: number;
  title: string;
  request: CarouselRequest;
  style: CarouselStyleId;
  format: CarouselFormat;
  language: CarouselLanguage;
  /** подпись внизу каждой карточки, например @аккаунт */
  footer: string;
  story: string[];
  slides: Slide[];
  caption: string;
  hashtags: string[];
  /** утверждения, которые Claude советует проверить перед публикацией */
  claimsToCheck: string[];
  /** иллюстрации не генерируются: карточки с типографикой и графическим оформлением */
  mode: "text_cards";
  job: CarouselJob | null;
  publish: PublishState;
  cost: { usd: number; calls: number };
};
