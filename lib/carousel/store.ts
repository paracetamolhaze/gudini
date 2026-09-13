import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Carousel, CarouselJob, CarouselMode, CarouselRequest, DesignSettings, ImageModelId, JobParams, JobType, PublishState, SlideImage } from "./types";
import { CAROUSEL_LIMITS } from "./limits";

/**
 * Хранилище каруселей: data/carousels/<id>/carousel.json, готовые карточки в slides/,
 * версии иллюстраций в images/. Отдельно от db.json и uploads видеопроектов — ни чтение,
 * ни запись каруселей их не касаются.
 *
 * Файл карусели меняют несколько процессов: сайт (правки пользователя, планировщик) и
 * фоновый обработчик (статус задания, иллюстрации, рендер). Поэтому каждое изменение идёт
 * под файловой блокировкой: прочитать → изменить → атомарно записать.
 */

export class CarouselError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CarouselError";
  }
}

export const notFound = () => new CarouselError("Карусель не найдена", 404, "not_found");

export function carouselsRoot(): string {
  const custom = process.env.CAROUSEL_DATA_DIR;
  return custom ? path.resolve(custom) : path.join(process.cwd(), "data", "carousels");
}

const CAROUSEL_ID_RE = /^c[a-z0-9]{12,40}$/;
const SLIDE_ID_RE = /^s[a-z0-9]{12,40}$/;
const SLIDE_FILE_RE = /^slide-s[a-z0-9]{12,40}-[a-f0-9]{12}\.jpg$/;
const IMAGE_FILE_RE = /^img-s[a-z0-9]{12,40}-v[a-z0-9]{12,40}\.(png|jpg|webp)$/;

export const isCarouselId = (v: unknown): v is string => typeof v === "string" && CAROUSEL_ID_RE.test(v);
export const isSlideId = (v: unknown): v is string => typeof v === "string" && SLIDE_ID_RE.test(v);
export const isSlideFile = (v: unknown): v is string => typeof v === "string" && SLIDE_FILE_RE.test(v);
export const isImageFile = (v: unknown): v is string => typeof v === "string" && IMAGE_FILE_RE.test(v);

