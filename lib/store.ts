import fs from "fs";
import path from "path";
import type { StoryResearchPack } from "./storyResearch";
import type { ScriptBeat } from "./ai";

export type Platform = "tiktok" | "youtube" | "instagram";

export type ProcessingState = {
  state: "idle" | "running" | "done" | "error";
  step: string;
  progress: number; // 0..100
  error?: string;
  at?: string; // время последнего обновления — для обнаружения зависших задач
};

export type Publication = {
  platform: Platform;
  status: "demo" | "published" | "error";
  url?: string;
  message?: string;
  at: string;
};

/**
 * ok — обложка прошла QC;
 * failed — единственная генерация не прошла QC (авто-повторов нет);
 * headline_failed — заголовок не прошёл semantic preflight, картинка НЕ заказывалась (денег не потрачено).
 */
export type CoverStatus = "ok" | "failed" | "headline_failed";

export type ProjectMeta = {
  title: string;
  description: string;
  hashtags: string[];
};

export type Project = {
  id: string;
  topic: string;
  createdAt: string;
  script: string | null;
  scriptDemo?: boolean;
  rawVideo: string | null; // имя файла в data/uploads/{id}/
  processedVideo: string | null;
  processing: ProcessingState;
  subtitlesSource?: "scribe" | "whisper" | "script";
  cover?: string | null; // cover.jpg — Full-AI обложка, прошедшая QC (иначе null)
  coverStatus?: CoverStatus; // failed — генерация не прошла QC, нужна ручная перегенерация
  coverOffsetSec?: number; // устарело: кадр из видео больше не используется как обложка
  brollCount?: number; // сколько б-ролл перебивок вошло в монтаж
  meta: ProjectMeta | null;
  publications: Publication[];
  /** исследование истории: источники, участники, факты. Живёт весь цикл проекта. */
  research?: StoryResearchPack;
  /** ссылка на новость, если пользователь дал её сам */
  sourceUrl?: string;
  scriptBeats?: ScriptBeat[];
};

export type YoutubeTokens = { access_token: string; refresh_token?: string; expires_at?: number };
export type TiktokTokens = { access_token: string; refresh_token?: string; expires_at?: number; open_id?: string };
export type InstagramTokens = { access_token: string; ig_user_id?: string; via?: "ig" | "fb"; expires_at?: number };
export type PlatformTokens = YoutubeTokens | TiktokTokens | InstagramTokens;

/** Сохранённый аккаунт платформы. id — стабильный ключ, чтобы повторный вход обновлял, а не плодил. */
export type SavedAccount = {
  id: string;
  label: string;
  at: string;
  tokens: PlatformTokens;
};

export type Settings = {
  anthropicKey?: string;
  openaiKey?: string;
  elevenLabsKey?: string;
  pexelsKey?: string;
  pixabayKey?: string;
  runwayKey?: string;
  openrouterKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  tiktokClientKey?: string;
  tiktokClientSecret?: string;
  metaAppId?: string;
  metaAppSecret?: string;
  metaConfigId?: string;
  igAppId?: string;
  igAppSecret?: string;
  publicBaseUrl?: string;
  // OAuth-токены АКТИВНОГО аккаунта платформы (именно их читает публикация)
  youtubeTokens?: YoutubeTokens;
  tiktokTokens?: TiktokTokens;
  instagramTokens?: InstagramTokens;
  // Все когда-либо подключённые аккаунты: подключение нового больше не стирает предыдущий
  savedAccounts?: Partial<Record<Platform, SavedAccount[]>>;
  activeAccounts?: Partial<Record<Platform, string>>;
};

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const MUSIC_FILE = path.join(DATA_DIR, "music.mp3");
export const FACE_FILE = path.join(DATA_DIR, "face.jpg");

export function hasMusic(): boolean {
  try {
    return fs.statSync(MUSIC_FILE).size > 0;
  } catch {
    return false;
  }
}

export function hasFace(): boolean {
  try {
    return fs.statSync(FACE_FILE).size > 0;
  } catch {
    return false;
  }
}

/** Пользовательский шрифт заголовков обложек (Settings → Cover Font). */
export function coverFontFile(): string | null {
  for (const name of ["coverfont.ttf", "coverfont.otf"]) {
    const p = path.join(DATA_DIR, name);
    try {
      if (fs.statSync(p).size > 0) return p;
    } catch {}
  }
  return null;
}

function ensureDirs() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/** Формат id проекта: только буквы и цифры — никаких «..» и разделителей пути. */
const ID_RE = /^[a-z0-9_-]{1,64}$/i;
export function isProjectId(id: string): boolean {
  return ID_RE.test(id);
}

