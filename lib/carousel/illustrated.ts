import crypto from "crypto";
import type { CarouselFormat, CarouselLanguage, DesignSettings, Slide } from "./types";
import { FORMATS, LANGUAGES } from "./limits";
import { emphasisParts, escapeHtml, stripEmphasis, typograph } from "./text";
import { FONT_FAMILY } from "./templates";
import { hexToRgba, isLightColor } from "./designShared";

/**
 * Карточка с иллюстрацией: картинка на весь кадр без растяжения (object-fit: cover), затемнение
 * под текстом и текстовый слой программно. Текст меняется без новой генерации картинки.
 * Модель разметку не пишет: тексты экранируются, скрипты и внешние загрузки запрещены CSP,
 * картинка и шрифты встраиваются data:URL.
 */

export const ILLUSTRATED_TEMPLATE_VERSION = 1;

type SlideContent = Pick<Slide, "kind" | "kicker" | "title" | "body" | "bullets" | "cta" | "image">;

export function designKey(d: DesignSettings): string {
  return JSON.stringify([d.accent, d.textColor, d.scrimColor, d.titleFont, d.author, d.logoFile ?? null]);
}

/** Отпечаток карточки: текст, оформление, выбранная версия иллюстрации, место текста, позиция. */
export function illustratedHash(c: { format: CarouselFormat; language: CarouselLanguage; design: DesignSettings }, slide: SlideContent, index: number, total: number): string {
  const img = slide.image;
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        "illustrated",
        ILLUSTRATED_TEMPLATE_VERSION,
        c.format,
        c.language,
        designKey(c.design),
        slide.kind,
        slide.kicker,
        slide.title,
        slide.body,
        slide.bullets,
        slide.cta,
        img?.textPlacement ?? "bottom",
        img?.currentId ?? null,
        index,
        total,
      ]),
    )
    .digest("hex");
}

