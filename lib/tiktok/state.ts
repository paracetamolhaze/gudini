import fs from "node:fs";
import path from "node:path";

export const TIKTOK_DIR = path.join(process.cwd(), "data", "tiktok-browser");
export type JobStatus = "queued" | "running" | "needs_login" | "unknown" | "published" | "error" | "cancelled";
export type TikTokJob = {
  id: string; key: string; projectId: string; account: string;
  caption: string; video: string; cover?: string; scheduledAt: string;
  status: JobStatus; message: string; at: string; submitted?: boolean; url?: string;
};
export type TikTokState = {
  account?: string; connected: boolean; autoPublish: boolean;
  seen: string[]; jobs: TikTokJob[];
};
export function readTikTokState(): TikTokState {
  const file = path.join(TIKTOK_DIR, "state.json");
  if (!fs.existsSync(file)) return { connected: false, autoPublish: false, seen: [], jobs: [] };
  // Corrupt state must never become an empty queue: that could repeat a public post.
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export function writeTikTokState(state: TikTokState): void {
  fs.mkdirSync(TIKTOK_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(TIKTOK_DIR, "state.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
export const browserTikTokEnabled = () => process.env.TIKTOK_TRANSPORT === "browser";

/** Read-only overlay; the browser worker never writes the site's project database. */
export function browserPublication(projectId: string) {
  if (!browserTikTokEnabled()) return null;
  const job = readTikTokState().jobs.filter(j => j.projectId === projectId).at(-1);
  if (!job) return null;
  return { platform: "tiktok" as const, status: job.status, message: job.message, url: job.url, at: job.at };
}

export function recoverJobs(state: TikTokState): void {
  for (const job of state.jobs) if (job.status === "running") {
    job.status = job.submitted ? "unknown" : "queued";
    job.message = job.submitted
      ? "Связь прервалась после отправки. Проверьте TikTok перед повтором."
      : "Продолжим после перезапуска обработчика.";
  }
}
