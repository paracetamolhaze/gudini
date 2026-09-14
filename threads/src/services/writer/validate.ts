import type { VerifiedFact } from "../analysis/schemas.js";

/**
 * Deterministic guard between the model and the account. It does not judge style; it checks the
 * things that get a crypto account in trouble: numbers that were not in the facts, contradicted
 * numbers, lost uncertainty, unverified numbers without attribution, hype phrasing, format.
 */
export interface Violation {
  code:
    | "INVENTED_NUMBER"
    | "CONTRADICTED_NUMBER"
    | "UNVERIFIED_WITHOUT_ATTRIBUTION"
    | "UNCERTAINTY_LOST"
    | "FORBIDDEN_PHRASE"
    | "TOO_LONG"
    | "TOO_SHORT"
    | "HASHTAGS"
    | "EMOJI_SPAM"
    | "URGENT_OPENER"
    | "NOT_RUSSIAN";
  message: string;
  severity: "block" | "warn";
}

export interface ValidationResult {
  ok: boolean;
  blocking: boolean;
  violations: Violation[];
  numbersInText: string[];
  matchedFacts: number[];
}

export interface ExtractedNumber {
  raw: string;
  value: number;
  unit: "usd" | "percent" | "count" | "btc" | "eth" | "other";
  index: number;
}

const MULT: Record<string, number> = {
  k: 1e3,
  тыс: 1e3,
  тысяч: 1e3,
  тысячи: 1e3,
  m: 1e6,
  mm: 1e6,
  mn: 1e6,
  млн: 1e6,
  миллион: 1e6,
  миллиона: 1e6,
  миллионов: 1e6,
  b: 1e9,
  bn: 1e9,
  млрд: 1e9,
  миллиард: 1e9,
  миллиарда: 1e9,
  миллиардов: 1e9,
  t: 1e12,
  трлн: 1e12,
  триллион: 1e12,
};

