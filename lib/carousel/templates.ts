import crypto from "crypto";
import type { Carousel, Slide } from "./types";
import { FORMATS, LANGUAGES } from "./limits";
import { getStyle, type CarouselStyle } from "./styles";
import { emphasisParts, escapeHtml, stripEmphasis, typograph } from "./text";

/**
 * Шаблон карточки: HTML и CSS строятся из структурированных полей. Модель разметку не
 * пишет — её тексты экранируются, скрипты и любые внешние загрузки запрещены политикой
 * CSP (рендерер к тому же отключает сеть). Меняется вид — растёт TEMPLATE_VERSION, и
 * слайды перерендериваются по отпечатку.
 */
export const TEMPLATE_VERSION = 1;

export const FONT_FAMILY = { display: "GudiniCarDisplay", condensed: "GudiniCarCondensed", text: "GudiniCarText" } as const;

/** Шаги уменьшения кегля, если текст не поместился. Мельче 74 % карточка плохо читается с телефона. */
export const FIT_SCALES = [1, 0.93, 0.86, 0.8, 0.74];

export type TemplateCarousel = Pick<Carousel, "style" | "format" | "language" | "footer">;
type SlideContent = Pick<Slide, "kind" | "kicker" | "title" | "body" | "bullets" | "cta">;

export function slideHash(c: TemplateCarousel, slide: SlideContent, index: number, total: number): string {
  const payload = JSON.stringify([
    TEMPLATE_VERSION,
    c.style,
    c.format,
    c.language,
    c.footer,
    slide.kind,
    slide.kicker,
    slide.title,
    slide.body,
    slide.bullets,
    slide.cta,
    index,
    total,
  ]);
  return crypto.createHash("sha1").update(payload).digest("hex");
}

export type FontData = { display: string; condensed: string; text: string; textBold: string };

/** Шрифты встраиваются в страницу base64: загрузка не зависит ни от сети, ни от системных шрифтов. */
export function fontFaceCss(f: FontData): string {
  const face = (family: string, weight: number, b64: string) =>
    `@font-face{font-family:"${family}";src:url(data:font/ttf;base64,${b64}) format("truetype");font-weight:${weight};font-style:normal;font-display:block}`;
  return (
    face(FONT_FAMILY.display, 900, f.display) +
    face(FONT_FAMILY.condensed, 700, f.condensed) +
    face(FONT_FAMILY.text, 400, f.text) +
    face(FONT_FAMILY.text, 700, f.textBold)
  );
}

type Geometry = { W: number; H: number; padX: number; padTop: number; padBottom: number; k: number };

/**
 * Поля: по бокам 100 px — сетка профиля Instagram показывает превью 3:4 и срезает с боков
 * около 34 px, текст остаётся внутри при любой обрезке.
 */
function geometry(format: Carousel["format"]): Geometry {
  const { width: W, height: H } = FORMATS[format];
  return format === "square" ? { W, H, padX: 92, padTop: 80, padBottom: 80, k: 0.86 } : { W, H, padX: 100, padTop: 96, padBottom: 96, k: 1 };
}

function decoCss(style: CarouselStyle, g: Geometry): string {
  const d = (n: number) => Math.round(n * g.k);
  switch (style.deco) {
    case "rings":
      return (
        `.deco::before{content:"";position:absolute;width:${d(860)}px;height:${d(860)}px;right:-${d(380)}px;top:-${d(400)}px;border-radius:50%;border:${d(3)}px solid ${style.line}}` +
        `.deco::after{content:"";position:absolute;width:${d(560)}px;height:${d(560)}px;right:-${d(230)}px;top:-${d(250)}px;border-radius:50%;border:${d(3)}px solid ${style.accent};opacity:.45}`
      );
    case "paper":
      return (
        `.deco::before{content:"";position:absolute;left:0;top:0;bottom:0;width:${d(16)}px;background:${style.accent}}` +
        `.deco::after{content:"";position:absolute;width:${d(720)}px;height:${d(720)}px;right:-${d(320)}px;bottom:-${d(340)}px;border-radius:50%;background:${style.line}}`
      );
    case "glow":
      return (
        `.deco::before{content:"";position:absolute;width:${d(980)}px;height:${d(980)}px;left:-${d(460)}px;top:-${d(420)}px;border-radius:50%;background:radial-gradient(closest-side, rgba(255,255,255,.32), rgba(255,255,255,0))}` +
        `.deco::after{content:"";position:absolute;width:${d(820)}px;height:${d(820)}px;right:-${d(320)}px;bottom:-${d(300)}px;border-radius:50%;background:radial-gradient(closest-side, rgba(255,227,110,.30), rgba(255,227,110,0))}`
      );
    case "grid":
      return `.deco{background-image:linear-gradient(${style.line} ${d(2)}px, transparent ${d(2)}px),linear-gradient(90deg, ${style.line} ${d(2)}px, transparent ${d(2)}px);background-size:${d(90)}px ${d(90)}px;background-position:${g.padX}px ${g.padTop}px;-webkit-mask-image:linear-gradient(180deg, #000 0%, transparent 62%);mask-image:linear-gradient(180deg, #000 0%, transparent 62%)}`;
    case "stripe":
      return (
        `.deco::before{content:"";position:absolute;left:0;right:0;top:0;height:${d(24)}px;background:${style.accent}}` +
        `.deco::after{content:"";position:absolute;left:0;right:0;bottom:0;height:${d(12)}px;background:${style.text}}`
      );
  }
}

