import fs from "fs";
import path from "path";
import * as opentype from "opentype.js";

/**
 * Gudini Cover Design System v3 — типографика обложек.
 * Target: aggressive editorial ultra-heavy condensed (класс Druk Condensed).
 * - Шрифт: пользовательский (Settings → Cover Font, data/coverfont.*) → фолбэк
 *   Montserrat Black (OFL, полная кириллица) с горизонтальным сжатием глифов (scaleX),
 *   что даёт heavy-condensed характер. Сжимается ТОЛЬКО текстовый слой, не картинка.
 * - Построчный fit: каждая строка подгоняется под ~93% ширины своим размером;
 *   служебные слова («НА», «И») — намеренно мелкие, как в референсах.
 * - Метрика INK bbox (реальные границы нарисованных глифов), а не только advance-width.
 * - Плотный line-height 0.84, мощная обводка, короткая плотная тень, брендовый жёлтый.
 * - Акценты: yellow-строка | yellow box (чёрный текст на жёлтой плашке).
 */

export const CANVAS_W = 1080;
export const CANVAS_H = 1920;
export const COVER_ACCENT_YELLOW = "&H00D7FF&"; // FFD700 (BGR) — единый брендовый жёлтый

const MAX_TEXT_W = 1005; // ~93% ширины
const MAX_BLOCK_H = Math.round(CANVAS_H * 0.42);
const BOTTOM_MARGIN = 130;
const LINE_HEIGHT = 0.84; // строки почти сцепляются
const MAX_FONT = 430;
const MIN_FONT = 90;
const CONNECTOR_RATIO = 0.42; // размер служебных слов от основного
const MAIN_RATIO_CAP = 1.9; // максимум разброса размеров основных строк

const CONNECTORS = new Set(["НА", "И", "В", "ВО", "ИЗ", "ОТ", "ДО", "ЗА", "С", "СО", "К", "ПО", "НЕ", "У", "О", "ОБ"]);

export type AccentStyle = false | "yellow" | "box";
export type HeadlineLine = { text: string; accent: AccentStyle };

export type LaidLine = HeadlineLine & {
  fontSize: number;
  y: number;
  inkWidth: number;
  connector: boolean;
};

export type CoverLayout = {
  lines: LaidLine[];
  scaleX: number; // проценты для ASS \fscx
  fontFamily: string;
  maxWidthRatio: number; // самая широкая строка (ink) / ширина кадра
  heightRatio: number;
  blockTop: number;
};

// ===== Шрифт: пользовательский → фолбэк =====

const CUSTOM_FONT_CANDIDATES = ["coverfont.ttf", "coverfont.otf"];
const FALLBACK_FONT = path.join("fonts", "Montserrat-Black.ttf");
const FALLBACK_SCALE_X = 82; // сжатие глифов фолбэка до condensed-характера

let cached: { file: string; font: opentype.Font; family: string } | null = null;

export function resolveCoverFontFile(): { file: string; custom: boolean } {
  for (const name of CUSTOM_FONT_CANDIDATES) {
    const p = path.join(process.cwd(), "data", name);
    if (fs.existsSync(p)) return { file: p, custom: true };
  }
  return { file: path.join(process.cwd(), FALLBACK_FONT), custom: false };
}

export function loadDisplayFont(): { font: opentype.Font; family: string; file: string; custom: boolean } {
  const { file, custom } = resolveCoverFontFile();
  if (!cached || cached.file !== file) {
    const buffer = fs.readFileSync(file);
    const font = opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    cached = { file, font, family: extractFamily(font) ?? "Montserrat Black" };
  }
  return { ...cached, custom };
}

function extractFamily(font: opentype.Font): string | null {
  const names: any = (font as any).names;
  const pick = (obj: any) => obj?.fontFamily?.en ?? obj?.fontFamily?.["en-US"] ?? null;
  return pick(names) ?? pick(names?.windows) ?? pick(names?.macintosh) ?? pick(names?.unicode) ?? null;
}

