import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { X_PROFILE_DIR } from "./state.js";

/**
 * Playwright over x.com. X is mid-migration to a new front end: the logged-out pages already ship
 * without a single data-testid, while parts of the logged-in app may still be the old React build.
 * Every control is therefore looked up through an ordered list of strategies, and anything we cannot
 * find is an error — never a silent skip that would post half a message or read an empty timeline.
 */
export class XLoginRequired extends Error {}
export class XLayoutChanged extends Error {}

export const X_HOME = "https://x.com/home";
export const X_COMPOSE = "https://x.com/compose/post";
export const X_NOTIFICATIONS = "https://x.com/notifications/mentions";
/**
 * Every navigation waits for domcontentloaded, not for a painted page; longer than this is no longer
 * "slow", it is broken. The caller's per-action budgets in src/x/browser/client.ts add up the waits
 * spelled out in this file, so a number raised here must be raised there too.
 */
export const NAV_MS = 30_000;
const LOGIN_PATH = /\/(i\/flow\/login|i\/jf\/onboarding|login|account\/access)/;

export async function openXBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(X_PROFILE_DIR, {
    headless: process.env.X_BROWSER_HEADLESS !== "false",
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: process.env.TIMEZONE || "Europe/Moscow",
    ...(process.env.X_BROWSER_CHANNEL ? { channel: process.env.X_BROWSER_CHANNEL } : {}),
  });
}

/** Named strategies, tried in order. The winner's name is what the layout probe reports. */
export interface Strategy {
  name: string;
  find: (scope: Page | Locator) => Locator;
}

