// Вход в X в настоящем окне браузера на этом компьютере.
//
// Окно открывается на вашем экране, вы входите как обычно — своей клавиатурой, без задержек и без
// посредников. Пароль идёт напрямую в X: скрипт его не видит и не сохраняет. Когда вход выполнен,
// скрипт сам замечает это, сохраняет только cookies сессии в указанный файл и закрывает окно.
// Дальше этот файл переносится в контейнер браузера и удаляется.
//
// Запуск:  node scripts/x-login.mjs [путь-к-файлу-сессии]
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const out = process.argv[2] || path.join(os.tmpdir(), "x-session.json");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "x-login-"));
const DEADLINE_MS = 15 * 60_000;
const LOGIN_PATH = /\/(i\/flow\/login|i\/jf\/onboarding|login|account\/access)/;

// Настоящий Chrome и выключенный признак автоматизации: вход через Google из «робота» просто
// не пускают, а так окно выглядит обычным браузером. Если Chrome не установлен — берём свой Chromium.
const opts = {
  headless: false,
  viewport: null,
  args: ["--window-size=1280,900", "--disable-blink-features=AutomationControlled"],
  ignoreDefaultArgs: ["--enable-automation"],
  locale: "en-US",
};
const ctx = await chromium
  .launchPersistentContext(profile, { ...opts, channel: "chrome" })
  .catch(() => chromium.launchPersistentContext(profile, opts));
const page = ctx.pages()[0] ?? (await ctx.newPage());

async function loggedIn() {
  try {
    const cookies = await ctx.cookies("https://x.com");
    // auth_token живёт только у вошедшего пользователя; ct0 — парный ему токен запросов.
    return cookies.some((c) => c.name === "auth_token" && c.value.length > 10);
  } catch {
    return false;
  }
}

await page.goto("https://x.com/i/flow/login", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
console.log("Окно открыто. Войдите в X — я жду и не трогаю страницу.");

const until = Date.now() + DEADLINE_MS;
let ok = false;
while (Date.now() < until) {
  if (await loggedIn()) {
    // Дать X дописать вторую половину cookies после редиректа на ленту.
    await page.waitForTimeout(4000);
    ok = true;
    break;
  }
  if (page.isClosed() && !ctx.pages().length) break;
  await new Promise((r) => setTimeout(r, 2000));
}

if (!ok) {
  console.error("Вход не завершён: auth_token так и не появился.");
  await ctx.close().catch(() => {});
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(1);
}

let handle = "";
try {
  await page.goto("https://x.com/settings/account", { waitUntil: "domcontentloaded", timeout: 45_000 });
  const body = await page.locator("body").innerText({ timeout: 15_000 });
  handle = body.match(/@([A-Za-z0-9_]{1,15})\b/)?.[1] ?? "";
} catch {
  handle = "";
}

const cookies = await ctx.cookies();
fs.writeFileSync(out, JSON.stringify({ cookies, handle }), { mode: 0o600 });
console.log(`Вход выполнен${handle ? `: @${handle}` : ""}. Сессия сохранена: ${out}`);
await ctx.close().catch(() => {});
fs.rmSync(profile, { recursive: true, force: true });
