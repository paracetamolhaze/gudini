import { Word } from "./transcribe";
import { CaptionStyle, DEFAULT_CAPTION_STYLE, EditEvent } from "./editPlan";

/**
 * Субтитры короткими смысловыми фразами.
 *
 * Раньше на экране было ровно одно слово: читать такое тяжело, взгляд дёргается
 * за каждой сменой, а смысл фразы собирается только в голове зрителя. Теперь
 * слова группируются по смыслу — по знакам препинания и паузам речи.
 *
 * События по-прежнему строго не пересекаются (prev.end <= next.start): это
 * защита от старого бага, когда libass складывал наложенные события в две
 * «прыгающие» строки. Цвет всегда белый с чёрной обводкой.
 */

const HOLD = 0.18; // удержание после последнего слова фразы
const GAP = 0.01; // гарантированный зазор между событиями
const MIN_DUR = 0.35;
/** Пауза, которая сама по себе заканчивает фразу. */
const PAUSE_BREAK = 0.42;
/** Больше трёх строк на экране не показываем. */
const MAX_LINES = 3;
/** Символов в строке — дальше libass переносит сам, но мы делаем это осмысленно. */
const LINE_CHARS = 22;

export type Phrase = { start: number; end: number; words: string[] };

/**
 * Группирует слова в фразы.
 *
 * Конец предложения и длинная пауза закрывают фразу принудительно; иначе фраза
 * набирается до maxWords. Дробь «1/8», сумма «$5000», процент и счёт «2:0»
 * остаются целыми — это одно слово транскрипции, и разрывать его нельзя.
 */
export function groupWordsIntoPhrases(words: Word[], maxWords = 6): Phrase[] {
  const limit = Math.max(1, Math.min(9, Math.round(maxWords)));
  const out: Phrase[] = [];
  let cur: Word[] = [];

  const flush = () => {
    if (!cur.length) return;
    out.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur.map((w) => w.word) });
    cur = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!String(w.word ?? "").trim()) continue;
    cur.push(w);

    const next = words[i + 1];
    const endsSentence = /[.!?…]$/.test(w.word.trim());
    const softBreak = /[,;:—–]$/.test(w.word.trim());
    const pause = next ? next.start - w.end >= PAUSE_BREAK : true;

    if (!next || endsSentence || pause) {
      flush();
      continue;
    }
    // мягкий разрыв закрывает фразу только когда она уже набрала вес
    if (softBreak && cur.length >= Math.max(3, limit - 2)) {
      flush();
      continue;
    }
    if (cur.length >= limit) flush();
  }
  flush();
  return out;
}

/** Раскладывает фразу по строкам, не разрывая слова. */
export function wrapPhrase(words: string[], maxLines = MAX_LINES, lineChars = LINE_CHARS): string[] {
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (line && candidate.length > lineChars && lines.length < maxLines - 1) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  // если строк всё же больше предела — доклеиваем хвост к последней
  while (lines.length > maxLines) lines[maxLines - 1] += " " + lines.splice(maxLines, 1)[0];
  return lines;
}

export function buildAss(words: Word[], styleOverride?: Partial<CaptionStyle>): string {
  const style: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, ...styleOverride };
  // Ориентир по вертикали: текст на уровне груди автора и выше интерфейса TikTok.
  const marginV = style.position === "center" ? 900 : 400;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,${style.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0.5,0,1,4.5,2,2,80,80,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // maxWords теперь действительно работает: раньше поле существовало, но каждое
  // слово всё равно становилось отдельным событием.
  const phrases = groupWordsIntoPhrases(words, style.maxWords);

  const lines: string[] = [];
  let prevEnd = -Infinity;
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i];
    const next = phrases[i + 1];
    const text = wrapPhrase(p.words.map((w) => displayWord(w, style.uppercase)).filter(Boolean)).join("\\N");
    if (!text) continue;

    const start = Math.max(p.start, prevEnd + GAP);
    let end = Math.min(p.end + HOLD, next ? next.start - GAP : Infinity);
    if (end < start + MIN_DUR) end = start + MIN_DUR;
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`);
    prevEnd = end;
  }

  return header + lines.join("\n") + "\n";
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

/**
 * Убирает каллауты, дублирующие произносимую в этот момент речь.
 * Каллаут ценен только когда добавляет то, чего нет в субтитрах (сумма, число,
 * дата, имя). «РУКА В ГИПСЕ» поверх тех же слов в субтитрах выглядит как баг.
 */
export function dropDuplicateCallouts(events: EditEvent[], words: Word[], window = 0.8): EditEvent[] {
  return events.filter((e) => {
    if (e.type !== "TEXT_CALLOUT" || !e.text) return true;
    const tokens = e.text.split(/\s+/).map(normToken).filter(Boolean);
    if (!tokens.length) return true;
    const spoken = words
      .filter((w) => w.end > e.start - window && w.start < e.end + window)
      .map((w) => normToken(w.word))
      .filter(Boolean);
    const hits = tokens.filter((t) => spoken.some((s) => sameStem(s, t))).length;
    const duplicate = hits / tokens.length >= 0.7;
    if (duplicate) console.log(`Каллаут «${e.text}» убран: дублирует речь в этом же месте`);
    return !duplicate;
  });
}

/** Нормализация токена для сравнения: регистр, Ё, пунктуация, пробелы. */
function normToken(word: string): string {
  return word
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Сравнение с терпимостью к окончаниям: «гипсе» ≈ «гипс». */
function sameStem(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const cut = (s: string) => s.slice(0, Math.max(3, s.length - 2));
  return a.startsWith(cut(b)) || b.startsWith(cut(a));
}

/**
 * Слово для показа. Висячая пунктуация убирается, но СМЫСЛОВАЯ сохраняется:
 * «1/8», «$5000», «50%», «2:0», «2025/26» должны остаться как есть —
 * раньше слэш вырезался и «1/8 финала» превращалось в «18 финала».
 */
export function displayWord(word: string, uppercase = true): string {
  const edge = /^[.,!?:;…"'«»“”„()\[\]<>*+=|`~^@\-–—]+|[.,!?:;…"'«»“”„()\[\]<>*+=|`~^@\-–—]+$/g;
  let w = escapeAss(word).trim().replace(edge, "").trim();
  if (!w) return "";
  // всё, что содержит цифру, — потенциально смысловая запись: не трогаем внутренности
  if (!/\d/.test(w)) w = w.replace(/[.,!?:;…"'«»“”„()\[\]<>*+=/|№#%&@^~`]/g, "").trim();
  return uppercase ? w.toUpperCase() : w;
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
