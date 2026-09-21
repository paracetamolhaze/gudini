import sharp from "sharp";
import type { Font } from "opentype.js";
import { loadFonts, measure } from "../images/fonts.js";

/**
 * PnL card of one closed trade, drawn from the fills Hyperliquid reports for the wallet. It is the
 * owner's own card (not an imitation of the exchange UI): every number on it comes from the API,
 * and the post can be checked against the wallet's public history. Glyphs are converted to SVG
 * paths, so rendering does not depend on system fonts.
 */
export interface TradeCardInput {
  coin: string;
  direction: "LONG" | "SHORT";
  leverage: number | null;
  entryPx: number;
  exitPx: number;
  netPnl: number;
  roePct: number | null;
  movePct: number | null;
  openedAt: Date;
  closedAt: Date;
  size: number;
  /** Closing prices over the life of the trade (padded a little on both sides). */
  candles: Array<{ t: number; c: number }>;
}

export interface TradeCardOptions {
  showUsd: boolean;
  showSize: boolean;
  /** Full wallet address (0x + 40 chars) or null to leave it off the card: the card is meant to be checkable. */
  wallet: string | null;
  handle: string;
  language: "ru" | "en";
  timezone: string;
}

export const CARD_WIDTH = 1440;
export const CARD_HEIGHT = 810;

const C = {
  bgTop: "#0a1014",
  bgBottom: "#0c191b",
  panel: "#0f1d20",
  line: "#1f3337",
  text: "#f1f5f4",
  muted: "#8aa0a1",
  dim: "#5d7375",
  brand: "#7fe3cc",
  up: "#4fe0a5",
  upSoft: "#123a2d",
  down: "#ff7b7b",
  downSoft: "#3d1c20",
  chip: "#182a2d",
};

const LABELS = {
  ru: { entry: "ВХОД", exit: "ВЫХОД", held: "В СДЕЛКЕ", size: "РАЗМЕР", move: "ДВИЖЕНИЕ ЦЕНЫ", roe: "ROE", pnl: "PnL", source: "данные: Hyperliquid API", perp: "PERP", d: "д", h: "ч", m: "м" },
  en: { entry: "ENTRY", exit: "EXIT", held: "HELD", size: "SIZE", move: "PRICE MOVE", roe: "ROE", pnl: "PnL", source: "data: Hyperliquid API", perp: "PERP", d: "d", h: "h", m: "m" },
} as const;

const NBSP = String.fromCharCode(160);

/** Public position explorer: the wallet address is appended to it. */
const EXPLORER = "app.hyperliquid.xyz/explorer/address/";

/** 63540 → "63 540", 0.004213 → "0.004213", 212.4 → "212.40". */
export function formatPrice(v: number): string {
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? (Number.isInteger(v) ? 0 : 1) : abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 7;
  const fixed = v.toFixed(digits);
  const [int, frac] = fixed.split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const trimmed = frac ? frac.replace(/0+$/, "") : "";
  return trimmed ? `${grouped}.${trimmed.padEnd(abs >= 100 ? 0 : 2, "0")}` : grouped;
}

export function formatUsd(v: number): string {
  const abs = Math.abs(v);
  const body = abs >= 1000 ? Math.round(abs).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) : abs.toFixed(2);
  return `${v < 0 ? "-" : "+"}$${body}`;
}

export function formatPct(v: number): string {
  const abs = Math.abs(v);
  return `${v < 0 ? "-" : "+"}${abs >= 100 ? abs.toFixed(0) : abs.toFixed(1)}%`;
}

