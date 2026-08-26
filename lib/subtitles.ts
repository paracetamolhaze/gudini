import { Word } from "./transcribe";
import { CaptionStyle, DEFAULT_CAPTION_STYLE, EditEvent } from "./editPlan";

/**
 * Фразовые субтитры: 2–5 слов на экране, фиксированная позиция (не «прыгают»),
 * события не пересекаются во времени (не накладываются друг на друга),
 * белый аккуратный шрифт с чёрной обводкой, без знаков препинания.
 */
export function buildAss(words: Word[], styleOverride?: Partial<CaptionStyle>): string {
  const style: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, ...styleOverride };
  const marginV = style.position === "center" ? 900 : 560;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,${style.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0.5,0,1,6,2.5,2,70,70,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const phrases = groupPhrases(words, style.maxWords);
  const lines: string[] = [];
  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];
    const start = phrase[0].start;
    // фраза висит чуть дольше последнего слова, но никогда не наезжает на следующую
    let end = phrase[phrase.length - 1].end + 0.35;
    const next = phrases[i + 1];
    if (next) end = Math.min(end, next[0].start - 0.02);
    end = Math.max(end, start + 0.35);

    const text = renderPhrase(phrase, style);
    if (!text) continue;
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`);
  }

  return header + lines.join("\n") + "\n";
}

/** Группирует слова во фразы: по количеству, длине строки, паузам и знакам конца предложения. */
function groupPhrases(words: Word[], maxWords: number): Word[][] {
  const phrases: Word[][] = [];
  let current: Word[] = [];
  let chars = 0;
  for (const w of words) {
    const clean = cleanWord(w.word);
    if (!clean) continue;
    const gap = current.length ? w.start - current[current.length - 1].end : 0;
    if (current.length && (current.length >= maxWords || chars + clean.length > 22 || gap > 0.6)) {
      phrases.push(current);
      current = [];
      chars = 0;
    }
    current.push(w);
    chars += clean.length + 1;
    // конец предложения в исходном слове — закрываем фразу
    if (/[.!?…]$/.test(w.word.trim()) && current.length >= 2) {
      phrases.push(current);
      current = [];
      chars = 0;
    }
  }
  if (current.length) phrases.push(current);
  return phrases;
}

function renderPhrase(phrase: Word[], style: CaptionStyle): string {
  const cleaned = phrase.map((w) => {
    const c = cleanWord(w.word);
    return style.uppercase ? c.toUpperCase() : c;
  });
  if (!style.highlightKeyword) return cleaned.filter(Boolean).join(" ");
  // акцент — самое длинное слово фразы (обычно смысловое)
  let accent = 0;
  cleaned.forEach((c, i) => {
    if (c.length > cleaned[accent].length) accent = i;
  });
  return cleaned
    .filter(Boolean)
    .map((c, i) => (i === accent ? `{\\c&H00D7FF&}${c}{\\c&H00FFFFFF&}` : c))
    .join(" ");
}

/** TEXT_CALLOUT-события: крупный акцентный текст в верхней части кадра. */
export function buildCalloutsAss(events: EditEvent[]): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Callout,Arial,130,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,1,0,1,10,4,8,60,60,480,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = events
    .filter((e) => e.type === "TEXT_CALLOUT" && e.text)
    .map((e) => {
      const text = escapeAss(e.text!).toUpperCase();
      return `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Callout,,0,0,0,,{\\fad(120,120)}${text}`;
    });
  return header + lines.join("\n") + "\n";
}

/** Убирает знаки препинания, оставляя буквы/цифры и дефис внутри слова. */
function cleanWord(word: string): string {
  return escapeAss(word)
    .replace(/[.,!?:;…"'«»“”„()\[\]<>*+=/|№#%&@^~`]/g, "")
    .replace(/^[-–—]+|[-–—]+$/g, "")
    .trim();
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
