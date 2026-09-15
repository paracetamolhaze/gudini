import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { getProject, listProjects, projectDir } from "../lib/store";
import { TIKTOK_DIR, readTikTokState, writeTikTokState, recoverJobs, type TikTokJob } from "../lib/tiktok/state";
import { LoginRequired, needsLogin, openTikTokBrowser, preparePost, submitPost, uploadControl, UPLOAD_URL } from "../lib/tiktok/browser";
import { observeLogin, LOGIN_BACKOFF_MS, LOGIN_RATE_LIMIT_MESSAGE, type LoginSignal } from "../lib/tiktok/loginDiagnostics";

const state = readTikTokState();
const persist = () => writeTikTokState(state);
let context: BrowserContext | undefined;
let page: Page | undefined;
let busy = false;
let login = false;
let loginUntil = 0;
let lastError = "";
let commandBusy = false;
const loginSignals: LoginSignal[] = [];
const hash = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const token = process.env.TIKTOK_BROWSER_TOKEN || "";
const host = process.env.TIKTOK_BROWSER_HOST || "127.0.0.1";
if (host !== "127.0.0.1" && !token) throw new Error("TIKTOK_BROWSER_TOKEN обязателен для сетевого обработчика.");

async function browserPage() {
  if (!context) {
    context = await openTikTokBrowser();
    context.on("close", () => { context = undefined; page = undefined; });
  }
  if (!page || page.isClosed()) {
    page = await context.newPage();
    observeLogin(page, signal => {
      loginSignals.push(signal); if (loginSignals.length > 20) loginSignals.shift();
      if (signal.rateLimited && login) {
        login = false;
        state.loginRetryAfter = new Date(Date.now() + LOGIN_BACKOFF_MS).toISOString();
        state.loginIssue = LOGIN_RATE_LIMIT_MESSAGE;
        persist();
      }
    });
  }
  page.setDefaultTimeout(15_000);
  return page;
}
async function identity(): Promise<string | undefined> {
  const cookies = await context!.cookies("https://www.tiktok.com");
  const uid = cookies.find(c => c.name === "uid_tt" || c.name === "uid_tt_ss")?.value;
  const session = cookies.find(c => c.name === "sessionid" || c.name === "sessionid_ss")?.value;
  return uid && session ? hash(uid) : undefined;
}
function sourceFor(projectId: string, style?: string) {
  const project = getProject(projectId);
  if (!project) throw new Error("Проект не найден");
  if (style !== undefined && style !== "cards" && style !== "ai_film") throw new Error("Неизвестная версия ролика");
  const video = style ? project.outputs?.[style]?.file : project.processedVideo;
  if (!video) throw new Error("Сначала смонтируйте выбранную версию видео");
  const dir = projectDir(projectId);
  const safe = (name: string) => {
    if (path.basename(name) !== name) throw new Error("Некорректное имя файла");
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) throw new Error("Файл ролика отсутствует");
    return file;
  };
  return { project, video: safe(video), cover: project.cover ? safe(project.cover) : undefined };
}
function sourceStamp(projectId: string): string | null {
  try {
    const { video } = sourceFor(projectId);
    const stat = fs.statSync(video);
    return `${projectId}:${path.basename(video)}:${stat.size}:${stat.mtimeMs}`;
  } catch { return null; }
}
function enqueue(body: { projectId: string; style?: string; scheduledAt?: string }) {
  if (!state.connected || !state.account) throw new Error("Сначала подключите TikTok в настройках.");
  const { project, video, cover } = sourceFor(body.projectId, body.style);
  const caption = [project.meta?.title ?? project.topic, project.meta?.description, project.meta?.hashtags?.join(" ")].filter(Boolean).join("\n\n");
  if (caption.length > 2200) throw new Error("Описание TikTok длиннее 2200 символов. Сократите его перед публикацией.");
  const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : new Date();
  if (!Number.isFinite(scheduledAt.getTime())) throw new Error("Неверная дата публикации");
  const videoBytes = fs.readFileSync(video);
  const key = hash(`${state.account}:${hash(videoBytes)}`);
  // Same account + same video must not be posted twice, even after an ambiguous response.
  const existing = state.jobs.find(j => j.key === key && !["cancelled", "error"].includes(j.status));
  if (existing) return existing;
  const id = crypto.randomUUID();
  const dir = path.join(TIKTOK_DIR, "jobs", id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "video.mp4"), videoBytes, { mode: 0o600 });
  if (cover) fs.copyFileSync(cover, path.join(dir, "cover" + path.extname(cover)));
  const job: TikTokJob = {
    id, key, projectId: project.id, account: state.account, caption,
    video: path.join(dir, "video.mp4"), cover: cover ? path.join(dir, "cover" + path.extname(cover)) : undefined,
    scheduledAt: scheduledAt.toISOString(), status: "queued", at: new Date().toISOString(),
    message: "В очереди фоновой публикации TikTok.",
  };
  state.jobs.push(job); persist(); return job;
}