/** Проверка обязательных глифов (кириллица/цифры/знаки) — для валидации загружаемого шрифта. */
export function checkGlyphCoverage(fontBuffer: Buffer): { ok: boolean; missing: string } {
  try {
    const font = opentype.parse(
      fontBuffer.buffer.slice(fontBuffer.byteOffset, fontBuffer.byteOffset + fontBuffer.byteLength),
    );
    const need = "АБВГДабвгд0123456789$%";
    const missing = [...need].filter((ch) => font.charToGlyph(ch).index === 0).join("");
    return { ok: missing.length === 0, missing };
  } catch {
    return { ok: false, missing: "(файл не распознан как шрифт)" };
  }
}

// ===== Измерение: INK bounding box по путям глифов (без шейпинга — капсу он не нужен) =====

export function measureInk(text: string, fontSize: number): { width: number; advance: number } {
  const { font } = loadDisplayFont();
  const scale = fontSize / font.unitsPerEm;
  let x = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    const bb = glyph.getBoundingBox();
    if (bb && bb.x2 > bb.x1) {
      minX = Math.min(minX, x + bb.x1 * scale);
      maxX = Math.max(maxX, x + bb.x2 * scale);
    }
    x += (glyph.advanceWidth ?? 0) * scale;
  }
  if (!Number.isFinite(minX)) return { width: 0, advance: x };
  return { width: maxX - minX, advance: x };
}

// ===== Разбиение заголовка =====

export function breakHeadline(lines: HeadlineLine[] | null | undefined, headline: string): HeadlineLine[] {
  const clean = (t: string) => t.replace(/[{}\\]/g, "").trim().toUpperCase();
  const normAccent = (a: unknown): AccentStyle => (a === "box" ? "box" : a === "yellow" || a === true ? "yellow" : false);

  let result: HeadlineLine[] = (lines ?? [])
    .map((l) => ({ text: clean(String(l.text ?? "")), accent: normAccent((l as any).accent) }))
    .filter((l) => l.text);

  if (!result.length) {
    result = headline
      .split(/\\n|\n/)
      .map((t) => ({ text: clean(t), accent: false as AccentStyle }))
      .filter((l) => l.text);
    if (result.length === 1) {
      const words = result[0].text.split(/\s+/);
      if (words.length >= 2) {
        let best = 1;
        let bestDiff = Infinity;
        for (let i = 1; i < words.length; i++) {
          const a = measureInk(words.slice(0, i).join(" "), 100).width;
          const b = measureInk(words.slice(i).join(" "), 100).width;
          if (Math.abs(a - b) < bestDiff) {
            bestDiff = Math.abs(a - b);
            best = i;
          }
        }
        result = [
          { text: words.slice(0, best).join(" "), accent: false },
          { text: words.slice(best).join(" "), accent: "yellow" },
        ];
      }
    }
    if (result.length >= 2 && !result.some((l) => l.accent)) result[result.length - 1].accent = "yellow";
  }
  return result.slice(0, 4);
}

// ===== Построчная раскладка =====

