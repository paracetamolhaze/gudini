import { Word } from "./transcribe";
import { RawCleanupAction } from "./speechCleanupPlan";

/**
 * Сборка по сценарию: из нескольких прочтений одного предложения остаётся лучшее.
 *
 * Автор читает сценарий с телесуфлёра и перечитывает абзацы, пока не получится:
 * запись 3:41 при сценарии на полторы минуты речи. Чистка речи моделью находит
 * такие дубли, но по правилу безопасности режет не больше 15 с за проход — для
 * многократных перечитываний этого мало. Здесь дубли находятся без модели:
 *
 *  1. Сценарий режется на предложения; в расшифровке для каждого собираются все
 *     попытки его прочитать (от слова, похожего на одно из двух первых значимых
 *     слов, вперёд по порядку; повтор первого слова — новая попытка).
 *  2. Остаётся лучшая попытка (полнота, без обрывов; при равных — последняя:
 *     её и переписывали до нормального). Порядок предложений сохраняется.
 *  3. Если после оставленной попытки автор перечитывал ХВОСТ предложения
 *     («…сражаться-- которым придётся сражаться с лицом человека…»), берётся
 *     последнее дочитывание: голова из оставленной попытки, хвост — из него,
 *     всё между ними уходит.
 *  4. Речь между попытками, не совпадающая ни с одним предложением: повтор
 *     одной и той же фразы — остаётся последний; разговор с монтажёром
 *     («заново», «сорри, нарежешь», «не могу») и короткая болтовня рядом с
 *     неудачной попыткой — уходят; настоящая импровизация остаётся.
 *
 * Модель здесь не нужна, деньги не тратятся; результат детерминирован.
 */

export type TakeRead = {
  sentence: number;
  from: number;
  to: number;
  /** индекс слова расшифровки для каждого совпавшего слова предложения */
  matches: { tok: number; word: number }[];
  matched: number;
  coverage: number;
  cutoffs: number;
  fillers: number;
  /** попытка начинается не с начала предложения */
  suffix: boolean;
};
export type Drop = { from: number; to: number; reason: "RETAKE" | "CHATTER" | "REPEAT" | "MID_RETAKE" };
export type TakeSelection = {
  sentences: string[];
  /** выбранное прочтение каждого предложения (или null — не найдено) */
  kept: (TakeRead | null)[];
  /** что вырезается, слитно и по возрастанию */
  dropped: Drop[];
  /** доля предложений, у которых найдено прочтение */
  coverage: number;
  actions: RawCleanupAction[];
};

const skeleton = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");
function sameStem(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) <= 4 || Math.abs(a.length - b.length) > 3) return false;
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n >= Math.max(3, Math.min(a.length, b.length) - 2);
}
const isCutoff = (w: string) => /--$/.test(w.trim().replace(/[,.!?…]+$/, ""));
const isFiller = (w: string) => /^(э+|эм+|м+|а+|(э|а)(э|а)+|иии+)$/.test(skeleton(w));
/** Слова, которыми автор говорит с монтажёром, а не со зрителем. */
// Слова монтажёру, которых в речи для зрителя не бывает: срабатывают в куске любой длины.
const CHATTER_STRONG = /^(заново|сорри|сорян|нарежеш\w*|нарежь|вырежеш\w*|вырежь|перезапиш\w*|перепиш\w*)$/;
// Обычные слова, которые бывают и командой монтажёру («стоп», «сначала», «ладно»):
// болтовня только в коротком куске. Длинная импровизация с «ок» внутри остаётся.
const CHATTER_WEAK = /^(стоп|бля|блядь|блин|чё|че|сначала|погоди|секунду|ладно|ок)$/;
const CHATTER_WEAK_MAX_WORDS = 5;
const CHATTER_WEAK_MAX_SEC = 3;

/** Предложения сценария: по знакам конца предложения; абзац — тоже граница. */
export function splitSentences(script: string): string[] {
  return script
    .split(/\n\s*\n/)
    .flatMap((p) => p.split(/(?<=[.!?…])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).filter((t) => skeleton(t).length >= 3).length >= 2);
}

/** Попытка засчитывается, если совпало хотя бы столько слов предложения… */
const MIN_MATCHED = 3;
/** …и такая доля его слов. Полное прочтение — от FULL_COVERAGE. */
const MIN_COVERAGE = 0.3;
const FULL_COVERAGE = 0.6;
/** Сколько чужих слов подряд допускается внутри попытки (запинки, вставки). */
const MAX_SKIP = 3;
/** Неполная попытка вырезается, только если оставленное прочтение начинается не дальше этого числа слов. */
const NEAR_WORDS = 60;
/** Болтовня между попытками уходит, если она короче этого (секунды). */
const CHATTER_MAX_SEC = 12;