async function run(job: TikTokJob) {
  busy = true;
  job.status = "running"; job.message = "Загружаем видео, описание и обложку в TikTok."; persist();
  try {
    const p = await browserPage();
    await p.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await uploadControl(p);
    if (await identity() !== job.account) throw new LoginRequired("Сессия истекла или открыт другой аккаунт. Войдите в исходный аккаунт.");
    await preparePost(p, job);
    job.submitted = true; job.message = "TikTok принимает публикацию."; persist();
    job.url = await submitPost(p);
    job.status = "published";
    job.message = job.url ? "Опубликовано в TikTok." : "TikTok подтвердил публикацию. Прямая ссылка пока недоступна; проверьте TikTok Studio.";
  } catch (error) {
    if (job.submitted) {
      job.status = "unknown";
      job.message = "Отправка началась, но подтверждение не получено. Проверьте TikTok; автоматического повтора не будет.";
    } else if (error instanceof LoginRequired || (page && await needsLogin(page).catch(() => false))) {
      state.connected = false; job.status = "needs_login"; job.message = "TikTok требует вход или проверку. Откройте подключение в настройках.";
    } else {
      job.status = "error"; job.message = `Публикация остановлена до отправки: ${error instanceof Error ? error.message : "ошибка браузера"}`;
    }
  } finally {
    job.at = new Date().toISOString(); persist();
    await context?.close().catch(() => {});
    busy = false;
  }
}

