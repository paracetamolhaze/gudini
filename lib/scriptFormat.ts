import { Word } from "./transcribe";

/**
 * Script-aware коррекция субтитров.
 * У нас есть оригинальный сценарий, распознанная речь и словные таймкоды — этого
 * достаточно, чтобы вернуть каноническую запись там, где ASR отдал ту же строку
 * иначе: «18» → «1/8», «5000» → «$5000», «хендерсон» → «Хендерсон».
 *
 * Подменяем ТОЛЬКО когда буквенно-цифровой скелет слова совпал со скелетом слова
 * из сценария — то есть человек произнёс именно это. Слова, которых в речи не было,
 * не подставляются никогда.
 */

/** Скелет: только буквы и цифры, нижний регистр, Ё→Е. */
function skeleton(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Слово сценария, за форматирование которого стоит бороться. */
function isSpecial(token: string): boolean {
  if (/\d/.test(token)) return true; // 1/8, $5000, 50%, 2:0, 2025/26
  const bare = token.replace(/[^\p{L}]/gu, "");
  return bare.length > 2 && bare[0] === bare[0].toUpperCase() && bare[0] !== bare[0].toLowerCase();
}

type ScriptToken = { text: string; skeleton: string; position: number };

function scriptTokens(script: string): ScriptToken[] {
  const raw = script.split(/\s+/).filter(Boolean);
  const out: ScriptToken[] = [];
  raw.forEach((token, i) => {
    // убираем только висячую пунктуацию предложения, внутреннюю (1/8, $5000) сохраняем
    const clean = token.replace(/^[«"'(\[]+/, "").replace(/[»"')\],.!?;:…]+$/, "");
    if (!clean || !isSpecial(clean)) return;
    const sk = skeleton(clean);
    if (sk.length < 2) return;
    out.push({ text: clean, skeleton: sk, position: i / Math.max(1, raw.length - 1) });
  });
  return out;
}

/**
 * Возвращает копию слов с канонической записью из сценария.
 * Совпадение ищется по скелету; при нескольких кандидатах берётся ближайший
 * по относительной позиции в тексте — так «1/8» не перепутается с другим числом.
 */
export function applyScriptFormatting(words: Word[], script: string | null): Word[] {
  if (!script?.trim() || !words.length) return words;
  const specials = scriptTokens(script);
  if (!specials.length) return words;

  const bySkeleton = new Map<string, ScriptToken[]>();
  for (const t of specials) {
    const list = bySkeleton.get(t.skeleton) ?? [];
    list.push(t);
    bySkeleton.set(t.skeleton, list);
  }

  let fixed = 0;
  const out = words.map((w, i) => {
    const sk = skeleton(w.word);
    const matches = bySkeleton.get(sk);
    if (!sk || !matches?.length) return w;
    const position = i / Math.max(1, words.length - 1);
    const best = matches.reduce((a, b) =>
      Math.abs(b.position - position) < Math.abs(a.position - position) ? b : a,
    );
    if (best.text === w.word.trim()) return w;
    fixed++;
    return { ...w, word: best.text };
  });
  if (fixed) console.log(`Субтитры: ${fixed} слов приведено к записи из сценария (числа/дроби/имена)`);
  return out;
}