/** Жадное чтение предложения от слова i начиная с токена t0. */
function extend(sentence: number, toks: string[], sk: string[], words: Word[], i: number, t0: number): TakeRead {
  const heads = toks.slice(0, 2);
  let ti = t0;
  let last = i;
  let skip = 0;
  let cutoffs = isCutoff(words[i].word) ? 1 : 0;
  let fillers = 0;
  const matches = [{ tok: t0, word: i }];
  for (let k = i + 1; k < sk.length && ti < toks.length - 1; k++) {
    if (sameStem(sk[k], toks[0]) && ti >= 1) break; // автор начал предложение заново
    let hit = -1;
    for (let t = ti + 1; t < Math.min(toks.length, ti + 4); t++) {
      if (sameStem(sk[k], toks[t])) {
        hit = t;
        break;
      }
    }
    if (hit >= 0) {
      ti = hit;
      last = k;
      skip = 0;
      matches.push({ tok: hit, word: k });
    } else {
      if (isCutoff(words[k].word)) cutoffs++;
      else if (isFiller(words[k].word)) fillers++;
      if (++skip > MAX_SKIP) break;
    }
  }
  // Хвост попытки: короткий обрыв после последнего совпавшего слова («…футболист в ми-- э-э-э»)
  // принадлежит ей же — до следующего старта предложения и не дальше MAX_SKIP слов.
  let tail = last;
  for (let k = last + 1; k <= Math.min(words.length - 1, last + MAX_SKIP + 1); k++) {
    if (heads.some((h) => sameStem(sk[k], h))) break;
    if (isCutoff(words[k].word) || isFiller(words[k].word)) tail = k;
  }
  // Голова попытки: предлог или союз перед первым значимым словом («в запасе», «и потом»);
  // обрыв или «э-э» перед головой — хвост предыдущей попытки, к этой не относятся.
  let from = i;
  while (from > 0 && from > i - 2 && sk[from - 1].length > 0 && sk[from - 1].length <= 2 && !isCutoff(words[from - 1].word) && !isFiller(words[from - 1].word)) from--;
  return { sentence, from, to: tail, matches, matched: matches.length, coverage: matches.length / toks.length, cutoffs, fillers, suffix: t0 > 0 };
}

/** Все попытки прочитать предложение с начала. */
function readsOf(sentence: number, toks: string[], sk: string[], words: Word[]): TakeRead[] {
  const out: TakeRead[] = [];
  const heads = toks.slice(0, 2);
  for (let i = 0; i < sk.length; i++) {
    const headIdx = heads.findIndex((h) => sameStem(sk[i], h));
    if (headIdx < 0) continue;
    const r = extend(sentence, toks, sk, words, i, headIdx);
    if (r.matched < Math.min(MIN_MATCHED, toks.length) || r.coverage < MIN_COVERAGE) continue;
    if (out.some((x) => x.from <= r.from && x.to >= r.to)) continue; // та же попытка с другого старта
    out.push(r);
  }
  return out;
}

/** Дочитывания хвоста предложения после оставленной попытки: с любого слова, доводящие до конца. */
function finishersAfter(sentence: number, toks: string[], sk: string[], words: Word[], afterWord: number, beforeWord: number): TakeRead[] {
  const out: TakeRead[] = [];
  for (let i = afterWord + 1; i < Math.min(sk.length, beforeWord); i++) {
    for (let t0 = 1; t0 < toks.length - 2; t0++) {
      if (!sameStem(sk[i], toks[t0])) continue;
      const r = extend(sentence, toks, sk, words, i, t0);
      const lastTok = r.matches[r.matches.length - 1].tok;
      if (r.matched >= MIN_MATCHED && lastTok >= toks.length - 2 && !out.some((x) => x.from <= r.from && x.to >= r.to)) out.push(r);
      break;
    }
  }
  return out;
}

const score = (r: TakeRead) => r.coverage - 0.15 * r.cutoffs - 0.05 * r.fillers + 0.001 * r.from;

