import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import opentype, { type Font } from "opentype.js";

/**
 * Cyrillic-capable fonts for rendering. Docker ships DejaVu (FONT_DIR); a Windows dev box falls
 * back to Arial. Glyphs are converted to SVG paths, so the renderer never depends on fontconfig.
 */
const CANDIDATES: Array<{ regular: string; bold: string }> = [
  { regular: "DejaVuSans.ttf", bold: "DejaVuSans-Bold.ttf" },
  { regular: "LiberationSans-Regular.ttf", bold: "LiberationSans-Bold.ttf" },
  { regular: "arial.ttf", bold: "arialbd.ttf" },
  { regular: "segoeui.ttf", bold: "segoeuib.ttf" },
];

const DIRS = [
  process.env.FONT_DIR,
  "/usr/share/fonts/truetype/dejavu",
  "/usr/share/fonts/truetype/liberation",
  "C:/Windows/Fonts",
  "/Library/Fonts",
  "/System/Library/Fonts/Supplemental",
].filter((d): d is string => Boolean(d));

export interface FontPair {
  regular: Font;
  bold: Font;
  regularPath: string;
  boldPath: string;
}

let cached: FontPair | null = null;

export function findFontPaths(): { regular: string; bold: string } | null {
  if (process.env.FONT_REGULAR && process.env.FONT_BOLD && existsSync(process.env.FONT_REGULAR) && existsSync(process.env.FONT_BOLD)) {
    return { regular: process.env.FONT_REGULAR, bold: process.env.FONT_BOLD };
  }
  for (const dir of DIRS) {
    for (const c of CANDIDATES) {
      const regular = path.join(dir, c.regular);
      const bold = path.join(dir, c.bold);
      if (existsSync(regular)) return { regular, bold: existsSync(bold) ? bold : regular };
    }
  }
  return null;
}

export async function loadFonts(): Promise<FontPair> {
  if (cached) return cached;
  const paths = findFontPaths();
  if (!paths) throw new Error("No Cyrillic-capable TTF font found. Set FONT_DIR (DejaVu/Liberation) or FONT_REGULAR/FONT_BOLD.");
  const parse = async (file: string): Promise<Font> => {
    const buf = await readFile(file);
    // opentype.parse wants an ArrayBuffer that starts at the font bytes, not Node's pooled slice.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return opentype.parse(ab);
  };
  const [regular, bold] = await Promise.all([parse(paths.regular), parse(paths.bold)]);
  cached = { regular, bold, regularPath: paths.regular, boldPath: paths.bold };
  return cached;
}

export function measure(font: Font, text: string, fontPx: number): number {
  return font.getAdvanceWidth(text, fontPx);
}
