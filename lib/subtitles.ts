import { Word } from "./transcribe";
import { PunctWord, isFunctionWord } from "./scriptPunctuation";
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
const LINE_CHARS = 20;

export type Phrase = { start: number; end: number; words: string[]; tokens?: PunctWord[] };

/** Местоимения: фраза на них обрываться может, но лучше не надо («тренер его | так и не выпускает»). */
const PRONOUNS = new Set(["его", "ее", "их", "ему", "ей", "им", "нас", "вас", "мне", "тебе", "себя", "это", "этот", "эта", "эти", "тот", "та", "те"]);
const isPronoun = (w: string) => PRONOUNS.has(w.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}]/gu, ""));

/**
 * Группирует слова в фразы по смыслу.
 *
 * Речь режется на клаузы: конец предложения, абзаца или длинная пауза — жёсткая
 * граница, запятая/двоеточие/тире — мягкая. Короткие соседние клаузы внутри
 * предложения склеиваются, пока помещаются в maxWords; длинная клауза делится на
 * почти равные части так, чтобы часть не обрывалась на предлоге, союзе или «не».
 * Так «получить жёлтую карточку.» заканчивается до «Чемпионат мира, 1/8 финала»,
 * а «ни одной секунды» не разрывается. Сирота из одного слова уходит к предыдущей
 * фразе. Дробь «1/8», сумма «$5000», счёт «2:0» — одно слово, его не разорвать.
 */
export function groupWordsIntoPhrases(words: PunctWord[], maxWords = 6): Phrase[] {
  const limit = Math.max(1, Math.min(9, Math.round(maxWords)));
  const list = words.filter((w) => String(w.word ?? "").trim());
  if (!list.length) return [];

  const pauseAfter = (i: number) => {
    const next = list[i + 1];
    return !next || next.start - list[i].end >= PAUSE_BREAK;
  };
  const hardAfter = (i: number) => {
    const w = list[i];
    const dot = /[.!?…]$/.test(String(w.word).trim());
    return pauseAfter(i) || Boolean(w.sentenceEnd) || Boolean(w.paragraphEnd) || dot;
  };
  const softAfter = (i: number) => /[,;:—–]/.test(list[i].punct ?? "") || /[,;:—–]$/.test(String(list[i].word).trim());

  // 1) клаузы
  type Clause = { toks: PunctWord[]; hardEnd: boolean; pauseEnd: boolean };
  const clauses: Clause[] = [];
  let cur: PunctWord[] = [];
  list.forEach((w, i) => {
    cur.push(w);
    if (hardAfter(i) || softAfter(i)) {
      clauses.push({ toks: cur, hardEnd: hardAfter(i), pauseEnd: pauseAfter(i) });
      cur = [];
    }
  });
  if (cur.length) clauses.push({ toks: cur, hardEnd: true, pauseEnd: true });

  // 2) склейка коротких клауз внутри предложения; одинокое слово — к предыдущей
  //    фразе даже через точку, но не через паузу (иначе субтитр висит в тишине)
  const merged: Clause[] = [];
  for (const c of clauses) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const fits = prev.toks.length + c.toks.length <= limit && !prev.hardEnd;
      const orphan = c.toks.length === 1 && !prev.pauseEnd && prev.toks.length + 1 <= limit + 2;
      if (fits || orphan) {
        prev.toks.push(...c.toks);
        prev.hardEnd = c.hardEnd;
        prev.pauseEnd = c.pauseEnd;
        continue;
      }
    }
    merged.push({ toks: [...c.toks], hardEnd: c.hardEnd, pauseEnd: c.pauseEnd });
  }

  // 3) длинная клауза — на почти равные части, не обрываясь на служебном слове.
  //    Если ровное деление всё равно упирается в предлог, пробуем на одну часть
  //    больше: лишняя часть стоит один балл, обрыв на предлоге — три.
  const splitClause = (toks: PunctWord[], parts: number): { cuts: number[]; penalty: number } => {
    const n = toks.length;
    const cuts: number[] = [];
    let penalty = 0;
    let from = 0;
    for (let k = 1; k < parts; k++) {
      const ideal = Math.round((n * k) / parts);
      let best = -1;
      let bestScore = Infinity;
      for (let cut = ideal - 2; cut <= ideal + 2; cut++) {
        if (cut <= from || cut >= n) continue;
        if (cut - from > limit) continue; // эта часть не длиннее лимита
        if (n - cut > limit * (parts - k)) continue; // остаток ещё поместится
        const last = toks[cut - 1].word;
        const score = Math.abs(cut - ideal) + (isFunctionWord(last) ? 3 : 0) + (isPronoun(last) ? 1 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = cut;
        }
      }
      if (best < 0) return { cuts: [], penalty: Infinity };
      penalty += bestScore;
      cuts.push(best);
      from = best;
    }
    return { cuts, penalty };
  };
  const out: Phrase[] = [];
  const push = (toks: PunctWord[]) =>
    out.push({ start: toks[0].start, end: toks[toks.length - 1].end, words: toks.map((t) => t.word), tokens: toks });
  for (const c of merged) {
    const n = c.toks.length;
    if (n <= limit) {
      push(c.toks);
      continue;
    }
    const base = Math.ceil(n / limit);
    let plan = splitClause(c.toks, base);
    if (plan.penalty > 0 && base < n) {
      const alt = splitClause(c.toks, base + 1);
      if (alt.penalty + 1 < plan.penalty) plan = alt;
    }
    let from = 0;
    for (const cut of plan.cuts) {
      push(c.toks.slice(from, cut));
      from = cut;
    }
    push(c.toks.slice(from));
  }
  return out;
}