export function computeLayout(lines: HeadlineLine[]): CoverLayout {
  const { family, custom } = loadDisplayFont();
  const scaleX = custom ? 100 : FALLBACK_SCALE_X;
  const sx = scaleX / 100;

  const inkUnit = lines.map((l) => measureInk(l.text, 100).width / 100); // ink-ширина на 1px размера
  const connector = lines.map((l) => CONNECTORS.has(l.text.trim()));

  // каждая основная строка тянется к полной ширине своим размером
  let sizes = lines.map((_, i) => {
    const unit = inkUnit[i] * sx;
    return unit > 0 ? Math.min(MAX_FONT, MAX_TEXT_W / unit) : MAX_FONT;
  });

  // связность: основные строки не должны различаться больше чем в MAIN_RATIO_CAP раз
  const mains = sizes.filter((_, i) => !connector[i]);
  if (mains.length) {
    const minMain = Math.min(...mains);
    sizes = sizes.map((s, i) => (connector[i] ? s : Math.min(s, minMain * MAIN_RATIO_CAP)));
    // служебные слова — намеренно мелкие
    const mainMax = Math.max(...sizes.filter((_, i) => !connector[i]));
    sizes = sizes.map((s, i) => (connector[i] ? Math.min(s, mainMax * CONNECTOR_RATIO) : s));
  }

  // высотный бюджет
  const blockHeight = (arr: number[]) => arr.reduce((sum, s) => sum + s * LINE_HEIGHT, 0) + arr[arr.length - 1] * (1 - LINE_HEIGHT);
  const h = blockHeight(sizes);
  if (h > MAX_BLOCK_H) sizes = sizes.map((s) => (s * MAX_BLOCK_H) / h);
  sizes = sizes.map((s, i) => Math.max(MIN_FONT * (connector[i] ? 0.4 : 1), Math.floor(s)));

  const blockH = blockHeight(sizes);
  const blockTop = CANVAS_H - BOTTOM_MARGIN - blockH;
  let y = blockTop;
  const placed: LaidLine[] = lines.map((l, i) => {
    const lineY = Math.round(y);
    y += sizes[i] * LINE_HEIGHT;
    return {
      ...l,
      fontSize: sizes[i],
      y: lineY,
      inkWidth: Math.round(measureInk(l.text, sizes[i]).width * sx),
      connector: connector[i],
    };
  });

  return {
    lines: placed,
    scaleX,
    fontFamily: family,
    maxWidthRatio: Math.round((Math.max(...placed.map((l) => l.inkWidth)) / CANVAS_W) * 1000) / 1000,
    heightRatio: Math.round((blockH / CANVAS_H) * 1000) / 1000,
    blockTop: Math.round(blockTop),
  };
}

// ===== ASS-слой =====

export function buildCoverHeadlineAss(layout: CoverLayout, kicker?: string): string {
  const events = layout.lines.map((l) => {
    const bord = Math.min(14, Math.max(6, Math.round(l.fontSize * 0.05)));
    const shad = Math.max(3, Math.round(l.fontSize * 0.032));
    const base = `\\an8\\pos(${CANVAS_W / 2},${l.y})\\fs${l.fontSize}\\fscx${layout.scaleX}\\shad${shad}\\be0`;
    if (l.accent === "box") {
      // жёлтая плашка, чёрные буквы (BorderStyle=3 в стиле HeadBox: outline = заливка бокса)
      const pad = Math.round(l.fontSize * 0.14);
      return `Dialogue: 1,0:00:00.00,0:00:10.00,HeadBox,,0,0,0,,{${base}\\bord${pad}\\3c${COVER_ACCENT_YELLOW}\\1c&H000000&\\4c&H96000000&}${esc(l.text)}`;
    }
    const color = l.accent === "yellow" ? `\\1c${COVER_ACCENT_YELLOW}` : "";
    return `Dialogue: 0,0:00:00.00,0:00:10.00,Head,,0,0,0,,{${base}\\bord${bord}${color}}${esc(l.text)}`;
  });

  if (kicker?.trim()) {
    const size = Math.max(46, Math.round((layout.lines[0]?.fontSize ?? 200) * 0.17));
    const y = layout.blockTop - Math.round(size * 1.6);
    events.unshift(
      `Dialogue: 0,0:00:00.00,0:00:10.00,Head,,0,0,0,,` +
        `{\\an8\\pos(${CANVAS_W / 2},${y})\\fs${size}\\fscx${layout.scaleX}\\bord${Math.max(5, Math.round(size * 0.09))}\\shad2\\1c${COVER_ACCENT_YELLOW}}` +
        esc(kicker.trim().toUpperCase().slice(0, 24)),
    );
  }

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${CANVAS_W}
PlayResY: ${CANVAS_H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Head,${layout.fontFamily},100,&H00FFFFFF,&H00FFFFFF,&H00000000,&HC8000000,-1,0,0,0,100,100,0,0,1,8,4,8,20,20,20,1
Style: HeadBox,${layout.fontFamily},100,&H00000000,&H00000000,${COVER_ACCENT_YELLOW.replace("&H", "&H00")},&HC8000000,-1,0,0,0,100,100,0,0,3,8,4,8,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

function esc(text: string): string {
  return text.replace(/[{}\\]/g, "");
}
