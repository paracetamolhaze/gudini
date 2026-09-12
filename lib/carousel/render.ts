import fs from "fs";
import path from "path";
import * as opentype from "opentype.js";
import type { Browser } from "playwright";
import type { Carousel, Slide } from "./types";
import { FORMATS, LANGUAGES } from "./limits";
import { getStyle } from "./styles";
import { buildSlideHtml, fontFaceCss, FIT_SCALES, FONT_FAMILY } from "./templates";
import { stripEmphasis, typograph } from "./text";
import { instagramImageProblems, jpegInfo } from "./jpeg";

/**
 * Рендер карточки: HTML-шаблон → безголовый Chromium → JPEG. Работает только в фоновом
 * обработчике (lib/carousel/runner.ts) и в процесс сайта не попадает.
 *
 * Проверки до снимка: шрифт содержит все символы текста (иначе браузер молча подставил
 * бы системный), встроенные шрифты загрузились, текст не выходит за блок ни по высоте,
 * ни по ширине. Не поместилось — кегль уменьшается ступенями; не помогло — у слайда
 * ошибка, картинки нет. Обрезанный текст в Instagram не уходит.
 */

const FONT_FILES = {
  display: path.join(process.cwd(), "fonts", "Montserrat-Black.ttf"),
  condensed: path.join(process.cwd(), "fonts", "Oswald-Bold.ttf"),
  text: path.join(process.cwd(), "assets", "carousel", "fonts", "LiberationSans-Regular.ttf"),
  textBold: path.join(process.cwd(), "assets", "carousel", "fonts", "LiberationSans-Bold.ttf"),
};
type FontKey = keyof typeof FONT_FILES;

let loaded: { css: string; faces: Record<FontKey, opentype.Font> } | null = null;

function loadFonts() {
  if (loaded) return loaded;
  const data = {} as Record<FontKey, Buffer>;
  for (const key of Object.keys(FONT_FILES) as FontKey[]) {
    const file = FONT_FILES[key];
    if (!fs.existsSync(file)) throw new Error(`Не найден шрифт карточек: ${path.relative(process.cwd(), file)}`);
    data[key] = fs.readFileSync(file);
  }
  const parse = (b: Buffer) => opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  loaded = {
    css: fontFaceCss({
      display: data.display.toString("base64"),
      condensed: data.condensed.toString("base64"),
      text: data.text.toString("base64"),
      textBold: data.textBold.toString("base64"),
    }),
    faces: { display: parse(data.display), condensed: parse(data.condensed), text: parse(data.text), textBold: parse(data.textBold) },
  };
  return loaded;
}

/** Символы текста слайда, которых нет в шрифте своего поля. */
export function missingGlyphs(c: Pick<Carousel, "style" | "language" | "footer">, slide: Pick<Slide, "kicker" | "title" | "body" | "bullets" | "cta">): string[] {
  const f = loadFonts().faces;
  const style = getStyle(c.style);
  const titleFont = style.titleFont === "display" ? f.display : f.condensed;
  const checks: [string, opentype.Font][] = [
    [style.titleUpper ? slide.title.toUpperCase() : slide.title, titleFont],
    [slide.kicker.toUpperCase(), f.condensed],
    [slide.body, f.text],
    [slide.bullets.join(" "), f.text],
    [slide.cta, f.textBold],
    [c.footer, f.textBold],
    [`0123456789/ ${LANGUAGES[c.language].swipe.toUpperCase()}`, f.condensed],
  ];
  const missing = new Set<string>();
  for (const [text, font] of checks) {
    for (const ch of stripEmphasis(typograph(text, c.language))) {
      if (/\s/.test(ch)) continue;
      if (font.charToGlyphIndex(ch) === 0) missing.add(ch);
    }
  }
  return [...missing];
}

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  const { chromium } = await import("playwright");
  const args = ["--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio", "--renderer-process-limit=1"];
  // в контейнере сайт работает от root — песочница Chromium без неё не стартует
  if (process.platform === "linux") args.push("--no-sandbox");
  const explicit = process.env.CAROUSEL_BROWSER;
  // локальная разработка на Windows: браузер Playwright может быть другой версии — берём установленный Edge или Chrome
  const fallbacks = process.platform === "win32" ? ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"] : [];
  const candidates: (string | undefined)[] = explicit ? [explicit] : [undefined, ...fallbacks.filter((p) => fs.existsSync(p))];
  let lastError: unknown;
  for (const executablePath of candidates) {
    try {
      browser = await chromium.launch({ headless: true, executablePath, args, timeout: 60_000 });
      return browser;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`Не удалось запустить браузер для рендера карточек: ${String((lastError as any)?.message ?? lastError).split("\n")[0].slice(0, 240)}`);
}

