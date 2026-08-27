import fs from "fs";
import path from "path";

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

/** ok — обложка прошла QC; failed — единственная генерация не прошла QC (авто-повторов нет). */
export type CoverStatus = "ok" | "failed";

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
  // OAuth-токены подключённых аккаунтов
  youtubeTokens?: { access_token: string; refresh_token?: string; expires_at?: number };
  tiktokTokens?: { access_token: string; refresh_token?: string; expires_at?: number; open_id?: string };
  instagramTokens?: { access_token: string; ig_user_id?: string; via?: "ig" | "fb" };
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

export function projectDir(id: string): string {
  const dir = path.join(UPLOADS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

type Db = { projects: Project[] };

function readDb(): Db {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return { projects: [] };
  }
}

function writeDb(db: Db) {
  ensureDirs();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
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
  const db = readDb();
  const before = db.projects.length;
  db.projects = db.projects.filter((p) => p.id !== id);
  writeDb(db);
  const dir = path.join(UPLOADS_DIR, id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  return db.projects.length < before;
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