const NUMBER_RE = /(?<cur>\$|€|£|₽)?\s?(?<num>\d{1,3}(?:[  ,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s?(?<suffix>k|m|mm|mn|b|bn|t|тыс\.?|тысяч[аи]?|млн\.?|миллион(?:а|ов)?|млрд\.?|миллиард(?:а|ов)?|трлн\.?|триллион(?:а|ов)?)?\s?(?<unit>%|процент(?:а|ов)?|btc|eth|sol|usd|usdt|usdc|долл(?:ара|аров)?|\$)?/giu;

export function extractNumbers(text: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  const re = new RegExp(NUMBER_RE.source, NUMBER_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const g = m.groups ?? {};
    const numStr = (g.num ?? "").replace(/[  ]/g, "");
    if (!numStr) continue;
    // "1,234" and "1 234" are thousands separators; "3,2" is a decimal comma.
    const normalized = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(numStr) ? numStr.replace(/,/g, "") : numStr.replace(",", ".");
    let value = Number(normalized);
    if (!Number.isFinite(value)) continue;
    const suffix = (g.suffix ?? "").toLowerCase().replace(/\.$/, "");
    if (suffix && MULT[suffix]) value *= MULT[suffix]!;
    const unitRaw = (g.unit ?? "").toLowerCase();
    const cur = g.cur ?? "";
    let unit: ExtractedNumber["unit"] = "count";
    if (cur === "$" || unitRaw === "$" || /^usd|долл/.test(unitRaw)) unit = "usd";
    else if (unitRaw === "%" || unitRaw.startsWith("процент")) unit = "percent";
    else if (unitRaw === "btc") unit = "btc";
    else if (unitRaw === "eth" || unitRaw === "sol") unit = "eth";
    else if (cur) unit = "other";
    out.push({ raw: m[0].trim(), value, unit, index: m.index });
  }
  return out;
}

function isExempt(n: ExtractedNumber, text: string): boolean {
  // Years, dates, small counts ("3 причины", "24 часа"), and list numbering are not claims.
  if (n.unit === "count" && Number.isInteger(n.value) && n.value >= 1990 && n.value <= 2100) return true;
  if (n.unit === "count" && Number.isInteger(n.value) && n.value >= 0 && n.value <= 31) return true;
  if (n.unit === "count" && /^(\d{1,2})[.)]\s/.test(text.slice(n.index, n.index + 5))) return true;
  if (n.unit === "count" && /(час|часа|часов|дн|недел|месяц|год|лет|минут)/i.test(text.slice(n.index, n.index + n.raw.length + 10))) return true;
  return false;
}

function factValue(f: VerifiedFact): { value: number; unit: ExtractedNumber["unit"] } | null {
  if (typeof f.value !== "number" || !Number.isFinite(f.value)) return null;
  const u = (f.unit ?? "").toLowerCase();
  const unit: ExtractedNumber["unit"] = /usd|\$|dollar/.test(u) ? "usd" : /percent|%/.test(u) ? "percent" : u === "btc" ? "btc" : /eth|sol/.test(u) ? "eth" : u ? "other" : "count";
  return { value: f.value, unit };
}

function sameNumber(a: number, b: number): boolean {
  if (a === b) return true;
  const tol = Math.max(Math.abs(b) * 0.015, 0.005);
  return Math.abs(a - b) <= tol;
}

function unitsCompatible(a: ExtractedNumber["unit"], b: ExtractedNumber["unit"]): boolean {
  return a === b || a === "count" || b === "count" || a === "other" || b === "other";
}

const HEDGES = /(по данным|по информации|как пишет|как сообщает|сообщает|сообщают|сообщается|утвержда|якобы|по слухам|неподтвержд|возможно|может|могут|ожидается|прогноз|оценк|по мнению|считает|пишет|отмечает|заяв|говорит|источник)/iu;

// JS `\b` is ASCII-only, so Cyrillic words need explicit letter lookarounds.
const W = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${s})(?![\\p{L}\\p{N}])`, "iu");
const FORBIDDEN: Array<[RegExp, string]> = [
  [W("покупаем|покупайте|закупаемся|закупайтесь|шортим|лонгуем|заходим в|тарим"), "призыв к сделке"],
  [W("\\d{2,4}\\s?x|иксы|иксов"), "обещание иксов"],
  [W("гарантирован(?:о|а|ы|ный|ная)?|без\\s?риска|безрисков(?:ый|ая|о)|точно (?:полетит|вырастет|упадёт|упадет)|железно|100%"), "ложная уверенность"],
  [/to the moon|туземун|ту зе мун/iu, "хайп"],
  [W("не является финансовой рекомендацией|nfa|dyor"), "шаблонный дисклеймер"],
];

export function validateDraft(text: string, facts: VerifiedFact[], opts: { maxChars?: number; minChars?: number; hasRumorOrPrediction?: boolean } = {}): ValidationResult {
  const violations: Violation[] = [];
  const t = text.trim();
  const maxChars = opts.maxChars ?? 500;
  if (t.length > maxChars) violations.push({ code: "TOO_LONG", message: `Длина ${t.length} символов, максимум ${maxChars}`, severity: t.length > maxChars * 2 ? "block" : "warn" });
  if (t.length < (opts.minChars ?? 40)) violations.push({ code: "TOO_SHORT", message: `Слишком коротко: ${t.length} символов`, severity: "block" });
  if (/^\s*(срочно|breaking|молния)/iu.test(t)) violations.push({ code: "URGENT_OPENER", message: "Пост начинается со «СРОЧНО»", severity: "warn" });
  const hashtags = (t.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (hashtags >= 2) violations.push({ code: "HASHTAGS", message: `Набор хэштегов (${hashtags})`, severity: "warn" });
  const emoji = (t.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (emoji > 2) violations.push({ code: "EMOJI_SPAM", message: `Слишком много emoji (${emoji})`, severity: "warn" });
  const cyr = (t.match(/[а-яё]/giu) ?? []).length;
  const lat = (t.match(/[a-z]/giu) ?? []).length;
  if (cyr < 20 || cyr < lat) violations.push({ code: "NOT_RUSSIAN", message: "Текст не похож на русский пост", severity: "block" });
  for (const [re, label] of FORBIDDEN) {
    const m = t.match(re);
    if (m) violations.push({ code: "FORBIDDEN_PHRASE", message: `${label}: «${m[0]}»`, severity: "block" });
  }

  const numbers = extractNumbers(t);
  const factValues = facts.map((f, i) => ({ i, f, v: factValue(f) }));
  const matched = new Set<number>();
  const hasAttribution = /(по данным|как пишет|как сообщает|сообщает|сообщают|сообщается|@[a-z0-9_.]+|по информации|источник|пишет|отмечает|заявил|заявила|заявили|аналитик)/iu.test(t);
  for (const n of numbers) {
    if (isExempt(n, t)) continue;
    const hits = factValues.filter((x) => x.v && unitsCompatible(n.unit, x.v.unit) && sameNumber(n.value, x.v.value));
    if (hits.length === 0) {
      violations.push({ code: "INVENTED_NUMBER", message: `Число «${n.raw}» отсутствует в фактах`, severity: "block" });
      continue;
    }
    for (const h of hits) matched.add(h.i);
    if (hits.every((h) => h.f.status === "CONTRADICTED")) {
      violations.push({ code: "CONTRADICTED_NUMBER", message: `Число «${n.raw}» противоречит рыночным данным (${hits[0]!.f.evidence ?? "проверка"})`, severity: "block" });
    } else if (hits.every((h) => h.f.status === "UNVERIFIED") && !hasAttribution) {
      violations.push({ code: "UNVERIFIED_WITHOUT_ATTRIBUTION", message: `Число «${n.raw}» не подтверждено независимо и подано без атрибуции`, severity: "warn" });
    }
  }
  const rumorLike = opts.hasRumorOrPrediction ?? facts.some((f) => f.certainty === "RUMOR" || f.certainty === "PREDICTION");
  if (rumorLike && !HEDGES.test(t)) {
    violations.push({ code: "UNCERTAINTY_LOST", message: "В источнике есть слухи/прогнозы, а в тексте нет ни одной оговорки", severity: "warn" });
  }
  const blocking = violations.some((v) => v.severity === "block");
  return { ok: violations.length === 0, blocking, violations, numbersInText: numbers.map((n) => n.raw), matchedFacts: [...matched] };
}