export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  try {
    await b?.close();
  } catch {}
}

const FONT_SPECS = [
  [`900 40px "${FONT_FAMILY.display}"`, FONT_FAMILY.display],
  [`700 40px "${FONT_FAMILY.condensed}"`, FONT_FAMILY.condensed],
  [`400 40px "${FONT_FAMILY.text}"`, `${FONT_FAMILY.text} 400`],
  [`700 40px "${FONT_FAMILY.text}"`, `${FONT_FAMILY.text} 700`],
];

// Выражения передаются строками: функции после сборки tsx тянули бы в страницу служебные помощники
const FONT_CHECK = `(async () => {
  await document.fonts.ready;
  const bad = [];
  for (const [spec, name] of ${JSON.stringify(FONT_SPECS)}) {
    let faces = [];
    try { faces = await document.fonts.load(spec, "АБВЁабвё"); } catch (e) {}
    if (!faces.length || faces.some((f) => f.status !== "loaded")) bad.push(name);
  }
  return bad;
})()`;

const MEASURE = `(() => {
  const problems = [];
  const content = document.querySelector(".content");
  if (content && content.scrollHeight > content.clientHeight + 1) problems.push("height");
  document.querySelectorAll("[data-fit]").forEach((el) => {
    if (el.scrollWidth > el.clientWidth + 1) problems.push(el.getAttribute("data-fit"));
  });
  // крупный номер — фон: если текст доходит до него, номер убирается, чтобы не мешать чтению
  let overlap = false;
  const num = document.querySelector(".bignum");
  if (num && content) {
    const box = num.getBoundingClientRect();
    for (const el of Array.from(content.children)) {
      const r = el.getBoundingClientRect();
      if (r.bottom > box.top + 24 && r.right > box.left) overlap = true;
    }
  }
  return { problems, overlap };
})()`;

const FIT_NAMES: Record<string, string> = {
  height: "текст не помещается по высоте",
  title: "в заголовке слово длиннее строки",
  body: "в тексте слово длиннее строки",
  bullets: "в пункте списка слово длиннее строки",
  kicker: "метка над заголовком не помещается в строку",
  footer: "подпись внизу карточки не помещается в строку",
  cta: "призыв не помещается",
};

export function fitError(problems: string[]): string {
  const list = [...new Set(problems)].map((p) => FIT_NAMES[p] ?? p);
  return `${list.join("; ")} даже при уменьшенном кегле — сократите текст`;
}

export type RenderOutcome = { ok: true; buffer: Buffer; scale: number; width: number; height: number } | { ok: false; error: string };

export async function renderSlide(c: Carousel, slide: Slide, index: number, total: number): Promise<RenderOutcome> {
  const missing = missingGlyphs(c, slide);
  if (missing.length) return { ok: false, error: `в шрифте карточек нет символов ${missing.map((ch) => `«${ch}»`).join(" ")} — замените их` };

  const { width, height } = FORMATS[c.format];
  const fontCss = loadFonts().css;
  const b = await getBrowser();
  // сеть выключена: страница не может ничего загрузить, даже если в текст попадёт ссылка
  const context = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1, offline: true, colorScheme: "light" });
  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    let last: string[] = [];
    for (const scale of FIT_SCALES) {
      await page.setContent(buildSlideHtml({ carousel: c, slide, index, total, scale, fontCss }), { waitUntil: "load", timeout: 30_000 });
      const badFonts = (await page.evaluate(FONT_CHECK)) as string[];
      if (badFonts.length) return { ok: false, error: `шрифты карточки не загрузились: ${badFonts.join(", ")}` };
      const fit = (await page.evaluate(MEASURE)) as { problems: string[]; overlap: boolean };
      last = fit.problems;
      if (last.length) continue;
      if (fit.overlap) {
        // номер позиционирован абсолютно и на раскладку текста не влияет — перемерять не нужно
        await page.setContent(buildSlideHtml({ carousel: c, slide, index, total, scale, fontCss, bignum: false }), { waitUntil: "load", timeout: 30_000 });
        await page.evaluate(FONT_CHECK);
      }
      const buffer = await page.screenshot({ type: "jpeg", quality: 90, clip: { x: 0, y: 0, width, height }, animations: "disabled", caret: "hide" });
      const info = jpegInfo(buffer);
      const problems = instagramImageProblems(buffer);
      if (!info || info.width !== width || info.height !== height || problems.length) {
        return { ok: false, error: `картинка не прошла проверку: ${problems.join(", ") || `размер ${info?.width}×${info?.height}`}` };
      }
      return { ok: true, buffer, scale, width, height };
    }
    return { ok: false, error: fitError(last) };
  } finally {
    await context.close().catch(() => {});
  }
}
