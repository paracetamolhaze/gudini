import fs from "fs";
import path from "path";
import * as opentype from "opentype.js";

/**
 * Gudini Cover Design System — раскладка заголовка обложки.
 * Один фирменный стиль для всех обложек: тяжёлый узкий Oswald Bold (OFL, fonts/),
 * капс, 2–4 строки, белый + жёлтый акцент, ~85–94% ширины кадра, нижняя треть.
 * Размер шрифта подбирается по РЕАЛЬНОМУ измерению текста (opentype, advanceWidth глифов).
 */

export const CANVAS_W = 1080;
export const CANVAS_H = 1920;
const MAX_TEXT_W = 1000; // 92.6% ширины
const MAX_BLOCK_H = Math.round(CANVAS_H * 0.4);
const BOTTOM_MARGIN = 150; // safe zone под интерфейсы платформ
const LINE_ADVANCE = 0.94; // плотный межстрочный интервал (доля от fontSize)
const MAX_FONT = 400;
const MIN_FONT = 110;

export type HeadlineLine = { text: string; accent: boolean };

export type CoverLayout = {
  fontSize: number;
  lines: (HeadlineLine & { y: number; width: number })[];
  widthRatio: number; // самая широкая строка / ширина кадра
  heightRatio: number; // высота блока / высота кадра
  blockTop: number;
};

let cachedFont: opentype.Font | null = null;

export function loadDisplayFont(): opentype.Font {
  if (cachedFont) return cachedFont;
  const file = path.join(process.cwd(), "fonts", "Oswald-Bold.ttf");
  const buffer = fs.readFileSync(file);
  cachedFont = opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  return cachedFont;
}

/** Точная ширина строки: сумма advanceWidth глифов (шейпинг капс-кириллице не нужен). */
export function measureText(text: string, fontSize: number): number {
  const font = loadDisplayFont();
  let units = 0;
  for (const ch of text) units += font.charToGlyph(ch).advanceWidth ?? 0;
  return (units / font.unitsPerEm) * fontSize;
}

/** Нормализует строки заголовка; одну длинную строку сам бьёт на 2 сбалансированные. */
export function breakHeadline(lines: HeadlineLine[] | null | undefined, headline: string): HeadlineLine[] {
  const clean = (t: string) => t.replace(/[{}\\]/g, "").trim().toUpperCase();

  let result: HeadlineLine[] = (lines ?? [])
    .map((l) => ({ text: clean(String(l.text ?? "")), accent: Boolean(l.accent) }))
    .filter((l) => l.text);

  if (!result.length) {
    result = headline
      .split(/\\n|\n/)
      .map((t) => ({ text: clean(t), accent: false }))
      .filter((l) => l.text);
    if (result.length === 1) {
      const words = result[0].text.split(/\s+/);
      if (words.length >= 2) {
        // сбалансированный перенос по реальной ширине
        let best = 1;
        let bestDiff = Infinity;
        for (let i = 1; i < words.length; i++) {
          const a = measureText(words.slice(0, i).join(" "), 100);
          const b = measureText(words.slice(i).join(" "), 100);
          if (Math.abs(a - b) < bestDiff) {
            bestDiff = Math.abs(a - b);
            best = i;
          }
        }
        result = [
          { text: words.slice(0, best).join(" "), accent: false },
          { text: words.slice(best).join(" "), accent: true },
        ];
      }
    }
    // без разметки акцента — жёлтой делаем последнюю строку (фирменный паттерн)
    if (result.length >= 2 && !result.some((l) => l.accent)) result[result.length - 1].accent = true;
  }
  return result.slice(0, 4);
}

/** Максимальный размер шрифта, при котором самая широкая строка и блок влезают в safe-box. */
export function computeLayout(lines: HeadlineLine[]): CoverLayout {
  const unitWidths = lines.map((l) => measureText(l.text, 1));
  let fontSize = Math.min(MAX_FONT, ...unitWidths.map((u) => (u > 0 ? MAX_TEXT_W / u : MAX_FONT)));

  const blockHeight = (size: number) => size * (1 + LINE_ADVANCE * (lines.length - 1));
  if (blockHeight(fontSize) > MAX_BLOCK_H) fontSize = MAX_BLOCK_H / (1 + LINE_ADVANCE * (lines.length - 1));
  fontSize = Math.max(MIN_FONT, Math.floor(fontSize));

  const blockH = blockHeight(fontSize);
  const blockTop = CANVAS_H - BOTTOM_MARGIN - blockH;
  const placed = lines.map((l, i) => ({
    ...l,
    y: Math.round(blockTop + i * fontSize * LINE_ADVANCE),
    width: Math.round(measureText(l.text, fontSize)),
  }));

  return {
    fontSize,
    lines: placed,
    widthRatio: Math.round((Math.max(...placed.map((l) => l.width)) / CANVAS_W) * 1000) / 1000,
    heightRatio: Math.round((blockH / CANVAS_H) * 1000) / 1000,
    blockTop: Math.round(blockTop),
  };
}

/** ASS для текстового слоя обложки: заголовок (белый/жёлтый) + маленький kicker. */
export function buildCoverHeadlineAss(layout: CoverLayout, kicker?: string): string {
  const YELLOW = "&H00D7FF&"; // FFD700 в BGR
  const bord = Math.max(6, Math.round(layout.fontSize * 0.05));
  const shad = Math.max(4, Math.round(layout.fontSize * 0.035));

  const events = layout.lines.map((l) => {
    const color = l.accent ? `{\\c${YELLOW}}` : "";
    return (
      `Dialogue: 0,0:00:00.00,0:00:10.00,Head,,0,0,0,,` +
      `{\\an8\\pos(${CANVAS_W / 2},${l.y})\\fs${layout.fontSize}\\bord${bord}\\shad${shad}}${color}${escapeAss(l.text)}`
    );
  });

  if (kicker?.trim()) {
    const size = Math.max(44, Math.round(layout.fontSize * 0.18));
    const y = layout.blockTop - Math.round(size * 1.7);
    events.unshift(
      `Dialogue: 0,0:00:00.00,0:00:10.00,Head,,0,0,0,,` +
        `{\\an8\\pos(${CANVAS_W / 2},${y})\\fs${size}\\bord${Math.round(size * 0.09)}\\shad2}{\\c${YELLOW}}` +
        escapeAss(kicker.trim().toUpperCase().slice(0, 24)),
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
Style: Head,Oswald,100,&H00FFFFFF,&H00FFFFFF,&H00000000,&HB4000000,-1,0,0,0,100,100,0,0,1,8,5,8,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

function escapeAss(text: string): string {
  return text.replace(/[{}\\]/g, "");
}