export async function firstVisible(scope: Page | Locator, strategies: Strategy[], timeoutMs: number): Promise<{ name: string; locator: Locator }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  do {
    for (const s of strategies) {
      try {
        const locator = s.find(scope).first();
        if (await locator.isVisible({ timeout: 250 })) return { name: s.name, locator };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
  } while (Date.now() < deadline);
  throw new XLayoutChanged(`X изменил разметку: не нашли элемент (${strategies.map((s) => s.name).join(", ")})${lastError ? `; ${lastError}` : ""}`);
}

const COMPOSER: Strategy[] = [
  { name: "testid:tweetTextarea_0", find: (s) => s.locator('[data-testid="tweetTextarea_0"]') },
  { name: "testid:tweetTextarea*", find: (s) => s.locator('[data-testid^="tweetTextarea"][contenteditable="true"]') },
  { name: "role:textbox[post]", find: (s) => s.getByRole("textbox", { name: /post text|what.s happening|что происходит|новый пост/i }) },
];

const SUBMIT: Strategy[] = [
  { name: "testid:tweetButton", find: (s) => s.locator('[data-testid="tweetButton"]') },
  { name: "testid:tweetButtonInline", find: (s) => s.locator('[data-testid="tweetButtonInline"]') },
  { name: "role:button[post]", find: (s) => s.getByRole("button", { name: /^(post|reply|опубликовать|ответить)$/i }) },
  { name: "text:post", find: (s) => s.locator('button:has-text("Post"), button:has-text("Reply"), button:has-text("Опубликовать"), button:has-text("Ответить")') },
];

const FILE_INPUT: Strategy[] = [
  { name: "testid:fileInput", find: (s) => s.locator('[data-testid="fileInput"]') },
  { name: "input[accept=image]", find: (s) => s.locator('input[type="file"][accept*="image"]') },
  { name: "input[file]", find: (s) => s.locator('input[type="file"]') },
];

const LOGGED_IN: Strategy[] = [
  { name: "testid:accountSwitcher", find: (s) => s.locator('[data-testid="SideNav_AccountSwitcher_Button"]') },
  { name: "link:profile", find: (s) => s.getByRole("link", { name: /^(profile|профиль)$/i }) },
  { name: "testid:AppTabBar_Profile", find: (s) => s.locator('[data-testid="AppTabBar_Profile_Link"]') },
  { name: "composer", find: (s) => s.locator('[data-testid^="tweetTextarea"], div[contenteditable="true"][role="textbox"]') },
];

const REPLY_BUTTON: Strategy[] = [
  { name: "testid:reply", find: (s) => s.locator('[data-testid="reply"]') },
  { name: "role:button[reply]", find: (s) => s.getByRole("button", { name: /^(reply|ответить)$/i }) },
  { name: "aria:reply", find: (s) => s.locator('[aria-label*="Reply" i], [aria-label*="Ответ" i]') },
];

/** A password field anywhere means X is asking to sign in, whatever the URL says. */
async function showsLoginForm(page: Page): Promise<boolean> {
  if (LOGIN_PATH.test(new URL(page.url()).pathname)) return true;
  return page.locator('input[type="password"], input[name="username_or_email"], input[name="text"]').first().isVisible({ timeout: 500 }).catch(() => false);
}

/**
 * Three answers, not two. A page that simply has not finished painting must never be reported as a
 * lost session: that would switch X off in the settings and tell the owner to sign in again while
 * his login is perfectly fine.
 */
export type LoginState = "yes" | "no" | "unknown";

export async function loginState(page: Page): Promise<LoginState> {
  if (await showsLoginForm(page)) return "no";
  try {
    await firstVisible(page, LOGGED_IN, 8_000);
    return "yes";
  } catch {
    return "unknown";
  }
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  return (await loginState(page)) === "yes";
}

/** The check every action starts with; `what` ends up in the message the owner reads. */
export async function assertLoggedIn(page: Page, what: string): Promise<void> {
  let state = await loginState(page);
  if (state === "unknown") {
    // Give the app time to actually paint before deciding we do not recognise the page.
    await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
    state = await loginState(page);
  }
  if (state === "no") throw new XLoginRequired(`X просит войти — ${what}.`);
  if (state === "unknown") throw new XLayoutChanged(`X показал незнакомую страницу — ${what}. Откройте окно браузера и посмотрите сами.`);
}

export async function goHome(page: Page): Promise<void> {
  await page.goto(X_HOME, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await assertLoggedIn(page, "лента не открылась");
}

/**
 * The handle, read from the page rather than remembered from a form: a session that silently
 * switched accounts must not keep posting under the old name.
 */
export async function readIdentity(page: Page): Promise<{ username: string } | null> {
  if (!/^https:\/\/x\.com\//.test(page.url())) await page.goto(X_HOME, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  if (await showsLoginForm(page)) return null;

  // The avatar in the side navigation carries the handle in its test id — present on every page
  // of the signed-in app, so no extra navigation is needed. The three side-nav reads below run on a
  // page that is already open and recognised, so they get seconds, not the timeouts of a fresh load.
  const avatar = await page.locator('[data-testid^="UserAvatar-Container-"]').first().getAttribute("data-testid", { timeout: 5_000 }).catch(() => null);
  const fromAvatar = avatar?.replace("UserAvatar-Container-", "").trim();
  if (fromAvatar && /^[A-Za-z0-9_]{1,15}$/.test(fromAvatar)) return { username: fromAvatar };

  const switcher = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').first().innerText({ timeout: 3_000 }).catch(() => "");
  const fromSwitcher = switcher.match(/@([A-Za-z0-9_]{1,15})\b/)?.[1];
  if (fromSwitcher) return { username: fromSwitcher };

  const profileHref = await page.locator('[data-testid="AppTabBar_Profile_Link"]').first().getAttribute("href", { timeout: 3_000 }).catch(() => null);
  const fromProfile = profileHref?.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1];
  if (fromProfile) return { username: fromProfile };

  await page.goto("https://x.com/settings/account", { waitUntil: "domcontentloaded", timeout: NAV_MS });
  if (await showsLoginForm(page)) return null;
  const body = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  const handle = body.match(/@([A-Za-z0-9_]{1,15})\b/)?.[1];
  if (handle) return { username: handle };
  // Fall back to the profile link in the navigation, whose href IS the handle.
  await page.goto(X_HOME, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  const reserved = ["home", "explore", "notifications", "messages", "settings", "i", "compose", "search", "bookmarks", "jobs"];
  const links = page.locator('a[href^="/"]');
  for (let i = 0, n = Math.min(await links.count(), 60); i < n; i++) {
    const href = await links.nth(i).getAttribute("href");
    const m = href?.match(/^\/([A-Za-z0-9_]{1,15})$/);
    if (m && !reserved.includes(m[1]!.toLowerCase())) return { username: m[1]! };
  }
  return null;
}

/** Type and then read back: X must hold the whole text, or nothing is sent. */
export async function fillComposer(page: Page, text: string): Promise<void> {
  // Точный селектор пробуем первым: на странице есть и другие поля ввода (чат Grok), и промах
  // здесь означает пост, набранный не туда. Страница уже открыта и опознана, поэтому ждать поле
  // дольше двадцати секунд бессмысленно — его там просто нет.
  const { locator } = await firstVisible(page, COMPOSER, 20_000);
  await locator.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(text);
  const actual = (await locator.innerText()).replace(/\s+/g, " ").trim();
  const wanted = text.replace(/\s+/g, " ").trim();
  if (actual !== wanted) throw new XLayoutChanged("X не принял текст полностью — публикация остановлена.");
}

export async function attachImage(page: Page, file: string): Promise<void> {
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 10_000 }).catch(() => {
    throw new XLayoutChanged("X не показал поле для картинки — публикация остановлена.");
  });
  await input.setInputFiles(file);
  const preview = page.locator('[data-testid="attachments"] img, img[src^="blob:"]').first();
  // Превью рисуется из локального blob, ещё до отправки файла на сервер: полминуты тут с запасом.
  await preview.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
    throw new XLayoutChanged("X не показал прикреплённую картинку — публикация остановлена.");
  });
}