export function buildIllustratedHtml(args: {
  format: CarouselFormat;
  language: CarouselLanguage;
  design: DesignSettings;
  slide: SlideContent;
  index: number;
  total: number;
  scale: number;
  fontCss: string;
  artDataUrl: string;
  logoDataUrl?: string | null;
}): string {
  const { format, language: lang, design: d, slide, index, total, scale, fontCss } = args;
  const { width: W, height: H } = FORMATS[format];
  const k = format === "square" ? 0.86 : 1;
  const t = (n: number) => Math.round(n * k * scale);
  const px = (n: number) => Math.round(n * k);
  const padX = px(76);
  const padY = px(64);
  const placement = slide.image?.textPlacement === "top" ? "top" : "bottom";
  const display = d.titleFont === "display";
  const titleSize = { cover: display ? 90 : 116, content: display ? 58 : 76, final: display ? 66 : 86 }[slide.kind];
  const zoneMax = Math.round(H * (slide.kind === "cover" ? 0.56 : 0.5));
  const ink = isLightColor(d.accent) ? "#111111" : "#FFFFFF";
  const scrim = (a: number) => hexToRgba(d.scrimColor, a);
  const gradientDir = placement === "bottom" ? "to top" : "to bottom";

  const plain = (s: string) => escapeHtml(typograph(stripEmphasis(s), lang));
  const rich = (s: string) =>
    emphasisParts(typograph(s, lang))
      .map((p) => (p.hl ? `<span class="hl">${escapeHtml(p.text)}</span>` : escapeHtml(p.text)))
      .join("");

  const kicker = slide.kicker ? `<div class="chip" data-fit="kicker">${plain(slide.kicker)}</div>` : "<div></div>";
  const counter = slide.kind === "cover" ? "" : `<div class="count">${index + 1}&nbsp;/&nbsp;${total}</div>`;
  const body = slide.body ? `<p class="body" data-fit="body">${plain(slide.body)}</p>` : "";
  let inner = "";
  if (slide.kind === "cover") inner = `<div class="bar"></div><h1 class="title" data-fit="title">${rich(slide.title)}</h1>${body}`;
  else if (slide.kind === "content") {
    const bullets = slide.bullets.length ? `<ul class="bullets" data-fit="bullets">${slide.bullets.map((b) => `<li>${plain(b)}</li>`).join("")}</ul>` : "";
    inner = `<h2 class="title" data-fit="title">${rich(slide.title)}</h2>${body}${bullets}`;
  } else {
    const cta = slide.cta ? `<div class="cta" data-fit="cta">${plain(slide.cta)}</div>` : "";
    inner = `<h2 class="title" data-fit="title">${rich(slide.title)}</h2>${body}${cta}`;
  }
  const brand = args.logoDataUrl
    ? `<img class="logo" src="${args.logoDataUrl}" alt="">`
    : d.author
      ? `<div class="handle" data-fit="footer">${plain(d.author)}</div>`
      : "<div></div>";
  const swipe = slide.kind === "final" ? "" : `<div class="swipe">${escapeHtml(LANGUAGES[lang].swipe)}<span class="chev"></span></div>`;
  const spacer = `<div class="spacer"></div>`;

  const shadow = `text-shadow:0 2px 18px ${scrim(0.55)};`;
  const css =
    `*{box-sizing:border-box;margin:0;padding:0}` +
    `html,body{width:${W}px;height:${H}px;overflow:hidden;background:${d.scrimColor}}` +
    `body{font-family:"${FONT_FAMILY.text}";color:${d.textColor};-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-kerning:normal;font-synthesis:none}` +
    `.slide{position:relative;width:${W}px;height:${H}px;padding:${padY}px ${padX}px;display:flex;flex-direction:column;overflow:hidden}` +
    `.art{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% ${placement === "bottom" ? 32 : 68}%;z-index:0}` +
    `.scrim{position:absolute;inset:0;z-index:1;background:linear-gradient(${gradientDir}, ${scrim(0.94)} 0%, ${scrim(0.86)} 30%, ${scrim(0.5)} 54%, ${scrim(0)} 74%)}` +
    `.topfade{position:absolute;left:0;right:0;${placement === "bottom" ? "top" : "bottom"}:0;height:${px(220)}px;z-index:1;background:linear-gradient(${placement === "bottom" ? "to bottom" : "to top"}, ${scrim(0.45)}, ${scrim(0)})}` +
    `.head,.content,.foot,.spacer{position:relative;z-index:2}` +
    `.spacer{flex:1 1 auto;min-height:${px(24)}px}` +
    `.head{display:flex;align-items:center;justify-content:space-between;gap:${px(20)}px;min-height:${px(60)}px}` +
    `.chip{max-width:${W - 2 * padX - px(170)}px;white-space:nowrap;overflow:hidden;font-family:"${FONT_FAMILY.condensed}";font-weight:700;font-size:${t(30)}px;line-height:1.25;letter-spacing:.06em;text-transform:uppercase;color:${d.textColor};background:${scrim(0.6)};border:${px(2)}px solid ${hexToRgba(d.accent, 0.7)};padding:${px(8)}px ${px(20)}px;border-radius:999px}` +
    `.count{margin-left:auto;font-family:"${FONT_FAMILY.condensed}";font-weight:700;font-size:${px(30)}px;letter-spacing:.08em;color:${d.textColor};background:${scrim(0.6)};padding:${px(6)}px ${px(16)}px;border-radius:999px}` +
    `.content{flex:0 1 auto;max-height:${zoneMax}px;overflow:hidden;display:flex;flex-direction:column;gap:${t(26)}px;padding:${px(10)}px 0 ${px(16)}px}` +
    `.bar{flex:none;width:${px(110)}px;height:${px(10)}px;border-radius:${px(6)}px;background:${d.accent}}` +
    `.title{font-family:"${display ? FONT_FAMILY.display : FONT_FAMILY.condensed}";font-weight:${display ? 900 : 700};font-size:${t(titleSize)}px;line-height:${display ? 1.07 : 1.04};letter-spacing:${display ? "-0.01em" : "0.005em"};text-transform:${display ? "none" : "uppercase"};text-wrap:balance;overflow-wrap:normal;word-break:normal;${shadow}}` +
    `.hl{color:${d.accent}}` +
    `.body{font-size:${t(38)}px;line-height:1.38;opacity:.94;text-wrap:pretty;${shadow}}` +
    `.bullets{list-style:none;display:flex;flex-direction:column;gap:${t(16)}px}` +
    `.bullets li{position:relative;padding-left:${t(40)}px;font-size:${t(36)}px;line-height:1.32;text-wrap:pretty;${shadow}}` +
    `.bullets li::before{content:"";position:absolute;left:0;top:.66em;transform:translateY(-50%);width:${t(14)}px;height:${t(14)}px;border-radius:50%;background:${d.accent}}` +
    `.cta{align-self:flex-start;max-width:100%;font-weight:700;font-size:${t(34)}px;line-height:1.25;color:${ink};background:${d.accent};padding:${t(16)}px ${t(30)}px;border-radius:999px}` +
    `.foot{display:flex;align-items:center;justify-content:space-between;gap:${px(20)}px;min-height:${px(60)}px}` +
    `.handle{max-width:${W - 2 * padX - px(220)}px;white-space:nowrap;overflow:hidden;font-weight:700;font-size:${px(28)}px;${shadow}}` +
    `.logo{max-height:${px(56)}px;max-width:${px(260)}px;object-fit:contain}` +
    `.swipe{margin-left:auto;display:flex;align-items:center;gap:${px(14)}px;font-family:"${FONT_FAMILY.condensed}";font-weight:700;font-size:${px(30)}px;letter-spacing:.1em;text-transform:uppercase;${shadow}}` +
    `.chev{width:${px(18)}px;height:${px(18)}px;border-top:${px(4)}px solid ${d.accent};border-right:${px(4)}px solid ${d.accent};transform:rotate(45deg);margin-right:${px(6)}px}`;

  const middle = placement === "bottom" ? `${spacer}<section class="content">${inner}</section>` : `<section class="content">${inner}</section>${spacer}`;
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">` +
    `<style>${fontCss}${css}</style></head><body>` +
    `<main class="slide kind-${slide.kind} place-${placement}">` +
    `<img class="art" src="${args.artDataUrl}" alt=""><div class="scrim"></div><div class="topfade"></div>` +
    `<header class="head">${kicker}${counter}</header>${middle}` +
    `<footer class="foot">${brand}${swipe}</footer>` +
    `</main></body></html>`
  );
}
