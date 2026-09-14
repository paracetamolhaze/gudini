import sharp from "sharp";
import type { Font } from "opentype.js";
import { loadFonts, measure } from "./fonts.js";
import { toPixels } from "./inpaint.js";
import type { PlacedBlock } from "./schemas.js";

/**
 * Draw the Russian text into each translated box: wrap into lines, pick the largest font size
 * that fits (never below minFontPx), fall back to the shorter translation, keep alignment and
 * colour. Glyphs become SVG paths (opentype.js), so rendering does not depend on system fonts.
 */
export interface RenderOptions {
  minFontPx: number;
  /** Extra shrink allowed below the original size estimate (0.55 = down to 55%). */
  minScale?: number;
}

export interface FitResult {
  lines: string[];
  fontPx: number;
  fits: boolean;
  usedShorter: boolean;
}

export function wrapLines(font: Font, text: string, fontPx: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (measure(font, candidate, fontPx) <= maxWidth || !cur) cur = candidate;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function fitText(font: Font, primary: string, shorter: string | undefined, box: { w: number; h: number }, startPx: number, opts: RenderOptions): FitResult {
  const lineHeight = 1.18;
  const minPx = Math.max(opts.minFontPx, Math.round(startPx * (opts.minScale ?? 0.55)));
  const tryText = (text: string, usedShorter: boolean): FitResult | null => {
    for (let px = Math.round(startPx); px >= minPx; px -= Math.max(1, Math.round(px * 0.06))) {
      const lines = wrapLines(font, text, px, box.w);
      const height = lines.length * px * lineHeight;
      const widest = Math.max(...lines.map((l) => measure(font, l, px)));
      if (height <= box.h * 1.08 && widest <= box.w) return { lines, fontPx: px, fits: true, usedShorter };
    }
    return null;
  };
  const a = tryText(primary, false);
  if (a) return a;
  if (shorter && shorter !== primary) {
    const b = tryText(shorter, true);
    if (b) return b;
  }
  // Overflow: render at the minimum size anyway so a human can judge, flagged for QA.
  const text = shorter && shorter.length < primary.length ? shorter : primary;
  return { lines: wrapLines(font, text, minPx, box.w), fontPx: minPx, fits: false, usedShorter: text === shorter };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function renderBlocks(inpainted: Buffer, blocks: PlacedBlock[], width: number, height: number, opts: RenderOptions): Promise<{ image: Buffer; blocks: PlacedBlock[] }> {
  const fonts = await loadFonts();
  const paths: string[] = [];
  const out: PlacedBlock[] = [];
  for (const b of blocks) {
    if (!b.translate || !b.translation) {
      out.push(b);
      continue;
    }
    const box = toPixels(b.bbox, width, height, 0.02);
    const font = b.bold || b.role === "headline" ? fonts.bold : fonts.regular;
    // The model reports cap height in grid units; a font size is ~1.4× the cap height.
    const capPx = (b.fontSize / 1000) * height;
    const startPx = Math.max(opts.minFontPx, Math.min(box.h / Math.max(1, b.lines) / 1.18, capPx * 1.4));
    const fit = fitText(font, b.translation, b.shorter, { w: box.w, h: box.h }, startPx, opts);
    const lineH = fit.fontPx * 1.18;
    const totalH = fit.lines.length * lineH;
    const yStart = box.y + Math.max(0, (box.h - totalH) / 2) + fit.fontPx * 0.92;
    fit.lines.forEach((line, i) => {
      const w = measure(font, line, fit.fontPx);
      const x = b.alignment === "center" ? box.x + (box.w - w) / 2 : b.alignment === "right" ? box.x + box.w - w : box.x;
      const y = yStart + i * lineH;
      const d = font.getPath(line, x, y, fit.fontPx).toPathData(2);
      const transform = b.rotation ? ` transform="rotate(${b.rotation} ${box.x + box.w / 2} ${box.y + box.h / 2})"` : "";
      paths.push(`<path d="${escapeXml(d)}" fill="${b.color}"${transform}/>`);
    });
    out.push({ ...b, rendered: { fontPx: fit.fontPx, lines: fit.lines, usedShorter: fit.usedShorter, overflow: !fit.fits } });
  }
  if (!paths.length) return { image: inpainted, blocks: out };
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths.join("")}</svg>`);
  const image = await sharp(inpainted).composite([{ input: svg, left: 0, top: 0 }]).png().toBuffer();
  return { image, blocks: out };
}

/** Final export for Threads: JPEG ≤ 1440 px wide, sRGB, no alpha. */
export async function finalizeForThreads(image: Buffer): Promise<Buffer> {
  return sharp(image).resize({ width: 1440, withoutEnlargement: true, fit: "inside" }).flatten({ background: "#ffffff" }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}