export function newId(prefix: "c" | "s" | "j" | "v" | "sp" | "sc"): string {
  return prefix + Date.now().toString(36) + crypto.randomBytes(6).toString("hex");
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function carouselDir(id: string): string {
  if (!isCarouselId(id)) throw new CarouselError("Недопустимый id карусели", 400, "bad_id");
  const root = path.resolve(carouselsRoot());
  const dir = path.resolve(root, id);
  if (path.dirname(dir) !== root) throw new CarouselError("Недопустимый id карусели", 400, "bad_id");
  return dir;
}

const jsonFile = (id: string) => path.join(carouselDir(id), "carousel.json");
export const slidesDir = (id: string) => path.join(carouselDir(id), "slides");
export const imagesDir = (id: string) => path.join(carouselDir(id), "images");

export function slideFilePath(id: string, file: string): string {
  if (!isSlideFile(file)) throw new CarouselError("Недопустимое имя файла", 400, "bad_file");
  return path.join(slidesDir(id), file);
}

export function imageFilePath(id: string, file: string): string {
  if (!isImageFile(file)) throw new CarouselError("Недопустимое имя файла", 400, "bad_file");
  return path.join(imagesDir(id), file);
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Короткая межпроцессная блокировка файлом-меткой. Зависшая метка старше 15 с снимается. */
export function withFileLock<T>(target: string, fn: () => T, timeoutMs = 8000): T {
  const lock = `${target}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e: any) {
      if (e?.code === "ENOENT") throw notFound();
      if (e?.code !== "EEXIST" && e?.code !== "EPERM") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 15_000) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new CarouselError("Карусель занята другой операцией — повторите через пару секунд", 409, "locked");
      sleepSync(15 + Math.random() * 35);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lock, { force: true });
    } catch {}
  }
}

/** На Windows замену файла может ненадолго держать чужое чтение — несколько повторов. */
function renameWithRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e: any) {
      if (i >= 40 || !["EPERM", "EBUSY", "EACCES"].includes(e?.code)) throw e;
      sleepSync(25);
    }
  }
}

export function writeFileAtomic(file: string, data: string | Buffer, backup = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data);
  if (backup && fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {}
  }
  renameWithRetry(tmp, file);
}

export function emptyPublish(): PublishState {
  return { status: "idle", items: [], publishAttempts: 0, log: [] };
}

function normalizeImage(raw: any): SlideImage | undefined {
  if (!raw || typeof raw !== "object" || typeof raw.brief !== "string") return undefined;
  const versions = Array.isArray(raw.versions) ? raw.versions.filter((v: any) => v && typeof v.id === "string" && typeof v.file === "string") : [];
  return {
    brief: raw.brief,
    composition: typeof raw.composition === "string" ? raw.composition : "",
    textPlacement: raw.textPlacement === "top" ? "top" : "bottom",
    versions,
    currentId: typeof raw.currentId === "string" && versions.some((v: any) => v.id === raw.currentId) ? raw.currentId : undefined,
    rev: Number.isInteger(raw.rev) ? raw.rev : 0,
    status: ["none", "generating", "ready", "error", "uncertain"].includes(raw.status) ? raw.status : versions.length ? "ready" : "none",
    error: typeof raw.error === "string" ? raw.error : undefined,
    inFlight: raw.inFlight && typeof raw.inFlight === "object" && typeof raw.inFlight.spendId === "string" ? raw.inFlight : undefined,
    attempts: Number.isInteger(raw.attempts) ? raw.attempts : 0,
  };
}

function normalize(raw: any, id: string): Carousel | null {
  if (!raw || typeof raw !== "object" || raw.id !== id || !Array.isArray(raw.slides)) return null;
  const c = raw as Carousel;
  c.schema = c.schema === 2 ? 2 : 1;
  c.mode = c.mode === "illustrated" ? "illustrated" : "text_cards";
  c.story = Array.isArray(c.story) ? c.story : [];
  c.hashtags = Array.isArray(c.hashtags) ? c.hashtags : [];
  c.claimsToCheck = Array.isArray(c.claimsToCheck) ? c.claimsToCheck : [];
  c.footer = typeof c.footer === "string" ? c.footer : "";
  c.caption = typeof c.caption === "string" ? c.caption : "";
  c.publish = c.publish && typeof c.publish === "object" ? { ...emptyPublish(), ...c.publish } : emptyPublish();
  c.publish.items = Array.isArray(c.publish.items) ? c.publish.items : [];
  c.publish.log = Array.isArray(c.publish.log) ? c.publish.log : [];
  c.cost = c.cost && typeof c.cost === "object" ? { ...c.cost, usd: Number(c.cost.usd) || 0, calls: Number(c.cost.calls) || 0 } : { usd: 0, calls: 0 };
  c.job = c.job ?? null;
  if (c.schedule && (typeof c.schedule !== "object" || typeof c.schedule.id !== "string" || typeof c.schedule.runAt !== "string")) c.schedule = undefined;
  if (c.schedule) c.schedule.history = Array.isArray(c.schedule.history) ? c.schedule.history : [];
  if (c.anchor && (typeof c.anchor !== "object" || typeof c.anchor.file !== "string")) c.anchor = undefined;
  for (const s of c.slides) {
    s.kicker = s.kicker ?? "";
    s.body = s.body ?? "";
    s.cta = s.cta ?? "";
    s.bullets = Array.isArray(s.bullets) ? s.bullets : [];
    s.image = normalizeImage(s.image);
  }
  return c;
}

function readFile(id: string): Carousel | null {
  const file = jsonFile(id);
  if (!fs.existsSync(file)) return null;
  for (const f of [file, `${file}.bak`]) {
    try {
      const c = normalize(JSON.parse(fs.readFileSync(f, "utf8")), id);
      if (c) {
        if (f !== file) console.warn(`Карусель ${id}: carousel.json не читается — взята резервная копия`);
        return c;
      }
    } catch {}
  }
  return null;
}

export function getCarousel(id: string): Carousel | null {
  if (!isCarouselId(id)) return null;
  return readFile(id);
}

export function listCarousels(): Carousel[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(carouselsRoot());
  } catch {
    return [];
  }
  return names
    .filter(isCarouselId)
    .map((id) => readFile(id))
    .filter((c): c is Carousel => Boolean(c))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type CreateExtra = { mode: CarouselMode; design?: DesignSettings; imageModel?: ImageModelId; imageResolution?: string | null };

export function createCarousel(request: CarouselRequest, extra: CreateExtra = { mode: "text_cards" }): Carousel {
  const id = newId("c");
  const now = iso();
  const firstLine = request.idea.split("\n")[0].trim();
  const illustrated = extra.mode === "illustrated";
  const c: Carousel = {
    id,
    schema: 2,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    title: firstLine.length > CAROUSEL_LIMITS.titleMax ? `${firstLine.slice(0, CAROUSEL_LIMITS.titleMax - 1).trimEnd()}…` : firstLine,
    request,
    style: request.style,
    format: request.format,
    language: request.language,
    footer: "",
    story: [],
    slides: [],
    caption: "",
    hashtags: [],
    claimsToCheck: [],
    mode: extra.mode,
    imageModel: illustrated ? extra.imageModel : undefined,
    imageResolution: illustrated ? extra.imageResolution : undefined,
    design: illustrated ? extra.design : undefined,
    job: null,
    publish: emptyPublish(),
    cost: { usd: 0, calls: 0 },
  };
  fs.mkdirSync(carouselDir(id), { recursive: true });
  writeFileAtomic(jsonFile(id), JSON.stringify(c, null, 2));
  return c;
}

/** Изменение под блокировкой. content — правка содержимого: растёт ревизия. */
export function updateCarousel(id: string, mutate: (c: Carousel) => void, opts: { content?: boolean } = {}): Carousel {
  const file = jsonFile(id);
  if (!fs.existsSync(file)) throw notFound();
  return withFileLock(file, () => {
    const c = readFile(id);
    if (!c) throw notFound();
    mutate(c);
    c.updatedAt = iso();
    if (opts.content) c.revision += 1;
    writeFileAtomic(file, JSON.stringify(c, null, 2), true);
    return c;
  });
}

// ===== Задания =====

/** Задание без сердцебиения дольше этого считается прерванным (обработчик умер или сайт перезапущен). */
export const JOB_STALE_MS = 60_000;

export const isJobPending = (job: CarouselJob | null | undefined): boolean => job?.state === "queued" || job?.state === "running";

export function isJobLive(job: CarouselJob | null | undefined, now = Date.now()): boolean {
  if (!job) return false;
  if (job.state === "queued") return true;
  if (job.state !== "running") return false;
  const beat = Date.parse(job.heartbeatAt ?? job.startedAt ?? job.queuedAt);
  return Number.isFinite(beat) && now - beat < JOB_STALE_MS;
}

function pendingJobsCount(): number {
  return listCarousels().filter((c) => isJobPending(c.job)).length;
}

/** Ставит задание в карусель, уже открытую под блокировкой. Второе задание поверх идущего — отказ. */
export function attachJob(c: Carousel, type: JobType, params: JobParams = {}): CarouselJob {
  if (isJobPending(c.job)) {
    throw new CarouselError(`Уже выполняется: ${c.job!.step || "задание"}. Дождитесь окончания.`, 409, "busy");
  }
  if (pendingJobsCount() >= CAROUSEL_LIMITS.maxQueuedJobs) {
    throw new CarouselError("Очередь каруселей заполнена — повторите через несколько минут", 429, "queue_full");
  }
  const job: CarouselJob = { id: newId("j"), type, state: "queued", step: "В очереди", progress: 0, params, attempts: 0, queuedAt: iso() };
  c.job = job;
  return job;
}

export function findRunnableJob(now = Date.now()): { carouselId: string; jobId: string } | null {
  const candidates = listCarousels().filter((c) => c.job && (c.job.state === "queued" || (c.job.state === "running" && !isJobLive(c.job, now))));
  candidates.sort((a, b) => a.job!.queuedAt.localeCompare(b.job!.queuedAt));
  const c = candidates[0];
  return c ? { carouselId: c.id, jobId: c.job!.id } : null;
}

export function claimJob(carouselId: string, jobId: string, pid: number, now = Date.now()): { carousel: Carousel; resumed: boolean } | null {
  let resumed: boolean | null = null;
  try {
    const carousel = updateCarousel(carouselId, (c) => {
      const j = c.job;
      if (!j || j.id !== jobId) return;
      if (j.state === "queued" || (j.state === "running" && !isJobLive(j, now))) {
        resumed = j.state === "running";
        j.state = "running";
        j.attempts += 1;
        j.startedAt = j.startedAt ?? iso(now);
        j.heartbeatAt = iso(now);
        j.runnerPid = pid;
        j.error = undefined;
      }
    });
    return resumed === null ? null : { carousel, resumed };
  } catch (e) {
    if (e instanceof CarouselError && e.status === 404) return null;
    throw e;
  }
}

export function patchJob(carouselId: string, jobId: string, patch: Partial<Pick<CarouselJob, "step" | "progress" | "note" | "params">>): void {
  updateCarousel(carouselId, (c) => {
    if (!c.job || c.job.id !== jobId) return;
    Object.assign(c.job, patch);
    if (typeof patch.progress === "number") c.job.progress = Math.max(0, Math.min(100, Math.round(patch.progress)));
    c.job.heartbeatAt = iso();
  });
}

export function finishJob(carouselId: string, jobId: string, state: "done" | "error", info: { error?: string; note?: string } = {}): void {
  updateCarousel(carouselId, (c) => {
    if (!c.job || c.job.id !== jobId) return;
    c.job.state = state;
    c.job.progress = state === "done" ? 100 : c.job.progress;
    c.job.step = state === "done" ? "Готово" : "Ошибка";
    c.job.error = info.error;
    c.job.note = info.note;
    c.job.finishedAt = iso();
    c.job.heartbeatAt = iso();
  });
}

// ===== Удаление =====

export function deleteCarousel(id: string, now = Date.now()): void {
  const file = jsonFile(id);
  if (!fs.existsSync(file)) throw notFound();
  const trash = path.join(carouselsRoot(), `.deleted-${id}-${now}`);
  withFileLock(file, () => {
    const c = readFile(id);
    if (!c) throw notFound();
    if (isJobLive(c.job, now)) throw new CarouselError("Идёт задание — удалить карусель можно после его окончания", 409, "busy");
    const p = c.publish;
    if (p.status === "queued" || p.status === "running" || p.status === "uncertain" || p.stage === "publish_sent" || p.stage === "verifying") {
      throw new CarouselError("Публикация не завершена или её результат не подтверждён — сначала проверьте статус публикации", 409, "publishing");
    }
    const sc = c.schedule?.status;
    if (sc === "queued" || sc === "publishing" || sc === "uncertain") {
      throw new CarouselError("Запланированная публикация выполняется или не подтверждена — дождитесь итога", 409, "publishing");
    }
    // переименование убирает карусель из списка одним действием; файлы стираются уже вне блокировки
    renameWithRetry(carouselDir(id), trash);
  });
  fs.rmSync(trash, { recursive: true, force: true });
}

/** Удаляет готовые карточки, на которые не ссылаются ни слайды, ни публикация, ни расписание. Версии иллюстраций хранятся все. */
export function cleanupSlideFiles(id: string): number {
  const c = getCarousel(id);
  if (!c) return 0;
  const keep = new Set<string>();
  for (const s of c.slides) if (s.render?.file) keep.add(s.render.file);
  for (const item of c.publish.items) keep.add(item.file);
  for (const item of c.schedule?.snapshot?.items ?? []) keep.add(item.file);
  let removed = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(slidesDir(id));
  } catch {
    return 0;
  }
  for (const name of names) {
    const full = path.join(slidesDir(id), name);
    const stale = name.endsWith(".tmp") && Date.now() - fs.statSync(full).mtimeMs > 3600_000;
    if ((isSlideFile(name) && !keep.has(name)) || stale) {
      try {
        fs.rmSync(full, { force: true });
        removed++;
      } catch {}
    }
  }
  return removed;
}

// ===== Фоновый обработчик: один на весь раздел =====

type RunnerLock = { pid: number; startedAt: string; heartbeatAt: number };
export const RUNNER_STALE_MS = 20_000;
const runnerLockFile = () => path.join(carouselsRoot(), ".runner.json");

export function readRunnerLock(): RunnerLock | null {
  try {
    const j = JSON.parse(fs.readFileSync(runnerLockFile(), "utf8"));
    return typeof j?.pid === "number" && typeof j?.heartbeatAt === "number" ? j : null;
  } catch {
    return null;
  }
}

export function acquireRunnerLock(pid: number, now = Date.now()): boolean {
  fs.mkdirSync(carouselsRoot(), { recursive: true });
  return withFileLock(runnerLockFile(), () => {
    const cur = readRunnerLock();
    if (cur && cur.pid !== pid && now - cur.heartbeatAt < RUNNER_STALE_MS) return false;
    writeFileAtomic(runnerLockFile(), JSON.stringify({ pid, startedAt: iso(now), heartbeatAt: now }));
    return true;
  });
}

export function touchRunnerLock(pid: number, now = Date.now()): boolean {
  return withFileLock(runnerLockFile(), () => {
    const cur = readRunnerLock();
    if (!cur || cur.pid !== pid) return false;
    writeFileAtomic(runnerLockFile(), JSON.stringify({ ...cur, heartbeatAt: now }));
    return true;
  });
}

export function releaseRunnerLock(pid: number): void {
  try {
    withFileLock(runnerLockFile(), () => {
      if (readRunnerLock()?.pid === pid) fs.rmSync(runnerLockFile(), { force: true });
    });
  } catch {}
}

// ===== Подписанные ссылки на слайды для Instagram =====

export const MEDIA_URL_TTL_SEC = 6 * 3600;

function mediaSecret(): Buffer {
  const file = path.join(carouselsRoot(), ".media-secret");
  const read = () => {
    const s = fs.readFileSync(file, "utf8").trim();
    return /^[a-f0-9]{64}$/.test(s) ? Buffer.from(s, "hex") : null;
  };
  try {
    const s = read();
    if (s) return s;
  } catch {}
  fs.mkdirSync(carouselsRoot(), { recursive: true });
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch {}
  const s = read();
  if (!s) throw new Error("Не удалось создать секрет подписи ссылок каруселей");
  return s;
}

function sign(id: string, file: string, exp: number): string {
  return crypto.createHmac("sha256", mediaSecret()).update(`${id}/${file}/${exp}`).digest("hex");
}

export function mediaQuery(id: string, file: string, nowSec = Math.floor(Date.now() / 1000), ttlSec = MEDIA_URL_TTL_SEC): string {
  const exp = nowSec + ttlSec;
  return `exp=${exp}&sig=${sign(id, file, exp)}`;
}

export function verifyMedia(id: string, file: string, exp: string | null, sig: string | null, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!isCarouselId(id) || !isSlideFile(file) || !exp || !sig || !/^\d{9,12}$/.test(exp) || !/^[a-f0-9]{64}$/.test(sig)) return false;
  const e = Number(exp);
  if (e <= nowSec || e - nowSec > 7 * 86400) return false;
  const expected = Buffer.from(sign(id, file, e), "hex");
  const given = Buffer.from(sig, "hex");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