export function formatDuration(ms: number, l: { d: string; h: string; m: string }): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d}${l.d} ${h}${l.h}`;
  if (h > 0) return `${h}${l.h} ${m}${l.m}`;
  return `${m}${l.m}`;
}

function formatSize(v: number): string {
  return v >= 100 ? Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) : v >= 1 ? v.toFixed(2) : v.toPrecision(3);
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

class Canvas {
  readonly parts: string[] = [];
  constructor(private readonly regular: Font, private readonly bold: Font) {}

  width(text: string, px: number, bold = false, tracking = 0): number {
    return measure(bold ? this.bold : this.regular, text, px) + tracking * Math.max(0, text.length - 1);
  }

  /** Draws text with its baseline at y; returns the drawn width. */
  text(text: string, x: number, y: number, px: number, fill: string, opts: { bold?: boolean; align?: "left" | "right" | "center"; tracking?: number; opacity?: number } = {}): number {
    const font = opts.bold ? this.bold : this.regular;
    const tracking = opts.tracking ?? 0;
    const w = this.width(text, px, opts.bold, tracking);
    let cx = opts.align === "right" ? x - w : opts.align === "center" ? x - w / 2 : x;
    const op = opts.opacity !== undefined ? ` fill-opacity="${opts.opacity}"` : "";
    if (!tracking) {
      this.parts.push(`<path d="${esc(font.getPath(text, cx, y, px).toPathData(2))}" fill="${fill}"${op}/>`);
      return w;
    }
    for (const ch of text) {
      this.parts.push(`<path d="${esc(font.getPath(ch, cx, y, px).toPathData(2))}" fill="${fill}"${op}/>`);
      cx += measure(font, ch, px) + tracking;
    }
    return w;
  }

  chip(label: string, x: number, y: number, px: number, fg: string, bg: string): number {
    const padX = px * 0.62;
    const h = px * 1.75;
    const w = this.width(label, px, true, 1) + padX * 2;
    this.parts.push(`<rect x="${x}" y="${y}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(h / 2).toFixed(1)}" fill="${bg}"/>`);
    this.text(label, x + padX, y + h * 0.68, px, fg, { bold: true, tracking: 1 });
    return w;
  }

  raw(svg: string): void {
    this.parts.push(svg);
  }
}

function chart(cv: Canvas, input: TradeCardInput, box: { x: number; y: number; w: number; h: number }, accent: string): void {
  const pts = input.candles.filter((c) => Number.isFinite(c.c) && c.c > 0);
  cv.raw(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="22" fill="${C.panel}" stroke="${C.line}" stroke-width="1.5"/>`);
  if (pts.length < 4) return;
  const pad = { l: 26, r: 26, t: 44, b: 44 };
  const x0 = box.x + pad.l;
  const x1 = box.x + box.w - pad.r;
  const y0 = box.y + pad.t;
  const y1 = box.y + box.h - pad.b;
  const tMin = pts[0]!.t;
  const tMax = pts[pts.length - 1]!.t;
  const values = [...pts.map((p) => p.c), input.entryPx, input.exitPx];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const span = hi - lo || hi * 0.01 || 1;
  lo -= span * 0.08;
  hi += span * 0.08;
  const X = (t: number) => x0 + ((Math.min(tMax, Math.max(tMin, t)) - tMin) / Math.max(1, tMax - tMin)) * (x1 - x0);
  const Y = (v: number) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)} ${Y(p.c).toFixed(1)}`).join(" ");
  cv.raw(`<path d="${line} L${x1.toFixed(1)} ${y1} L${x0.toFixed(1)} ${y1} Z" fill="url(#area)"/>`);
  cv.raw(`<path d="${line}" fill="none" stroke="${accent}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>`);
  const marks: Array<{ v: number; t: number; label: string; color: string }> = [
    { v: input.entryPx, t: input.openedAt.getTime(), label: formatPrice(input.entryPx), color: C.muted },
    { v: input.exitPx, t: input.closedAt.getTime(), label: formatPrice(input.exitPx), color: accent },
  ];
  // Keep the two price tags from sitting on top of each other when entry and exit are close.
  const tagY = marks.map((m) => Y(m.v));
  if (Math.abs(tagY[0]! - tagY[1]!) < 30) {
    const mid = (tagY[0]! + tagY[1]!) / 2;
    const upFirst = tagY[0]! <= tagY[1]!;
    tagY[0] = mid + (upFirst ? -16 : 16);
    tagY[1] = mid + (upFirst ? 16 : -16);
  }
  marks.forEach((m, i) => {
    const y = Y(m.v);
    cv.raw(`<path d="M${x0} ${y.toFixed(1)} L${x1} ${y.toFixed(1)}" stroke="${m.color}" stroke-width="1.4" stroke-dasharray="7 7" stroke-opacity="0.75"/>`);
    cv.raw(`<circle cx="${X(m.t).toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="${C.panel}" stroke="${m.color}" stroke-width="3.5"/>`);
    const w = cv.width(m.label, 20, true) + 20;
    const ty = Math.min(y1 - 4, Math.max(y0 + 12, tagY[i]!));
    cv.raw(`<rect x="${(x1 - w).toFixed(1)}" y="${(ty - 16).toFixed(1)}" width="${w.toFixed(1)}" height="30" rx="8" fill="${C.bgTop}" stroke="${m.color}" stroke-width="1.2"/>`);
    cv.text(m.label, x1 - 10, ty + 6, 20, m.color, { bold: true, align: "right" });
  });
}