export function selectTakes(script: string | null, words: Word[]): TakeSelection {
  const sentences = script ? splitSentences(script) : [];
  const sk = words.map((w) => skeleton(w.word));
  const tokens = sentences.map((s) => s.split(/\s+/).map(skeleton).filter((t) => t.length >= 3));
  const reads: TakeRead[][] = sentences.map((_, i) => readsOf(i, tokens[i], sk, words));

  // 2) лучшее прочтение каждого предложения с сохранением порядка
  const kept: (TakeRead | null)[] = [];
  let cursor = -1;
  for (let i = 0; i < sentences.length; i++) {
    const cands = reads[i].filter((r) => r.from > cursor).sort((a, b) => score(b) - score(a));
    const best = cands[0] ?? null;
    kept.push(best);
    if (best) cursor = best.to;
  }
  const keptRanges: { from: number; to: number }[] = [];
  const drops: Drop[] = [];

  // 3) дочитывания хвоста: голова из оставленной попытки, хвост — из последнего дочитывания
  for (let i = 0; i < sentences.length; i++) {
    const k = kept[i];
    if (!k) continue;
    const nextKeptFrom = kept.slice(i + 1).find(Boolean)?.from ?? words.length;
    const maxTok = Math.max(...k.matches.map((m) => m.tok));
    // Дочитывание хвоста ищется, только если оставленная попытка не дочитана или
    // с обрывом; полное чистое прочтение остаётся целым, а поздние повторы — обычные дубли.
    const complete = k.cutoffs === 0 && maxTok >= tokens[i].length - 2 && k.coverage >= 0.8;
    const fins = complete ? [] : finishersAfter(i, tokens[i], sk, words, k.to, nextKeptFrom);
    const usable = fins.filter((f) => f.matches[0].tok <= maxTok + 1);
    const fin = usable[usable.length - 1];
    if (!fin) {
      keptRanges.push({ from: k.from, to: k.to });
      continue;
    }
    const t0 = fin.matches[0].tok;
    const headEnd = k.matches.filter((m) => m.tok < t0).map((m) => m.word);
    const cutAfter = headEnd.length ? Math.max(...headEnd) : k.from - 1;
    if (cutAfter >= k.from) keptRanges.push({ from: k.from, to: cutAfter });
    keptRanges.push({ from: fin.from, to: fin.to });
    drops.push({ from: cutAfter + 1, to: fin.from - 1, reason: "MID_RETAKE" });
  }
  const overlapsKept = (from: number, to: number) => keptRanges.some((k) => from <= k.to && to >= k.from);

  // отброшенные попытки прочитать с начала
  for (const r of reads.flat()) {
    if (overlapsKept(r.from, r.to)) continue;
    const k = kept[r.sentence];
    if (!k) continue; // у предложения нет оставленного прочтения — резать нечего
    if (r.coverage >= FULL_COVERAGE || Math.abs(k.from - r.from) <= NEAR_WORDS) drops.push({ from: r.from, to: r.to, reason: "RETAKE" });
  }

  // 4) речь между попытками, не совпавшая ни с одним предложением
  const covered = new Array<boolean>(words.length).fill(false);
  for (const k of keptRanges) for (let w = k.from; w <= k.to; w++) covered[w] = true;
  for (const d of drops) for (let w = Math.max(0, d.from); w <= Math.min(words.length - 1, d.to); w++) covered[w] = true;
  const isKeptWord = (w: number) => keptRanges.some((k) => w >= k.from && w <= k.to);
  const firstKept = Math.min(...keptRanges.map((k) => k.from), words.length);
  const lastKept = Math.max(...keptRanges.map((k) => k.to), -1);
  let w = 0;
  while (w < words.length) {
    if (covered[w]) {
      w++;
      continue;
    }
    let e = w;
    while (e + 1 < words.length && !covered[e + 1]) e++;
    // повтор фразы внутри отрезка: остаётся последнее произнесение
    const repeats: { from: number; to: number }[] = [];
    for (let p = w; p + 2 <= e; p++) {
      for (let q = p + 3; q + 2 <= e && q <= p + 15; q++) {
        if (sameStem(sk[p], sk[q]) && sameStem(sk[p + 1], sk[q + 1]) && sameStem(sk[p + 2], sk[q + 2])) {
          repeats.push({ from: p, to: q - 1 });
          drops.push({ from: p, to: q - 1, reason: "REPEAT" });
          p = q - 1;
          break;
        }
      }
    }
    // Отрезок делится по концам предложений и по границам повторов: импровизация
    // для зрителя и слова монтажёру часто стоят рядом («…после щелчка Таноса.
    // А-а-а, Натали Портман. Не суть.»), а сам повтор уже вырезан и в части не входит.
    const parts: { from: number; to: number }[] = [];
    let ps = w;
    for (let k = w; k <= e; k++) {
      const repeatStartsNext = repeats.some((r) => r.from === k + 1);
      const repeatEnds = repeats.some((r) => r.to === k);
      if (k === e || /[.!?…]$/.test(words[k].word.trim()) || repeatStartsNext || repeatEnds) {
        if (!repeats.some((r) => ps >= r.from && k <= r.to)) parts.push({ from: ps, to: k });
        ps = k + 1;
      }
    }
    if (!parts.length) {
      w = e + 1;
      continue;
    }
    const between = w > firstKept && e < lastKept;
    const marked = new Set<number>(); // индексы parts, признанные болтовнёй
    const substantial = (p: { from: number; to: number }) => {
      const ws = words.slice(p.from, p.to + 1);
      return ws.length >= 4 || words[p.to].end - words[p.from].start >= 1.5 || ws.some((x) => isCutoff(x.word) || isFiller(x.word));
    };
    const dropEndsAt = (i: number) => drops.some((d) => d.reason !== "REPEAT" && d.to === i);
    const dropStartsAt = (i: number) => drops.some((d) => d.reason !== "REPEAT" && d.from === i);
    // Сосед слева/справа — вырезка или уже признанная болтовня; совсем короткие
    // части («не суть») прозрачны: через них соседство видно дальше.
    type Side = "drop" | "marked" | null;
    const sideLeft = (idx: number): Side => {
      for (let j = idx - 1; j >= 0; j--) {
        if (marked.has(j)) return "marked";
        if (substantial(parts[j])) return null;
      }
      return dropEndsAt(parts[0].from - 1) ? "drop" : null;
    };
    const sideRight = (idx: number): Side => {
      for (let j = idx + 1; j < parts.length; j++) {
        if (marked.has(j)) return "marked";
        if (substantial(parts[j])) return null;
      }
      return dropStartsAt(parts[parts.length - 1].to + 1) ? "drop" : null;
    };
    // Болтовня — слова монтажёру; или, между оставленными прочтениями, речь рядом с
    // неудачной попыткой (заметная по длине или с обрывом), либо зажатая между двумя
    // вырезками. От уже признанной болтовни соседство передаётся только подозрительным
    // частям (обрыв, «э-э», три слова и короче): нормальная импровизация рядом с
    // болтовнёй остаётся — «…после щелчка Таноса. А-а-а, Натали Портман. Не суть.»
    for (let round = 0; round < 4; round++) {
      let changed = false;
      parts.forEach((p, idx) => {
        if (marked.has(idx)) return;
        const ws = words.slice(p.from, p.to + 1);
        const short = ws.length <= CHATTER_WEAK_MAX_WORDS || words[p.to].end - words[p.from].start <= CHATTER_WEAK_MAX_SEC;
        const keyword =
          ws.some((x) => CHATTER_STRONG.test(skeleton(x.word))) || (short && ws.some((x) => CHATTER_WEAK.test(skeleton(x.word))));
        let hit = keyword;
        if (!hit && between && !isKeptWord(p.from) && words[p.to].end - words[p.from].start <= CHATTER_MAX_SEC) {
          const l = sideLeft(idx);
          const r = sideRight(idx);
          const suspicious = ws.length <= 3 || ws.some((x) => isCutoff(x.word) || isFiller(x.word));
          hit = (Boolean(l) && Boolean(r)) || ((l === "drop" || r === "drop") && substantial(p)) || ((l === "marked" || r === "marked") && suspicious);
        }
        if (hit) {
          marked.add(idx);
          changed = true;
        }
      });
      if (!changed) break;
    }
    for (const idx of marked) drops.push({ from: parts[idx].from, to: parts[idx].to, reason: "CHATTER" });
    w = e + 1;
  }

  // пересекающиеся и соседние вырезки сливаются
  const merged: Drop[] = [];
  for (const d of drops.filter((d) => d.to >= d.from).sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last && d.from <= last.to + 1) last.to = Math.max(last.to, d.to);
    else merged.push({ ...d });
  }
  const actions: RawCleanupAction[] = merged.map((r) => ({ type: "REMOVE_FRAGMENT", fromWord: r.from, toWord: r.to, reason: "RETAKE", confidence: 1 }));
  const found = kept.filter(Boolean).length;
  return { sentences, kept, dropped: merged, coverage: sentences.length ? found / sentences.length : 0, actions };
}
