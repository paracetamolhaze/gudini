import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import path from "node:path";
import { TIKTOK_DIR, type TikTokJob } from "./state";

export const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload";
export class LoginRequired extends Error {}

/** One dedicated persistent profile, never the owner's normal browser. */
export async function openTikTokBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(path.join(TIKTOK_DIR, "profile"), {
    headless: true, viewport: { width: 1280, height: 900 }, locale: "en-US",
    ...(process.env.TIKTOK_BROWSER_CHANNEL ? { channel: process.env.TIKTOK_BROWSER_CHANNEL } : {}),
  });
}
export async function needsLogin(page: Page): Promise<boolean> {
  if (/\/login(?:[/?]|$)/.test(page.url())) return true;
  return await page.locator('iframe[src*="captcha"], [id*="captcha-verify"], [class*="captcha_verify"]').first().isVisible().catch(() => false);
}
export async function uploadControl(page: Page): Promise<Locator> {
  const input = page.locator('input[type="file"][accept*="video"], input[type="file"][accept*="mp4"]').first();
  try { await input.waitFor({ state: "attached", timeout: 30_000 }); }
  catch {
    if (await needsLogin(page) || await page.getByText(/Log in to TikTok|Войти в TikTok/i).first().isVisible())
      throw new LoginRequired("TikTok требует вход или проверку. Откройте подключение в настройках.");
    throw new Error("TikTok не показал форму загрузки. Проверьте страницу в настройках.");
  }
  return input;
}

/** Fail closed when TikTok changes its editor; never silently omit caption/cover. */
export async function preparePost(page: Page, job: TikTokJob): Promise<void> {
  await page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const input = await uploadControl(page);
  await input.setInputFiles(job.video);
  const editor = page.locator('[contenteditable="true"][role="textbox"], [contenteditable="true"].public-DraftEditor-content, [contenteditable="true"][data-lexical-editor="true"]').first();
  await editor.waitFor({ state: "visible", timeout: 180_000 });
  await editor.fill(job.caption);
  const actual = (await editor.innerText()).replace(/\s+/g, " ").trim();
  if (actual !== job.caption.replace(/\s+/g, " ").trim()) throw new Error("TikTok не сохранил описание полностью.");

  if (job.cover) {
    await page.getByText(/^(Edit cover|Select cover|Изменить обложку|Выбрать обложку)$/i).first().click();
    const custom = page.getByText(/^(Upload cover|Upload image|Загрузить обложку|Загрузить изображение)$/i).first();
    if (await custom.isVisible()) await custom.click();
    const image = page.locator('input[type="file"][accept*="image"]').last();
    await image.waitFor({ state: "attached", timeout: 15_000 });
    await image.setInputFiles(job.cover);
    const dialog = page.getByRole("dialog");
    const scope = await dialog.count() === 1 ? dialog : page.locator("body");
    const save = scope.getByRole("button", { name: /^(Confirm|Save|Сохранить|Подтвердить)$/i });
    await save.click();
    await save.waitFor({ state: "hidden", timeout: 30_000 });
  }

  // Public posting is the selected product mode. Do not inherit a stale private setting.
  const audience = page.getByText(/^(Everyone|Все)$/i).first();
  if (!(await audience.isVisible())) throw new Error("Не удалось подтвердить видимость «Все». Публикация остановлена.");
  if (await needsLogin(page)) throw new LoginRequired("TikTok запросил проверку перед публикацией.");
  const post = page.getByRole("button", { name: /^(Post|Publish|Опубликовать)$/i }).first();
  await post.waitFor({ state: "visible", timeout: 180_000 });
  const deadline = Date.now() + 180_000;
  while (!(await post.isEnabled())) {
    if (Date.now() > deadline) throw new Error("TikTok не завершил подготовку видео за 3 минуты.");
    if (await needsLogin(page)) throw new LoginRequired("TikTok требует проверку.");
    await page.waitForTimeout(1000);
  }
}

/** Caller must persist submitted=true BEFORE this non-idempotent action. */
export async function submitPost(page: Page): Promise<string | undefined> {
  await page.getByRole("button", { name: /^(Post|Publish|Опубликовать)$/i }).first().click();
  await page.getByText(/Your video (has been|is) (successfully )?(uploaded|posted|published)|Video (uploaded|posted|published)|Видео опубликовано/i).first()
    .waitFor({ state: "visible", timeout: 90_000 });
  const link = page.locator('a[href*="/video/"]').first();
  const href = await link.getAttribute("href").catch(() => null);
  if (!href) return undefined;
  const url = new URL(href, "https://www.tiktok.com");
  return url.hostname === "www.tiktok.com" && /^\/@[^/]+\/video\/\d+$/.test(url.pathname) ? url.href : undefined;
}
