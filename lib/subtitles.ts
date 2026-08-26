import { Word } from "./transcribe";

/**
 * Генерирует ASS-субтитры в стиле вирусных Reels:
 * крупные слова по центру, активное слово подсвечивается жёлтым (караоке-эффект).
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
Style: Caption,Arial,88,&H0000E5FF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,9,2,2,60,60,560,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const chunks = chunkWords(words);
  const lines = chunks.map((chunk) => {
    const start = chunk[0].start;
    const end = chunk[chunk.length - 1].end + 0.04;
    // караоке: \k в сотых секунды — слово заливается из белого (Secondary) в жёлтый (Primary)
    const text = chunk
      .map((w) => {
        const cs = Math.max(1, Math.round((w.end - w.start) * 100));
        return `{\\k${cs}}${escapeAss(w.word).toUpperCase()}`;
      })
      .join(" ");
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\fad(60,0)}${text}`;
  });

  return header + lines.join("\n") + "\n";
}

/** Группирует слова в короткие блоки (до 3 слов / ~18 символов) — как в трендовых субтитрах. */
function chunkWords(words: Word[]): Word[][] {
  const chunks: Word[][] = [];
  let current: Word[] = [];
  let len = 0;
  for (const w of words) {
    const wLen = w.word.length;
    const gap = current.length ? w.start - current[current.length - 1].end : 0;
    if (current.length && (current.length >= 3 || len + wLen > 18 || gap > 0.8)) {
      chunks.push(current);
      current = [];
      len = 0;
    }
    current.push(w);
    len += wLen + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
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
