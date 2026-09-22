import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { readXSession, writeXSession, removeXProfile, type XSessionState } from "./x/browser/state.js";
import {
  X_COMPOSE,
  X_HOME,
  X_NOTIFICATIONS,
  XLayoutChanged,
  XLoginRequired,
  assertLoggedIn,
  attachImage,
  fillComposer,
  findOwnPostByText,
  goHome,
  isLoggedIn,
  openReplyBox,
  openXBrowser,
  probeLayout,
  publishedIdFromToast,
  readIdentity,
  scrapeTimeline,
  submitComposer,
} from "./x/browser/pages.js";

/**
 * The X browser container. It owns one Chromium profile with the owner's login and does exactly what
 * it is told over HTTP; all bookkeeping (idempotency keys, budgets, drafts) stays in the main service,
 * which has the database. The owner signs in himself by driving this browser from the dashboard —
 * frames go out as JPEG, clicks and keystrokes come back — so no password ever passes through us.
 */
const state: XSessionState = readXSession();
const persist = () => writeXSession(state);
const VIEWPORT = { width: 1280, height: 900 };
const LOGIN_WINDOW_MS = 15 * 60_000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");

let context: BrowserContext | undefined;
let page: Page | undefined;
let login = false;
let loginUntil = 0;
let busy = false;
let lastError = "";

const token = process.env.X_BROWSER_TOKEN || "";
const host = process.env.X_BROWSER_HOST || "127.0.0.1";
if (host !== "127.0.0.1" && !token) throw new Error("X_BROWSER_TOKEN обязателен, когда обработчик слушает сеть.");

async function browserPage(): Promise<Page> {
  if (!context) {
    context = await openXBrowser();
    context.on("close", () => {
      context = undefined;
      page = undefined;
    });
  }
  if (!page || page.isClosed()) {
    page = context.pages()[0] ?? (await context.newPage());
    for (const extra of context.pages()) if (extra !== page) await extra.close();
  }
  page.setDefaultTimeout(20_000);
  return page;
}

async function closeBrowser(): Promise<void> {
  await context?.close().catch(() => {});
  context = undefined;
  page = undefined;
}

/** Media must come from our own data volume; a path from outside it is never opened. */
function safeMedia(file: unknown): string | null {
  if (typeof file !== "string" || !file) return null;
  const resolved = path.resolve(file);
  if (resolved !== DATA_DIR && !resolved.startsWith(DATA_DIR + path.sep)) throw new Error("Картинка вне папки данных");
  if (!fs.statSync(resolved).isFile()) throw new Error("Файл картинки отсутствует");
  return resolved;
}

function requireText(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Пустой текст");
  if (value.length > limit) throw new Error(`Текст длиннее ${limit} символов`);
  return value;
}

const requireId = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d{1,25}$/.test(value)) throw new Error("Некорректный идентификатор поста X");
  return value;
};

/**
 * The single non-idempotent step. After the click we owe the caller a precise answer, because
 * "X did not show it to us" and "the post is not there" license completely different next moves:
 *   toast      — X confirmed and gave us the link;
 *   found      — no confirmation, but the post is on our timeline;
 *   absent     — the timeline read fine and the post is not on it;
 *   unreadable — we could not look, so nothing may be re-sent.
 */
type Probe = "toast" | "found" | "absent" | "unreadable";

async function sendAndIdentify(p: Page, text: string): Promise<{ id: string | null; permalink: string | null; submitted: true; probe: Probe }> {
  const sentAt = new Date();
  await submitComposer(p);
  const toastId = await publishedIdFromToast(p).catch(() => null);
  if (toastId) return { id: toastId, permalink: `https://x.com/${state.username}/status/${toastId}`, submitted: true, probe: "toast" };
  // X can be slow to surface a fresh post; look twice before calling it absent.
  let probe: Probe = "absent";
  for (const wait of [5_000, 15_000]) {
    await p.waitForTimeout(wait);
    try {
      const found = await findOwnPostByText(p, state.username!, text, sentAt);
      if (found) return { id: found.id, permalink: found.permalink, submitted: true, probe: "found" };
    } catch {
      probe = "unreadable";
    }
  }
  return { id: null, permalink: null, submitted: true, probe };
}

