import { Word } from "./transcribe";

/**
 * Генерирует ASS-субтитры: крупные белые слова аккуратным шрифтом,
 * чёрная обводка и мягкая тень — читаются на любом фоне.
 */
export function buildAss(words: Word[]): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0.5,0,1,7,2.5,2,70,70,560,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // по одному слову на экран, без знаков препинания
  const lines: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const text = cleanWord(w.word);
    if (!text) continue;
    const start = w.start;
    // слово держится до начала следующего (но не менее 0.2 сек)
    const next = words[i + 1];
    const end = Math.max(w.end, start + 0.2, next ? Math.min(next.start, w.end + 0.5) : w.end);
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`);
  }

  return header + lines.join("\n") + "\n";
}

/** Убирает знаки препинания, оставляя буквы/цифры и дефис внутри слова. */
function cleanWord(word: string): string {
  return escapeAss(word)
    .replace(/[.,!?:;…"'«»“”„()\[\]<>*+=/|№#%&@^~`]/g, "")
    .replace(/^[-–—]+|[-–—]+$/g, "")
    .trim()
    .toUpperCase();
}

function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAss(text: string): string {
  return text.replace(/[{}\\]/g, "").replace(/\n/g, " ");
}
