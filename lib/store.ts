import fs from "fs";
import path from "path";

export type Platform = "tiktok" | "youtube" | "instagram";

export type ProcessingState = {
  state: "idle" | "running" | "done" | "error";
  step: string;
  progress: number; // 0..100
  error?: string;
};

export type Publication = {
  platform: Platform;
  status: "demo" | "published" | "error";
  url?: string;
  message?: string;
  at: string;
};

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
  subtitlesSource?: "whisper" | "script";
  meta: ProjectMeta | null;
  publications: Publication[];
};

export type Settings = {
  anthropicKey?: string;
  openaiKey?: string;
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
  db.projects[idx] = { ...db.projects[idx], ...patch };
  writeDb(db);
  return db.projects[idx];
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

/** Настройки: значения из settings.json поверх переменных окружения. */
export function getSettings(): Settings {
  let saved: Settings = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {}
  return {
    anthropicKey: saved.anthropicKey || process.env.ANTHROPIC_API_KEY || undefined,
    openaiKey: saved.openaiKey || process.env.OPENAI_API_KEY || undefined,
    googleClientId: saved.googleClientId || process.env.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: saved.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || undefined,
    tiktokClientKey: saved.tiktokClientKey || process.env.TIKTOK_CLIENT_KEY || undefined,
    tiktokClientSecret: saved.tiktokClientSecret || process.env.TIKTOK_CLIENT_SECRET || undefined,
    metaAppId: saved.metaAppId || process.env.META_APP_ID || undefined,
    metaAppSecret: saved.metaAppSecret || process.env.META_APP_SECRET || undefined,
    metaConfigId: saved.metaConfigId || process.env.META_CONFIG_ID || undefined,
    igAppId: saved.igAppId || process.env.IG_APP_ID || undefined,
    igAppSecret: saved.igAppSecret || process.env.IG_APP_SECRET || undefined,
    publicBaseUrl: normalizeUrl(saved.publicBaseUrl || process.env.PUBLIC_BASE_URL),
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