/** How long a confirmed handle is trusted for read-only work. Sending always re-checks. */
const IDENTITY_TTL_MS = 10 * 60_000;
let identityCheckedAt = 0;

/**
 * The handle is read from the live page, not remembered from the sign-in form. The owner can open
 * the window at any time and switch to another account; without this check the next post would go
 * out from that account, and the "did it publish?" probe would read the old profile, find nothing
 * and send it again.
 */
async function ensureSession(opts: { sending?: boolean } = {}): Promise<Page> {
  if (!state.connected || !state.username) throw new XLoginRequired("X не подключён. Откройте подключение в настройках.");
  const p = await browserPage();
  await goHome(p);
  if (!opts.sending && Date.now() - identityCheckedAt < IDENTITY_TTL_MS) return p;
  const identity = await readIdentity(p);
  if (!identity) throw new XLoginRequired("X не показал имя аккаунта — вероятно, вход слетел.");
  if (identity.username.toLowerCase() !== state.username.toLowerCase()) {
    state.connected = false;
    state.issue = `В браузере открыт другой аккаунт (@${identity.username}). Подключите нужный заново.`;
    persist();
    throw new XLoginRequired(state.issue);
  }
  identityCheckedAt = Date.now();
  state.checkedAt = new Date().toISOString();
  persist();
  return p;
}