/** Caller must record "submitted" BEFORE calling: clicking this is not idempotent. */
/**
 * X рисует кнопку публикации не формой, а div с aria-disabled, поэтому Playwright-овское isEnabled()
 * у неё всегда true. Пустой пост давал живой клик по мёртвой кнопке: «отправили» — и ни поста,
 * ни ошибки. Спрашиваем сам X, готов ли он отправлять.
 */
async function submitReady(locator: Locator): Promise<boolean> {
  if (!(await locator.isEnabled())) return false;
  const aria = await locator.getAttribute("aria-disabled").catch(() => null);
  return aria !== "true";
}

export async function submitComposer(page: Page): Promise<void> {
  // Кнопка живёт в том же окне, что и уже заполненное поле: не нашли её за десять секунд — не найдём.
  // Ожить она может не сразу — X ждёт загрузку картинки, — но полминуты хватает и на это.
  const { locator } = await firstVisible(page, SUBMIT, 10_000);
  const deadline = Date.now() + 30_000;
  while (!(await submitReady(locator))) {
    if (Date.now() > deadline) throw new XLayoutChanged("Кнопка публикации в X осталась неактивной — X не принял текст поста.");
    await page.waitForTimeout(500);
  }
  await locator.click();
}

/**
 * X shows a toast linking to the fresh post; that link is the cheapest proof it went out. It pops up
 * within seconds of the click or not at all, so waiting longer only delays the timeline probe that
 * has to answer anyway.
 */
export async function publishedIdFromToast(page: Page): Promise<string | null> {
  const toast = page.locator('[data-testid="toast"], [role="alert"]').first();
  await toast.waitFor({ state: "visible", timeout: 15_000 }).catch(() => null);
  const href = await toast.locator('a[href*="/status/"]').first().getAttribute("href", { timeout: 3_000 }).catch(() => null);
  return href?.match(/\/status\/(\d+)/)?.[1] ?? null;
}