export function projectDir(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Недопустимый id проекта: ${JSON.stringify(id).slice(0, 80)}`);
  const dir = path.join(UPLOADS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

type Db = { projects: Project[] };

const DB_BACKUP = DB_FILE + ".bak";

function parseDb(file: string): Db {
  const db = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!db || !Array.isArray(db.projects)) throw new Error("нет списка проектов");
  return db;
}

function readDb(): Db {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) return { projects: [] };
  try {
    return parseDb(DB_FILE);
  } catch (e: any) {
    // Битый db.json раньше читался как пустой, и следующая же запись стирала все
    // проекты. Теперь на место битого файла встаёт резервная копия, а без неё
    // запись запрещена — файл остаётся для ручного восстановления.
    const why = String(e?.message ?? e).slice(0, 120);
    try {
      const db = parseDb(DB_BACKUP);
      fs.copyFileSync(DB_FILE, DB_FILE + ".corrupt");
      fs.copyFileSync(DB_BACKUP, DB_FILE);
      console.warn(`db.json повреждён (${why}) — восстановлен из db.json.bak, битая копия в db.json.corrupt`);
      return db;
    } catch {}
    throw new Error(`db.json повреждён: ${why}. Файл не перезаписывается — восстановите его вручную`);
  }
}

function writeDb(db: Db) {
  ensureDirs();
  // атомарно: во временный файл и переименование; прежняя версия остаётся в db.json.bak
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_BACKUP);
  fs.renameSync(tmp, DB_FILE);
}

export function listProjects(): Project[] {
  return readDb().projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getProject(id: string): Project | null {
  return readDb().projects.find((p) => p.id === id) ?? null;
}

export function createProject(topic: string): Project {
  const db = readDb();
  const project: Project = {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    topic,
    createdAt: new Date().toISOString(),
    script: null,
    rawVideo: null,
    processedVideo: null,
    processing: { state: "idle", step: "", progress: 0 },
    meta: null,
    publications: [],
  };
  db.projects.push(project);
  writeDb(db);
  return project;
}

export function updateProject(id: string, patch: Partial<Project>): Project | null {
  const db = readDb();
  const idx = db.projects.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  if (patch.processing) patch.processing = { ...patch.processing, at: new Date().toISOString() };
  db.projects[idx] = { ...db.projects[idx], ...patch };
  writeDb(db);
  return db.projects[idx];
}

/** Вставка/замена проекта целиком (используется воркером монтажа). */
export function upsertProject(project: Project) {
  const db = readDb();
  db.projects = db.projects.filter((p) => p.id !== project.id);
  db.projects.push(project);
  writeDb(db);
}

export function deleteProject(id: string): boolean {
  // id проверяется по формату, и папка удаляется только у существующего проекта:
  // раньше любой id вроде «../..» уходил в rmSync без проверки — на открытом сайте
  // один запрос мог снести всю папку данных.
  if (!ID_RE.test(id)) return false;
  const db = readDb();
  const before = db.projects.length;
  db.projects = db.projects.filter((p) => p.id !== id);
  if (db.projects.length === before) return false;
  writeDb(db);
  const dir = path.resolve(UPLOADS_DIR, id);
  if (dir.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  return true;
}

/** Приводит URL к виду https://домен (без завершающего слэша). */
function normalizeUrl(url?: string): string | undefined {
  if (!url || !url.trim()) return undefined;
  let u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

/** Сохранённая пустая строка = поле очищено намеренно: fallback на env не подставляем. */
function pick(saved: string | undefined, env: string | undefined): string | undefined {
  return saved === "" ? undefined : saved || env || undefined;
}

/** Настройки: значения из settings.json поверх переменных окружения. */
export function getSettings(): Settings {
  let saved: Settings = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {}
  return {
    anthropicKey: pick(saved.anthropicKey, process.env.ANTHROPIC_API_KEY),
    openaiKey: pick(saved.openaiKey, process.env.OPENAI_API_KEY),
    elevenLabsKey: pick(saved.elevenLabsKey, process.env.ELEVENLABS_API_KEY),
    pexelsKey: pick(saved.pexelsKey, process.env.PEXELS_API_KEY),
    pixabayKey: pick(saved.pixabayKey, process.env.PIXABAY_API_KEY),
    runwayKey: pick(saved.runwayKey, process.env.RUNWAY_API_KEY),
    openrouterKey: pick(saved.openrouterKey, process.env.OPENROUTER || process.env.OPENROUTER_API_KEY),
    googleClientId: pick(saved.googleClientId, process.env.GOOGLE_CLIENT_ID),
    googleClientSecret: pick(saved.googleClientSecret, process.env.GOOGLE_CLIENT_SECRET),
    tiktokClientKey: pick(saved.tiktokClientKey, process.env.TIKTOK_CLIENT_KEY),
    tiktokClientSecret: pick(saved.tiktokClientSecret, process.env.TIKTOK_CLIENT_SECRET),
    metaAppId: pick(saved.metaAppId, process.env.META_APP_ID),
    metaAppSecret: pick(saved.metaAppSecret, process.env.META_APP_SECRET),
    metaConfigId: pick(saved.metaConfigId, process.env.META_CONFIG_ID),
    igAppId: pick(saved.igAppId, process.env.IG_APP_ID),
    igAppSecret: pick(saved.igAppSecret, process.env.IG_APP_SECRET),
    publicBaseUrl: normalizeUrl(pick(saved.publicBaseUrl, process.env.PUBLIC_BASE_URL)),
    youtubeTokens: saved.youtubeTokens,
    tiktokTokens: saved.tiktokTokens,
    instagramTokens: saved.instagramTokens,
    savedAccounts: saved.savedAccounts,
    activeAccounts: saved.activeAccounts,
  };
}

export function saveSettings(patch: Partial<Settings>) {
  ensureDirs();
  let saved: Settings = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {}
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...saved, ...patch }, null, 2), "utf8");
}

// ===== Аккаунты платформ =====
// Активный аккаунт лежит в <platform>Tokens — публикация читает только его.
// savedAccounts хранит все подключённые, чтобы можно было переключаться без переподключения.

const TOKENS_KEY: Record<Platform, "youtubeTokens" | "tiktokTokens" | "instagramTokens"> = {
  youtube: "youtubeTokens",
  tiktok: "tiktokTokens",
  instagram: "instagramTokens",
};

function readSaved(): Settings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Подключение аккаунта: сохраняет его в список и делает активным.
 * Повторный вход тем же аккаунтом обновляет токены, а не создаёт дубль.
 */
export function connectAccount(platform: Platform, id: string, label: string, tokens: PlatformTokens) {
  const saved = readSaved();
  const list = (saved.savedAccounts?.[platform] ?? []).filter((a) => a.id !== id);
  list.push({ id, label, at: new Date().toISOString(), tokens });
  saveSettings({
    [TOKENS_KEY[platform]]: tokens,
    savedAccounts: { ...saved.savedAccounts, [platform]: list },
    activeAccounts: { ...saved.activeAccounts, [platform]: id },
  } as Partial<Settings>);
}

/** Переключение на ранее подключённый аккаунт — без повторного OAuth. */
export function activateAccount(platform: Platform, id: string): boolean {
  const saved = readSaved();
  const account = saved.savedAccounts?.[platform]?.find((a) => a.id === id);
  if (!account) return false;
  saveSettings({
    [TOKENS_KEY[platform]]: account.tokens,
    activeAccounts: { ...saved.activeAccounts, [platform]: id },
  } as Partial<Settings>);
  return true;
}

/** Удаление аккаунта. Если он был активным — платформа остаётся неподключённой. */
export function removeAccount(platform: Platform, id: string) {
  const saved = readSaved();
  const list = (saved.savedAccounts?.[platform] ?? []).filter((a) => a.id !== id);
  const patch: Partial<Settings> = {
    savedAccounts: { ...saved.savedAccounts, [platform]: list },
  };
  if (saved.activeAccounts?.[platform] === id) {
    patch[TOKENS_KEY[platform]] = undefined;
    patch.activeAccounts = { ...saved.activeAccounts, [platform]: undefined };
  }
  saveSettings(patch);
}

/** Обновление токенов активного аккаунта (например, после refresh) — синхронно в списке. */
export function updateActiveTokens(platform: Platform, tokens: PlatformTokens) {
  const saved = readSaved();
  const activeId = saved.activeAccounts?.[platform];
  const patch: Partial<Settings> = { [TOKENS_KEY[platform]]: tokens } as Partial<Settings>;
  if (activeId) {
    patch.savedAccounts = {
      ...saved.savedAccounts,
      [platform]: (saved.savedAccounts?.[platform] ?? []).map((a) => (a.id === activeId ? { ...a, tokens } : a)),
    };
  }
  saveSettings(patch);
}

/**
 * Аккаунт, подключённый до появления списка, переносим в него при первом обращении.
 * Иначе следующее подключение затрёт его молча — ровно та проблема, ради которой список и заводился.
 */
function migrateLegacyAccount(platform: Platform) {
  const saved = readSaved();
  const tokens = saved[TOKENS_KEY[platform]];
  if (!tokens) return;
  if ((saved.savedAccounts?.[platform] ?? []).length > 0) return;
  const id = `legacy-${platform}`;
  saveSettings({
    savedAccounts: {
      ...saved.savedAccounts,
      [platform]: [{ id, label: "Подключён ранее", at: new Date().toISOString(), tokens }],
    },
    activeAccounts: { ...saved.activeAccounts, [platform]: id },
  });
}

/** Список аккаунтов платформы для UI. */
export function listAccounts(platform: Platform): Array<{ id: string; label: string; at: string; active: boolean }> {
  migrateLegacyAccount(platform);
  const saved = readSaved();
  const activeId = saved.activeAccounts?.[platform];
  return (saved.savedAccounts?.[platform] ?? []).map((a) => ({
    id: a.id,
    label: a.label,
    at: a.at,
    active: a.id === activeId,
  }));
}