function status() {
  const retryMinutes = Math.max(0, Math.ceil((Date.parse(state.loginRetryAfter ?? "") - Date.now()) / 60_000)) || 0;
  return {
    connected: state.connected, account: state.account ? "TikTok" : null,
    autoPublish: state.autoPublish, login, busy,
    error: lastError || (state.loginIssue ? state.loginIssue + (retryMinutes ? ` Пауза в проекте: ещё ${retryMinutes} мин.` : "") : ""), loginSignals,
    loginRetryAfter: state.loginRetryAfter,
    jobs: state.jobs.filter((job, index) => ["queued", "running", "needs_login", "unknown"].includes(job.status) || index >= state.jobs.length - 30)
      .reverse().map(({ video, cover, key, account, ...job }) => job),
  };
}
async function command(action: string, body: any) {
  if (action === "status") return status();
  if (action === "enqueue") return { job: enqueue(body) };
  if (action === "settings") {
    if (typeof body.autoPublish !== "boolean") throw new Error("Нужен autoPublish");
    if (body.autoPublish && !state.connected) throw new Error("Сначала подключите TikTok.");
    if (body.autoPublish && !state.autoPublish) state.seen = listProjects().map(p => sourceStamp(p.id)).filter((v): v is string => Boolean(v));
    state.autoPublish = body.autoPublish; persist(); return status();
  }
  if (action === "cancel" || action === "resolve") {
    const job = state.jobs.find(j => j.id === body.id);
    if (!job) throw new Error("Задача не найдена");
    if (action === "cancel") {
      if (!["queued", "needs_login"].includes(job.status)) throw new Error("Эту задачу уже нельзя отменить");
      job.status = "cancelled"; job.message = "Публикация отменена.";
    } else {
      if (job.status !== "unknown" || !["published", "error"].includes(body.result)) throw new Error("Нужен результат ручной проверки TikTok");
      job.status = body.result; job.message = body.result === "published" ? "Публикация подтверждена владельцем." : "Владелец проверил: видео не опубликовано. Можно поставить в очередь снова.";
    }
    persist(); return status();
  }
  if (busy) throw new Error("Сейчас идёт публикация. Дождитесь её завершения.");
  if (action === "login") {
    if (Date.parse(state.loginRetryAfter ?? "") > Date.now()) throw new Error(LOGIN_RATE_LIMIT_MESSAGE);
    state.loginIssue = undefined; state.loginRetryAfter = undefined; loginSignals.length = 0; persist();
    login = true; loginUntil = Date.now() + 15 * 60_000;
    try {
      const p = await browserPage(); await p.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      // Studio redirects after DOMContentLoaded; do not inspect the URL too early.
      const qr = p.getByText("Use QR code", { exact: true });
      await qr.click({ timeout: 15_000 }).catch(() => {});
    }
    catch (e) { login = false; await context?.close(); throw e; }
    return status();
  }
  if (action === "disconnect") {
    if (state.jobs.some(j => ["queued", "needs_login"].includes(j.status))) throw new Error("Сначала отмените ожидающие публикации.");
    state.connected = false; state.autoPublish = false; state.account = undefined; login = false;
    await context?.close();
    // Exact fixed child of private storage; never remove an arbitrary caller-supplied path.
    const profile = path.resolve(TIKTOK_DIR, "profile");
    if (path.dirname(profile) !== path.resolve(TIKTOK_DIR)) throw new Error("Invalid profile path");
    fs.rmSync(profile, { recursive: true, force: true });
    persist(); return status();
  }
  if (!login) throw new Error("Сначала откройте подключение TikTok.");
  const p = await browserPage();
  if (action === "frame") return { image: (await p.screenshot({ type: "jpeg", quality: 75 })).toString("base64") };
  if (action === "input") {
    loginUntil = Date.now() + 15 * 60_000;
    if (body.type === "click" && Number.isFinite(body.x) && Number.isFinite(body.y) && body.x >= 0 && body.x <= 1280 && body.y >= 0 && body.y <= 900) await p.mouse.click(body.x, body.y);
    else if (body.type === "drag" && [body.x, body.y, body.toX, body.toY].every(Number.isFinite) && [body.x, body.toX].every(v => v >= 0 && v <= 1280) && [body.y, body.toY].every(v => v >= 0 && v <= 900)) {
      await p.mouse.move(body.x, body.y); await p.mouse.down();
      try { await p.mouse.move(body.toX, body.toY, { steps: 25 }); } finally { await p.mouse.up(); }
    }
    else if (body.type === "text" && typeof body.text === "string" && body.text.length <= 1000) await p.keyboard.insertText(body.text);
    else if (body.type === "key" && ["Tab", "Enter", "Backspace", "Escape", "ControlOrMeta+A", "ArrowDown", "ArrowUp"].includes(body.key)) await p.keyboard.press(body.key);
    else if (body.type === "scroll" && Number.isFinite(body.dy)) await p.mouse.wheel(0, Math.max(-800, Math.min(800, body.dy)));
    else throw new Error("Неизвестное действие окна входа");
    return { ok: true };
  }
  if (action === "finish") {
    await p.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await uploadControl(p);
    const account = await identity();
    if (!account) throw new Error("Вход ещё не завершён. Войдите в TikTok и повторите проверку.");
    const waiting = state.jobs.filter(j => ["queued", "needs_login"].includes(j.status));
    if (waiting.some(j => j.account !== account)) throw new Error("В очереди ролики для другого аккаунта. Войдите в исходный аккаунт или отмените их.");
    state.account = account; state.connected = true;
    for (const job of waiting) if (job.status === "needs_login") { job.status = "queued"; job.message = "Вход восстановлен, продолжаем публикацию."; }
    persist(); login = false; await context?.close(); return status();
  }
  if (action === "close") { login = false; await context?.close(); return status(); }
  throw new Error("Неизвестная команда");
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
  const respond = (code: number, data: unknown) => { res.statusCode = code; res.end(JSON.stringify(data)); };
  if (token && req.headers.authorization !== `Bearer ${token}`) return respond(401, { error: "Unauthorized" });
  const action = (req.url || "").slice(1);
  if (!/^[a-z]+$/.test(action)) return respond(404, { error: "Not found" });
  if (req.method !== "POST" && !(req.method === "GET" && ["status", "frame"].includes(action))) return respond(405, { error: "Method not allowed" });
  if (commandBusy) return respond(409, { error: "Действие TikTok ещё выполняется." });
  commandBusy = true;
  try {
    let data = "";
    for await (const chunk of req) {
      data += chunk;
      if (data.length > 16_384) throw new Error("Запрос слишком большой");
    }
    respond(200, await command(action, data ? JSON.parse(data) : {}));
    lastError = "";
  } catch (e) {
    // Playwright diagnostics may include typed text. Do not log request bodies or raw input errors.
    lastError = action === "input" ? "Не удалось выполнить ввод. Обновите окно входа." : e instanceof Error ? e.message : "Ошибка TikTok";
    respond(400, { error: lastError });
  } finally { commandBusy = false; }
});
server.listen(Number(process.env.TIKTOK_BROWSER_PORT || 43128), host, () => {
  recoverJobs(state); persist();
  const address = server.address();
  console.log(`Фоновый обработчик TikTok запущен: ${typeof address === "object" && address ? address.port : ""}`);
  setInterval(async () => {
    if (busy || commandBusy) return;
    if (login) {
      if (Date.now() > loginUntil) { login = false; await context?.close().catch(() => {}); }
      return;
    }
    try {
      if (state.autoPublish && state.connected) for (const project of listProjects()) {
        const stamp = sourceStamp(project.id);
        if (stamp && !state.seen.includes(stamp) && project.processing.state === "done") {
          try { enqueue({ projectId: project.id }); state.seen.push(stamp); persist(); }
          catch (e) { lastError = `Проект ${project.id}: ${e instanceof Error ? e.message : "не удалось создать публикацию"}`; }
        }
      }
      const next = state.connected && state.jobs.find(j => j.status === "queued" && Date.parse(j.scheduledAt) <= Date.now());
      if (next) await run(next);
    } catch (e) { lastError = e instanceof Error ? e.message : "Ошибка обработчика"; }
  }, 3000);
});
server.on("error", e => { console.error(e.message); process.exit(1); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => {
  server.close(); await context?.close().catch(() => {}); process.exit(0);
});
