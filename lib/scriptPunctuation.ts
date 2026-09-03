import { Word } from "./transcribe";

/**
 * Пунктуация и границы предложений для субтитров — из сценария.
 *
 * Расшифровка речи отдаёт слова без знаков препинания, и фразы субтитров резались
 * механически: «ПОЛУЧИТЬ ЖЁЛТУЮ КАРТОЧКУ ЧЕМПИОНАТ МИРА 1/8». Так выглядит сырая
 * автоматика. У нас есть сценарий с нормальной пунктуацией и абзацами — он и
 * говорит, где кончается мысль. Слова выравниваются со сценарием по буквенному
 * скелету, и каждому произнесённому слову достаётся знак, стоящий за ним в тексте.
 *
 * Слов, которых в речи не было, не появляется: подставляются только знаки и
 * границы, сами слова остаются произнесёнными.
 */

export type PunctWord = Word & {
  /** знак препинания после слова по сценарию: , . ! ? … ; : */
  punct?: string;
  /** после слова кончается предложение */
  sentenceEnd?: boolean;
  /** после слова кончается абзац сценария — самая сильная граница */
  paragraphEnd?: boolean;
  /** ключевое слово: имя, число, название — выделяется в субтитрах */
  emphasis?: boolean;
};

const skeleton = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]/gu, "");

type ScriptTok = { text: string; punct: string; paragraphEnd: boolean; sentenceStart: boolean; sk: string };

function tokenizeScript(script: string): ScriptTok[] {
  const out: ScriptTok[] = [];
  const paragraphs = script.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  for (const para of paragraphs) {
    const raw = para.split(/\s+/).filter(Boolean);
    let sentenceStart = true;
    raw.forEach((token, i) => {
      const m = token.match(/^[«"'(\[]*(.*?)([»"')\]]*)([,.!?;:…]+)?$/u);
      const core = (m?.[1] ?? token).replace(/[»"')\]]+$/u, "");
      const punct = m?.[3] ?? "";
      out.push({
        text: core,
        punct,
        paragraphEnd: i === raw.length - 1,
        sentenceStart,
        sk: skeleton(core),
      });
      sentenceStart = /[.!?…]/.test(punct);
    });
    if (out.length) out[out.length - 1].paragraphEnd = true;
  }
  return out;
}

/** Слово сценария, которое стоит выделить: число или имя собственное не в начале предложения. */
function isKeyword(tok: ScriptTok): boolean {
  if (/\d/.test(tok.text)) return true;
  const bare = tok.text.replace(/[^\p{L}]/gu, "");
  const capital = bare.length > 2 && bare[0] === bare[0].toUpperCase() && bare[0] !== bare[0].toLowerCase();
  return capital && !tok.sentenceStart;
}

/**
 * Выравнивает произнесённые слова со сценарием и переносит знаки, границы и
 * ключевые слова. Жадный проход с окном вперёд: речь и текст почти совпадают,
 * расхождения локальны — пропуск слова, вставка междометия.
 */
export function attachScriptPunctuation(words: Word[], script: string | null): PunctWord[] {
  if (!script || !script.trim()) return words.map((w) => ({ ...w }));
  const toks = tokenizeScript(script);
  const out: PunctWord[] = [];
  let j = 0;
  const LOOKAHEAD = 6;

  for (const w of words) {
    const sk = skeleton(w.word);
    let hit = -1;
    if (sk) {
      for (let k = j; k < Math.min(toks.length, j + LOOKAHEAD); k++) {
        if (toks[k].sk === sk) {
          hit = k;
          break;
        }
      }
    }
    if (hit < 0) {
      out.push({ ...w });
      continue;
    }
    const t = toks[hit];
    j = hit + 1;
    out.push({
      ...w,
      punct: t.punct || undefined,
      sentenceEnd: /[.!?…]/.test(t.punct) || undefined,
      paragraphEnd: t.paragraphEnd || undefined,
      emphasis: isKeyword(t) || undefined,
    });
  }
  return out;
}