export function buildSlideHtml(args: {
  carousel: TemplateCarousel;
  slide: SlideContent;
  index: number;
  total: number;
  scale: number;
  fontCss: string;
  /** false — без крупного номера: рендер убирает его, если текст до него доходит */
  bignum?: boolean;
}): string {
  const { carousel: c, slide, index, total, scale, fontCss } = args;
  const style = getStyle(c.style);
  const g = geometry(c.format);
  const lang = c.language;
  const t = (n: number) => Math.round(n * g.k * scale);
  const d = (n: number) => Math.round(n * g.k);
  const display = style.titleFont === "display";
  const titleFamily = display ? FONT_FAMILY.display : FONT_FAMILY.condensed;
  const titleSize = { cover: display ? 98 : 124, content: display ? 62 : 80, final: display ? 74 : 92 }[slide.kind];
  const marker = style.emphasis === "marker";
  // на белом фоне жёлтые точки и полоски не видны — у маркерного стиля они цвета текста
  const mark = marker ? style.text : style.accent;
  const ctaBg = marker ? style.text : style.accent;
  const ctaInk = marker ? "#ffffff" : style.accentInk;
  const shadow = style.id === "sunset" ? "text-shadow:0 2px 16px rgba(45,23,69,.28);" : "";

  const plain = (s: string) => escapeHtml(typograph(stripEmphasis(s), lang));
  const rich = (s: string) =>
    emphasisParts(typograph(s, lang))
      .map((p) => (p.hl ? `<span class="hl">${escapeHtml(p.text)}</span>` : escapeHtml(p.text)))
      .join("");

  const kicker = slide.kicker ? `<div class="chip" data-fit="kicker">${plain(slide.kicker)}</div>` : "<div></div>";
  const counter = slide.kind === "cover" ? "" : `<div class="count">${index + 1}&nbsp;/&nbsp;${total}</div>`;
  const body = (cls: string) => (slide.body ? `<p class="${cls}" data-fit="body">${plain(slide.body)}</p>` : "");

  let inner: string;
  if (slide.kind === "cover") {
    inner = `<div class="bar"></div><h1 class="title" data-fit="title">${rich(slide.title)}</h1>${body("lead")}`;
  } else if (slide.kind === "content") {
    const bullets = slide.bullets.length ? `<ul class="bullets" data-fit="bullets">${slide.bullets.map((b) => `<li>${plain(b)}</li>`).join("")}</ul>` : "";
    inner = `<h2 class="title" data-fit="title">${rich(slide.title)}</h2>${body("body")}${bullets}`;
  } else {
    const cta = slide.cta ? `<div class="cta" data-fit="cta">${plain(slide.cta)}</div>` : "";
    inner = `<h2 class="title" data-fit="title">${rich(slide.title)}</h2>${body("body")}${cta}`;
  }

  const footer = c.footer ? `<div class="handle" data-fit="footer">${plain(c.footer)}</div>` : "<div></div>";
  const swipe = slide.kind === "final" ? "" : `<div class="swipe">${escapeHtml(LANGUAGES[lang].swipe)}<span class="chev"></span></div>`;
  const bignum = slide.kind === "content" && args.bignum !== false ? `<div class="bignum" aria-hidden="true">${String(index).padStart(2, "0")}</div>` : "";

  const css =
    `*{box-sizing:border-box;margin:0;padding:0}` +
    `html,body{width:${g.W}px;height:${g.H}px;overflow:hidden;background:#000}` +
    `body{font-family:"${FONT_FAMILY.text}";color:${style.text};-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-kerning:normal;font-synthesis:none}` +
    `.slide{position:relative;width:${g.W}px;height:${g.H}px;padding:${g.padTop}px ${g.padX}px ${g.padBottom}px;display:flex;flex-direction:column;background:${style.background};overflow:hidden}` +
    `.deco{position:absolute;inset:0;z-index:0;pointer-events:none}` +
    decoCss(style, g) +
    // крупный номер — над нижней строкой: у «2» широкая нижняя черта, и на подписи «Листай» она читалась плашкой
    `.bignum{position:absolute;right:${d(60)}px;bottom:${g.padBottom + d(64) + d(28)}px;z-index:0;font-family:"${FONT_FAMILY.display}";font-weight:900;font-size:${d(340)}px;line-height:.78;letter-spacing:-.04em;color:${mark};opacity:${marker ? 0.07 : style.dark ? 0.1 : 0.12}}` +
    `.head,.content,.foot{position:relative;z-index:1}` +
    `.head{display:flex;align-items:center;justify-content:space-between;gap:${d(24)}px;min-height:${d(64)}px}` +
    `.chip{max-width:${g.W - 2 * g.padX - d(170)}px;white-space:nowrap;overflow:hidden;font-family:"${FONT_FAMILY.condensed}";font-weight:700;font-size:${t(32)}px;line-height:1.25;letter-spacing:.06em;text-transform:uppercase;color:${style.chipText};background:${style.chipBg};padding:${d(10)}px ${d(22)}px;border-radius:999px}` +
    `.count{margin-left:auto;font-family:"${FONT_FAMILY.condensed}";font-weight:700;font-size:${d(32)}px;letter-spacing:.08em;color:${style.dim}}` +
    `.content{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;justify-content:safe center;gap:${t(34)}px;overflow:hidden;padding:${d(18)}px 0 ${d(24)}px}` +
    `.kind-cover .content{justify-content:safe flex-end;padding-bottom:${d(40)}px}` +
    `.bar{flex:none;width:${d(120)}px;height:${d(12)}px;border-radius:${d(6)}px;background:${mark}}` +
    `.title{font-family:"${titleFamily}";font-weight:${display ? 900 : 700};font-size:${t(titleSize)}px;line-height:${display ? 1.06 : 1.04};letter-spacing:${display ? "-0.01em" : "0.005em"};text-transform:${style.titleUpper ? "uppercase" : "none"};text-wrap:balance;overflow-wrap:normal;word-break:normal;hyphens:manual;${shadow}}` +
    `.hl{${marker ? `background:linear-gradient(transparent 10%, ${style.accent} 10%, ${style.accent} 92%, transparent 92%);-webkit-box-decoration-break:clone;box-decoration-break:clone;padding:0 .08em` : `color:${style.accent}`}}` +
    `.lead{font-size:${t(42)}px;line-height:1.34;color:${style.dim};text-wrap:pretty;${shadow}}` +
    `.body{font-size:${t(40)}px;line-height:1.4;color:${style.dim};text-wrap:pretty;${shadow}}` +
    `.bullets{list-style:none;display:flex;flex-direction:column;gap:${t(22)}px}` +
    `.bullets li{position:relative;padding-left:${t(46)}px;font-size:${t(38)}px;line-height:1.34;color:${style.text};text-wrap:pretty;${shadow}}` +
    `.bullets li::before{content:"";position:absolute;left:0;top:.67em;transform:translateY(-50%);width:${t(16)}px;height:${t(16)}px;border-radius:${marker ? "2px" : "50%"};background:${mark}}` +
    `.cta{align-self:flex-start;max-width:100%;font-weight:700;font-size:${t(36)}px;line-height:1.25;color:${ctaInk};background:${ctaBg};padding:${t(18)}px ${t(34)}px;border-radius:999px}` +
    `.foot{display:flex;align-items:center;justify-content:space-between;gap:${d(20)}px;min-height:${d(64)}px}` +
    `.handle{max-width:${g.W - 2 * g.padX - d(220)}px;white-space:nowrap;overflow:hidden;font-weight:700;font-size:${d(28)}px;color:${style.dim}}` +
    `.swipe{margin-left:auto;display:flex;align-items:center;gap:${d(16)}px;font-family:"${FONT_FAMILY.condensed}";font-weight:700;font-size:${d(30)}px;letter-spacing:.1em;text-transform:uppercase;color:${style.text}}` +
    `.chev{width:${d(18)}px;height:${d(18)}px;border-top:${d(4)}px solid ${mark};border-right:${d(4)}px solid ${mark};transform:rotate(45deg);margin-right:${d(6)}px}`;

  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">` +
    `<style>${fontCss}${css}</style></head><body>` +
    `<main class="slide kind-${slide.kind}"><div class="deco" aria-hidden="true"></div>${bignum}` +
    `<header class="head">${kicker}${counter}</header>` +
    `<section class="content">${inner}</section>` +
    `<footer class="foot">${footer}${swipe}</footer>` +
    `</main></body></html>`
  );
}