/** Раскладывает фразу по строкам, не разрывая слова. */
export function wrapPhrase(words: string[], maxLines = MAX_LINES, lineChars = LINE_CHARS): string[] {
  // теги {\fs..} не занимают места на экране — длину считаем по видимому тексту
  const vis = (t: string) => t.replace(/\{[^}]*\}/g, "").length;
  const plain = words.join(" ");
  if (vis(plain) <= lineChars) return [plain];
  // две строки — норма: делим по слову, ближайшему к середине, но не после служебного слова
  if (vis(plain) <= lineChars * 2 + 8 || maxLines === 2) {
    let best = 1;
    let bestScore = Infinity;
    for (let k = 1; k < words.length; k++) {
      const l = vis(words.slice(0, k).join(" "));
      const r = vis(words.slice(k).join(" "));
      // одно слово на строке при фразе из четырёх и больше — сирота: «НА ПОЛЕ НИ ОДНОЙ / СЕКУНДЫ»
      const lonely = words.length >= 4 && (k === 1 || k === words.length - 1) ? 2 : 0;
      const score = Math.abs(l - r) + (isFunctionWord(words[k - 1]) ? 8 : 0) + lonely;
      // при равенстве — более длинная первая строка: «И СКОРЕЕ ВСЕГО / ДЛЯ НЕГО»
      if (score <= bestScore) {
        bestScore = score;
        best = k;
      }
    }
    return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
  }
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (line && vis(candidate) > lineChars && lines.length < maxLines - 1) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  while (lines.length > maxLines) lines[maxLines - 1] += " " + lines.splice(maxLines, 1)[0];
  return lines;
}

/**
 * Слова фразы для показа: знаки препинания возвращаются, ключевые слова крупнее.
 * Цвет остаётся белым — выделение только размером, без жёлтого.
 */
function renderPhrase(p: Phrase, all: PunctWord[], style: CaptionStyle): string[] {
  const inPhrase = all.filter((w) => w.start >= p.start - 1e-6 && w.end <= p.end + 1e-6 && String(w.word).trim());
  const source = p.tokens ?? (inPhrase.length === p.words.length ? inPhrase : p.words.map((w) => ({ word: w } as PunctWord)));
  const shown: string[] = [];
  source.forEach((w, i) => {
    let t = displayWord(w.word, style.uppercase);
    if (!t) return;
    const last = i === source.length - 1;
    const own = String(w.word).trim().match(/[,.!?…]+$/)?.[0] ?? "";
    const punct = (w.punct ?? own).replace(/[;:]/g, ",");
    // в конце фразы запятая лишняя, а точка, вопрос и восклицание — нужны
    if (punct && !(last && /^[,—–]+$/.test(punct))) t += punct;
    if (w.emphasis) t = `{\\fs${style.fontSize + 8}}${t}{\\fs${style.fontSize}}`;
    shown.push(t);
  });
  return wrapPhrase(shown);
}

/** Пословный режим: удержание после слова, зазор и минимум — как в первых роликах. */
const WORD_HOLD = 0.1;
const WORD_MIN_DUR = 0.08;

/**
 * Субтитры по одному слову: Arial 84, белый, чёрная обводка 6, тень 2.5, поля 70,
 * нижняя граница на 560 px от низа. Ровно тот стиль, что был в первых роликах.
 * События не пересекаются: старт не раньше конца предыдущего.
 */
function buildWordAss(words: Word[], style: CaptionStyle): string {
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
  const items = words
    .map((w) => ({ start: w.start, end: w.end, text: displayWord(w.word, style.uppercase) }))
    .filter((w) => w.text);
  const lines: string[] = [];
  let prevEnd = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const w = items[i];
    const next = items[i + 1];
    const start = Math.max(w.start, prevEnd + GAP);
    let end = Math.min(w.end + WORD_HOLD, next ? next.start - GAP : Infinity);
    if (end < start + WORD_MIN_DUR) end = start + WORD_MIN_DUR;
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${w.text}`);
    prevEnd = end;
  }
  return header + lines.join("\n") + "\n";
}

export function buildAss(words: Word[], styleOverride?: Partial<CaptionStyle>): string {
  const style: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, ...styleOverride };
  if (style.mode === "word") return buildWordAss(words, style);
  // фразовый режим: кегль 58, как был рассчитан под две строки
  if (styleOverride?.fontSize === undefined) style.fontSize = 58;
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
  const list = words as PunctWord[];
  const phrases = groupWordsIntoPhrases(list, style.maxWords);

  const lines: string[] = [];
  let prevEnd = -Infinity;
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i];
    const next = phrases[i + 1];
    const text = renderPhrase(p, list, style).join("\\N");
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