/** Open someone's post and put the cursor in the reply box under it. */
export async function openReplyBox(page: Page, postId: string): Promise<void> {
  await page.goto(`https://x.com/i/status/${postId}`, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await assertLoggedIn(page, "ответ не отправлен");
  try {
    await firstVisible(page, COMPOSER, 5_000);
    return;
  } catch {
    const { locator } = await firstVisible(page, REPLY_BUTTON, 20_000);
    await locator.click();
    await firstVisible(page, COMPOSER, 20_000);
  }
}

export interface ScrapedPost {
  id: string;
  username: string;
  text: string;
  timestamp: Date | null;
  permalink: string;
  isReply: boolean;
  imageUrls: string[];
}

const STATUS_HREF = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;

// Язык интерфейса X берётся из настроек аккаунта, а не из locale браузера: у владельца он русский,
// поэтому лента разговора подписана «Лента: Переписка». Держим оба языка и не угадываем дальше.
const CONVERSATION: Strategy[] = [
  { name: "aria:Timeline Conversation", find: (s) => s.locator('[aria-label^="Timeline: Conversation" i]') },
  { name: "aria:Лента Переписка", find: (s) => s.locator('[aria-label^="Лента: Переписка" i]') },
  { name: "aria:Conversation", find: (s) => s.locator('[aria-label*="Conversation" i], [aria-label*="Переписк" i]') },
];

/**
 * Лента разговора под нашим постом — и только она. Страница поста в X ниже ответов рисует блок
 * «Discover more» с чужими, никак не связанными постами, и они такие же <article>. Если читать
 * страницу целиком, эти чужие посты приезжают как «комментарии под нашим постом», а автоответ
 * уходит публичным комментарием под чужой пост. Не нашли контейнер разговора — это ошибка,
 * а не повод отдать всё подряд.
 */
export async function scrapeConversation(page: Page, limit: number): Promise<ScrapedPost[]> {
  const { locator } = await firstVisible(page, CONVERSATION, 20_000);
  return scrapeTimeline(locator, limit);
}

/** Works on any timeline: profile, search results, notifications. */
export async function scrapeTimeline(page: Page | Locator, limit: number): Promise<ScrapedPost[]> {
  const articles = page.locator("article");
  await articles.first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => null);
  const out: ScrapedPost[] = [];
  const seen = new Set<string>();
  for (let i = 0, n = Math.min(await articles.count(), limit * 3); i < n && out.length < limit; i++) {
    const article = articles.nth(i);
    const links = article.locator('a[href*="/status/"]');
    let id = "";
    let username = "";
    for (let j = 0, m = Math.min(await links.count(), 6); j < m && !id; j++) {
      const match = (await links.nth(j).getAttribute("href"))?.match(STATUS_HREF);
      if (match) {
        username = match[1]!;
        id = match[2]!;
      }
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Текст поста и текст всей карточки — разные вещи: «Replying to @…» живёт вне tweetText,
    // поэтому искать признак ответа в тексте поста бессмысленно, он там никогда не встретится.
    const articleText = await article.innerText().catch(() => "");
    const body = await article.locator('[data-testid="tweetText"]').first().innerText().catch(() => null);
    const whole = body ?? articleText;
    const iso = await article.locator("time[datetime]").first().getAttribute("datetime").catch(() => null);
    const imgs = article.locator('[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media/"]');
    const imageUrls: string[] = [];
    for (let k = 0, p = Math.min(await imgs.count(), 4); k < p; k++) {
      const src = await imgs.nth(k).getAttribute("src");
      if (src) imageUrls.push(src);
    }
    out.push({
      id,
      username,
      text: whole.replace(/\s+/g, " ").trim().slice(0, 2000),
      timestamp: iso ? new Date(iso) : null,
      permalink: `https://x.com/${username}/status/${id}`,
      isReply: /(^|\n)\s*(replying to|в ответ)/i.test(articleText),
      imageUrls,
    });
  }
  return out;
}

/**
 * Recovery probe after an ambiguous send. "Not found" and "could not look" must stay different
 * answers, so a failure to read throws instead of reporting an empty timeline.
 */
/**
 * Опубликованный пост X отдаёт эмодзи картинкой, и в тексте страницы его нет, а в нашем исходнике
 * есть. Сравнение «слово в слово» тогда не совпадёт никогда, проверка решит, что поста нет, —
 * и очередь отправит его второй раз. Поэтому сравниваем без эмодзи и без разницы в пробелах.
 */
const plainText = (s: string): string =>
  s
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export async function findOwnPostByText(page: Page, username: string, text: string, since: Date): Promise<ScrapedPost | null> {
  await page.goto(`https://x.com/${username}/with_replies`, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await assertLoggedIn(page, "проверить публикацию не удалось");
  const wanted = plainText(text).slice(0, 80);
  const posts = await scrapeTimeline(page, 30);
  if (!posts.length) throw new XLayoutChanged("Не удалось прочитать ленту профиля для проверки публикации.");
  const floor = since.getTime() - 5 * 60_000;
  return posts.find((p) => plainText(p.text).includes(wanted) && (!p.timestamp || p.timestamp.getTime() >= floor)) ?? null;
}

/** What the live page actually offers — the answer that replaces guessing at X's current markup. */
export async function probeLayout(page: Page): Promise<Record<string, string>> {
  const groups: Array<[string, Strategy[]]> = [["composer", COMPOSER], ["submit", SUBMIT], ["fileInput", FILE_INPUT], ["loggedIn", LOGGED_IN], ["reply", REPLY_BUTTON]];
  const result: Record<string, string> = { url: page.url() };
  for (const [key, strategies] of groups) {
    result[key] = await firstVisible(page, strategies, 3_000).then((r) => r.name).catch(() => "не найдено");
  }
  result.articles = String(await page.locator("article").count());
  // Разметку разговора X называет по-своему, поэтому показываем живые aria-label: по ним и
  // подбирается контейнер, внутри которого лежат настоящие ответы, а не блок «Discover more».
  const labelled = page.locator("[aria-label]");
  const labels: string[] = [];
  for (let i = 0, n = Math.min(await labelled.count(), 120); i < n; i++) {
    const v = await labelled.nth(i).getAttribute("aria-label");
    if (v && v.length > 3 && v.length < 80 && !labels.includes(v)) labels.push(v);
  }
  result.ariaLabels = labels.slice(0, 40).join(" | ") || "нет";
  const testids = page.locator("[data-testid]");
  const names = new Set<string>();
  for (let i = 0, n = Math.min(await testids.count(), 200); i < n; i++) {
    const v = await testids.nth(i).getAttribute("data-testid");
    if (v) names.add(v);
  }
  result.testids = [...names].slice(0, 60).join(", ") || "нет ни одного";
  return result;
}