async function publish(body: Record<string, unknown>): Promise<unknown> {
  const text = requireText(body.text, 25_000);
  const image = safeMedia(body.imagePath ?? null);
  const p = await ensureSession({ sending: true });
  await p.goto(X_COMPOSE, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await assertLoggedIn(p, "публикация остановлена до отправки");
  await fillComposer(p, text);
  if (image) await attachImage(p, image);
  return await sendAndIdentify(p, text);
}

async function reply(body: Record<string, unknown>): Promise<unknown> {
  const text = requireText(body.text, 25_000);
  const replyToId = requireId(body.replyToId);
  const p = await ensureSession({ sending: true });
  await openReplyBox(p, replyToId);
  await fillComposer(p, text);
  return await sendAndIdentify(p, text);
}

async function quote(body: Record<string, unknown>): Promise<unknown> {
  const text = requireText(body.text, 25_000);
  const quotedId = requireId(body.quotedId);
  const p = await ensureSession({ sending: true });
  // A quote post is a normal post whose text ends with the quoted link; X renders the card itself.
  await p.goto(X_COMPOSE, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await assertLoggedIn(p, "цитата не отправлена");
  await fillComposer(p, `${text}\n\nhttps://x.com/i/status/${quotedId}`);
  return await sendAndIdentify(p, text);
}

async function recover(body: Record<string, unknown>): Promise<unknown> {
  const text = requireText(body.text, 25_000);
  const since = new Date(String(body.since ?? ""));
  if (!Number.isFinite(since.getTime())) throw new Error("Некорректная дата проверки");
  const p = await ensureSession();
  const found = await findOwnPostByText(p, state.username!, text, since);
  return { id: found?.id ?? null, permalink: found?.permalink ?? null };
}

async function inbox(body: Record<string, unknown>): Promise<unknown> {
  const max = Math.max(1, Math.min(Number(body.max) || 30, 100));
  const p = await ensureSession();
  await p.goto(X_NOTIFICATIONS, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await assertLoggedIn(p, "уведомления не прочитаны");
  const posts = await scrapeTimeline(p, max);
  return { posts: posts.filter((post) => post.username.toLowerCase() !== (state.username ?? "").toLowerCase()) };
}

/** Everything written under one of our own posts, which is where own-post comments come from. */
async function thread(body: Record<string, unknown>): Promise<unknown> {
  const postId = requireId(body.postId);
  const max = Math.max(1, Math.min(Number(body.max) || 20, 60));
  const p = await ensureSession();
  await p.goto(`https://x.com/i/status/${postId}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await assertLoggedIn(p, "ветка не прочитана");
  const posts = await scrapeTimeline(p, max + 1);
  return { posts: posts.filter((post) => post.id !== postId) };
}

async function search(body: Record<string, unknown>): Promise<unknown> {
  const queryText = requireText(body.query, 400);
  const max = Math.max(1, Math.min(Number(body.max) || 20, 60));
  const p = await ensureSession();
  await p.goto(`https://x.com/search?q=${encodeURIComponent(queryText)}&f=live`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await assertLoggedIn(p, "поиск не выполнен");
  return { posts: await scrapeTimeline(p, max) };
}

const COUNT = /([\d\s.,]+)\s*(?:тыс|млн|K|M)?\s*(views|просмотр|likes|нрав|repl|ответ|repost|Репост|quote|цитат|bookmark|закладк)/gi;

async function metrics(body: Record<string, unknown>): Promise<unknown> {
  const postId = requireId(body.postId);
  const p = await ensureSession();
  await p.goto(`https://x.com/i/status/${postId}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await assertLoggedIn(p, "статистика не прочитана");
  const group = p.locator('[role="group"][aria-label]').first();
  const label = (await group.getAttribute("aria-label").catch(() => null)) ?? "";
  const numbers: Record<string, number> = {};
  for (const m of label.matchAll(COUNT)) {
    const value = Number(m[1]!.replace(/[^\d]/g, ""));
    const what = m[2]!.toLowerCase();
    const key = /view|просмотр/.test(what) ? "views" : /like|нрав/.test(what) ? "likes" : /repl|ответ/.test(what) ? "replies" : /repost|репост/.test(what) ? "reposts" : /quote|цитат/.test(what) ? "quotes" : "shares";
    if (Number.isFinite(value)) numbers[key] = value;
  }
  return { metrics: { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, shares: 0, ...numbers }, raw: label };
}

/** A picture of the page. `settle` lets the page react to a click before we look at it. */
async function shot(p: Page, settle = 0): Promise<{ image: string; url: string }> {
  if (settle) await p.waitForTimeout(settle);
  return { image: (await p.screenshot({ type: "jpeg", quality: 60 })).toString("base64"), url: p.url() };
}

function status() {
  return {
    connected: state.connected,
    username: state.username ?? null,
    checkedAt: state.checkedAt ?? null,
    issue: state.issue ?? null,
    login,
    busy,
    error: lastError,
  };
}

async function command(action: string, body: Record<string, unknown>): Promise<unknown> {
  if (action === "status") return status();

  if (action === "login") {
    if (busy) throw new Error("Сейчас идёт публикация в X. Дождитесь её завершения.");
    login = true;
    loginUntil = Date.now() + LOGIN_WINDOW_MS;
    try {
      const p = await browserPage();
      await p.goto(X_HOME, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (err) {
      login = false;
      await closeBrowser();
      throw err;
    }
    return status();
  }

  if (action === "frame") {
    if (!login) throw new Error("Окно входа X закрыто.");
    return await shot(await browserPage());
  }

  if (action === "input") {
    if (!login) throw new Error("Окно входа X закрыто.");
    loginUntil = Date.now() + LOGIN_WINDOW_MS;
    const p = await browserPage();
    const inside = (x: unknown, y: unknown) => Number.isFinite(x) && Number.isFinite(y) && (x as number) >= 0 && (x as number) <= VIEWPORT.width && (y as number) >= 0 && (y as number) <= VIEWPORT.height;
    if (body.type === "click" && inside(body.x, body.y)) await p.mouse.click(body.x as number, body.y as number);
    else if (body.type === "drag" && inside(body.x, body.y) && inside(body.toX, body.toY)) {
      await p.mouse.move(body.x as number, body.y as number);
      await p.mouse.down();
      try {
        await p.mouse.move(body.toX as number, body.toY as number, { steps: 25 });
      } finally {
        await p.mouse.up();
      }
    } else if (body.type === "text" && typeof body.text === "string" && body.text.length <= 1000) await p.keyboard.insertText(body.text);
    else if (body.type === "key" && typeof body.key === "string" && ["Tab", "Enter", "Backspace", "Escape", "ControlOrMeta+A", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(body.key)) await p.keyboard.press(body.key);
    else if (body.type === "scroll" && Number.isFinite(body.dy)) await p.mouse.wheel(0, Math.max(-800, Math.min(800, body.dy as number)));
    else if (body.type === "back") await p.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    else throw new Error("Неизвестное действие окна входа");
    // Answer with the page as it looks now: one round trip instead of a click and a separate frame.
    return await shot(p, 350);
  }

  if (action === "finish") {
    if (!login) throw new Error("Окно входа X закрыто.");
    const p = await browserPage();
    await p.goto(X_HOME, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (!(await isLoggedIn(p))) throw new Error("Вход ещё не завершён. Войдите в X и повторите проверку.");
    const identity = await readIdentity(p);
    if (!identity) throw new Error("Вход выполнен, но X не показал имя аккаунта. Откройте окно ещё раз.");
    state.connected = true;
    state.username = identity.username;
    identityCheckedAt = Date.now();
    state.checkedAt = new Date().toISOString();
    state.issue = undefined;
    persist();
    login = false;
    await closeBrowser();
    return status();
  }

  if (action === "close") {
    login = false;
    await closeBrowser();
    return status();
  }

  if (action === "disconnect") {
    login = false;
    await closeBrowser();
    removeXProfile();
    state.connected = false;
    state.username = undefined;
    state.checkedAt = undefined;
    state.issue = undefined;
    persist();
    return status();
  }

  if (action === "probe") {
    const p = login ? await browserPage() : await ensureSession();
    if (typeof body.url === "string" && /^https:\/\/x\.com\//.test(body.url)) await p.goto(body.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return { layout: await probeLayout(p) };
  }

  if (login) throw new Error("Открыто окно входа X. Закройте его, чтобы продолжить публикацию.");
  if (busy) throw new Error("Предыдущее действие X ещё выполняется.");
  busy = true;
  try {
    switch (action) {
      case "publish":
        return await publish(body);
      case "reply":
        return await reply(body);
      case "quote":
        return await quote(body);
      case "recover":
        return await recover(body);
      case "inbox":
        return await inbox(body);
      case "thread":
        return await thread(body);
      case "search":
        return await search(body);
      case "metrics":
        return await metrics(body);
      case "me": {
        // ensureSession itself compares the live handle with the remembered one.
        await ensureSession({ sending: true });
        return { username: state.username };
      }
      default:
        throw new Error("Неизвестная команда");
    }
  } catch (err) {
    if (err instanceof XLoginRequired) {
      state.connected = false;
      state.issue = err.message;
      persist();
    }
    throw err;
  } finally {
    busy = false;
    // Every task ends with a closed browser: a long-lived page drifts, and a fresh one is cheap.
    if (!login) await closeBrowser();
  }
}

/**
 * One browser, so one command at a time — but a click must never be thrown away because a frame
 * happened to be in flight. Requests wait their turn instead of being refused.
 */
let chain: Promise<unknown> = Promise.resolve();
let waiting = 0;

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  if (waiting >= 8) return Promise.reject(new Error("Слишком много действий подряд, подождите секунду."));
  waiting++;
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run.finally(() => {
    waiting--;
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const respond = (code: number, data: unknown) => {
    res.statusCode = code;
    res.end(JSON.stringify(data));
  };
  if (token && req.headers.authorization !== `Bearer ${token}`) return respond(401, { error: "Unauthorized" });
  const action = (req.url || "").slice(1);
  if (!/^[a-z]+$/.test(action)) return respond(404, { error: "Not found" });
  if (req.method !== "POST" && !(req.method === "GET" && ["status", "frame"].includes(action))) return respond(405, { error: "Method not allowed" });
  try {
    let data = "";
    for await (const chunk of req) {
      data += chunk;
      if (data.length > 32_768) throw new Error("Запрос слишком большой");
    }
    const body = data ? (JSON.parse(data) as Record<string, unknown>) : {};
    const result = await serialize(() => command(action, body));
    lastError = "";
    respond(200, result);
  } catch (err) {
    // Typed text may appear in Playwright diagnostics; never echo the request body back.
    lastError = action === "input" ? "Не удалось выполнить ввод. Обновите окно входа." : err instanceof Error ? err.message : "Ошибка X";
    respond(err instanceof XLoginRequired ? 409 : err instanceof XLayoutChanged ? 502 : 400, { error: lastError, kind: err instanceof XLoginRequired ? "login" : err instanceof XLayoutChanged ? "layout" : "error" });
  }
});

server.listen(Number(process.env.X_BROWSER_PORT || 43132), host, () => {
  console.log(`Браузер X запущен на порту ${process.env.X_BROWSER_PORT || 43132}`);
  setInterval(async () => {
    if (login && Date.now() > loginUntil) {
      login = false;
      await closeBrowser();
    }
  }, 5_000);
});
server.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    server.close();
    await closeBrowser();
    process.exit(0);
  });