export async function renderTradeCard(input: TradeCardInput, opts: TradeCardOptions): Promise<Buffer> {
  const fonts = await loadFonts();
  const cv = new Canvas(fonts.regular, fonts.bold);
  const l = LABELS[opts.language];
  const win = input.netPnl >= 0;
  const accent = win ? C.up : C.down;
  const W = CARD_WIDTH;
  const H = CARD_HEIGHT;
  const M = 64;
  const hasChart = input.candles.length >= 4;
  const leftW = hasChart ? 640 : W - M * 2;

  // header
  const brandW = cv.text("HYPERLIQUID", M, M + 26, 26, C.brand, { bold: true, tracking: 3 });
  cv.text(`·  ${l.perp}`, M + brandW + 16, M + 26, 24, C.dim, { tracking: 2 });
  const date = input.closedAt.toLocaleDateString(opts.language === "ru" ? "ru-RU" : "en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: opts.timezone });
  cv.text(date, W - M, M + 26, 24, C.muted, { align: "right" });

  // instrument
  const coinY = M + 150;
  const coinW = cv.text(input.coin, M, coinY, 104, C.text, { bold: true });
  let chipX = M + coinW + 26;
  chipX += cv.chip(input.direction, chipX, coinY - 62, 26, input.direction === "LONG" ? C.up : C.down, input.direction === "LONG" ? C.upSoft : C.downSoft) + 12;
  if (input.leverage) cv.chip(`x${Number.isInteger(input.leverage) ? input.leverage : input.leverage.toFixed(1)}`, chipX, coinY - 62, 26, C.text, C.chip);

  // headline number: ROE when leverage is known, otherwise the raw price move
  const headline = input.roePct ?? input.movePct ?? 0;
  const headLabel = input.roePct !== null ? l.roe : l.move;
  cv.text(headLabel, M, coinY + 84, 24, C.muted, { tracking: 3 });
  const headText = formatPct(headline);
  let headPx = 176;
  while (cv.width(headText, headPx, true) > leftW && headPx > 90) headPx -= 8;
  cv.text(headText, M - 4, coinY + 84 + headPx * 0.92, headPx, accent, { bold: true });
  const afterHead = coinY + 84 + headPx * 0.92;
  if (opts.showUsd) {
    const pw = cv.text(l.pnl, M, afterHead + 66, 30, C.muted, { tracking: 2 });
    cv.text(formatUsd(input.netPnl), M + pw + 18, afterHead + 66, 44, C.text, { bold: true });
  }

  // stats
  const stats: Array<[string, string]> = [
    [l.entry, formatPrice(input.entryPx)],
    [l.exit, formatPrice(input.exitPx)],
    [l.held, formatDuration(input.closedAt.getTime() - input.openedAt.getTime(), l)],
  ];
  if (opts.showSize) stats.push([l.size, `${formatSize(input.size)} ${input.coin}`]);
  if (input.roePct !== null && input.movePct !== null) stats.push([l.move, formatPct(input.movePct)]);
  const statsY = H - M - 96;
  // Next to the chart there is room for three columns — four when the size is shown: it is part of the proof.
  const shown = stats.slice(0, hasChart ? (opts.showSize ? 4 : 3) : 5);
  const colW = leftW / shown.length;
  shown.forEach(([label, value], i) => {
    const x = M + i * colW;
    cv.text(label, x, statsY, 20, C.dim, { tracking: 2.5 });
    let px = 38;
    while (cv.width(value, px, true) > colW - 26 && px > 22) px -= 2;
    cv.text(value, x, statsY + 50, px, C.text, { bold: true });
  });

  if (hasChart) chart(cv, input, { x: M + leftW + 40, y: M + 74, w: W - M * 2 - leftW - 40, h: H - M * 2 - 74 - 66 }, accent);

  // footer: my handle on the left, on the right the address and the link anyone can open to check the trade
  const footY = H - M - 22;
  cv.raw(`<path d="M${M} ${footY} L${W - M} ${footY}" stroke="${C.line}" stroke-width="1.5"/>`);
  const raw = opts.handle.trim();
  const handle = raw ? (raw.startsWith("@") ? raw : `@${raw}`) : "";
  // The handle never takes more than a third of the footer, so a long name cannot push the address off the card.
  let handlePx = 24;
  while (handle && cv.width(handle, handlePx, true) > (W - M * 2) * 0.34 && handlePx > 14) handlePx -= 1;
  const handleW = handle ? cv.width(handle, handlePx, true) : 0;
  const avail = W - M * 2 - (handleW ? handleW + 40 : 0);
  const drawHandle = (baseline: number): void => {
    if (handle) cv.text(handle, M, baseline, handlePx, C.text, { bold: true });
  };
  if (opts.wallet) {
    let px = 22;
    while (cv.width(`${EXPLORER}${opts.wallet}`, px) > avail && px > 16) px -= 1;
    if (cv.width(`${EXPLORER}${opts.wallet}`, px) <= avail) {
      drawHandle(footY + 34);
      const addrW = cv.text(opts.wallet, W - M, footY + 34, px, C.muted, { align: "right" });
      cv.text(EXPLORER, W - M - addrW, footY + 34, px, C.dim, { align: "right" });
    } else {
      // Does not fit in one line next to the handle: the link wraps and the address keeps a line of its own.
      let wrapPx = 20;
      while (cv.width(opts.wallet, wrapPx) > avail && wrapPx > 13) wrapPx -= 1;
      drawHandle(footY + 42);
      cv.text(EXPLORER, W - M, footY + 26, wrapPx, C.dim, { align: "right" });
      cv.text(opts.wallet, W - M, footY + 26 + wrapPx * 1.5, wrapPx, C.muted, { align: "right" });
    }
  } else {
    drawHandle(footY + 34);
    cv.text(l.source, W - M, footY + 34, 22, C.dim, { align: "right" });
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bgTop}"/><stop offset="1" stop-color="${C.bgBottom}"/></linearGradient>
<radialGradient id="glow" cx="0.12" cy="0.55" r="0.6"><stop offset="0" stop-color="${accent}" stop-opacity="0.16"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
<linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity="0.30"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
${cv.parts.join("\n")}
</svg>`;
  return sharp(Buffer.from(svg)).flatten({ background: C.bgTop }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

export const shortWallet = (wallet: string): string => (wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet);
