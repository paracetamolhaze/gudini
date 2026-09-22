import type { VerifiedFact } from "../analysis/schemas.js";

/**
 * Deterministic guard between the model and the account. It does not judge style; it checks the
 * things that get a crypto account in trouble: numbers that were not in the facts, contradicted
 * numbers, lost uncertainty, unverified numbers without attribution, hype phrasing, format.
 */
export interface Violation {
  code:
    | "INVENTED_NUMBER"
    | "WRONG_DIRECTION"
    | "CONTRADICTED_NUMBER"
    | "UNVERIFIED_WITHOUT_ATTRIBUTION"
    | "UNCERTAINTY_LOST"
    | "FORBIDDEN_PHRASE"
    | "LINK_NOT_ALLOWED"
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

// Same URL shape X bills a post for (x/client.ts), with the global flag so every link can be found.
const URL_RE = /\bhttps?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|xyz|co|ru|me|app|fi|gg|ai)\b(?:\/\S*)?/gi;

const trimUrl = (u: string): string => u.replace(/[.,;:!?)\]»"'…]+$/u, "");

export function findUrls(text: string): string[] {
  return (text.match(URL_RE) ?? []).map(trimUrl).filter(Boolean);
}

/**
 * A link is an address, not a sentence: its digits, latin letters and "#" must not be read as
 * invented numbers, as English or as hashtags. Masking keeps the length, so limits stay honest.
 */
export function maskUrls(text: string): string {
  return text.replace(URL_RE, (u) => "·".repeat(u.length));
}

/** The same text without its links — what goes to X when no separate X variant survived. */
export function withoutLinks(text: string): string {
  return text
    .replace(URL_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Threads may carry exactly one link — mine; on X a post with a link costs ~13x, so none is allowed. */
export function linkProblems(text: string, links: "none" | string): string[] {
  const urls = findUrls(text);
  if (!urls.length) return [];
  if (links === "none") return [`ссылка «${urls[0]}» — пост со ссылкой на X стоит в 13 раз дороже`];
  const allowed = trimUrl(links).toLowerCase();
  const stray = urls.filter((u) => u.toLowerCase() !== allowed);
  if (stray.length) return [`посторонняя ссылка «${stray[0]}»`];
  return urls.length > 1 ? ["моя ссылка стоит в тексте несколько раз"] : [];
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

const NUMBER_RE = /(?<sign>(?<=[\s(\[]|^)[-−–])?\s?(?<cur>\$|€|£|₽)?\s?(?<num>\d{1,3}(?:[  ,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s?(?<suffix>k|m|mm|mn|b|bn|t|тыс\.?|тысяч[аи]?|млн\.?|миллион(?:а|ов)?|млрд\.?|миллиард(?:а|ов)?|трлн\.?|триллион(?:а|ов)?)?\s?(?<unit>%|процент(?:а|ов)?|btc|eth|sol|usd|usdt|usdc|долл(?:ара|аров)?|\$)?/giu;

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
    // "-5,2%" is minus five, not five: the facts about a falling market are negative too.
    if (g.sign) value = -value;
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

/** "x10" and "10x": the digits belong to a leverage claim and must be checked against the facts. */
function nearLeverage(text: string, n: ExtractedNumber): boolean {
  const before = text.slice(Math.max(0, n.index - 2), n.index);
  const after = text.slice(n.index + n.raw.length, n.index + n.raw.length + 2);
  return /[xх]\s?$/i.test(before) || /^\s?[xх](?![\p{L}])/iu.test(after);
}

function isExempt(n: ExtractedNumber, text: string): boolean {
  if (nearLeverage(text, n)) return false;
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
/**
 * Запреты по языкам. Раньше список был один и целиком русский, а текст для X пишется по-английски —
 * то есть на второй площадке замок фактически не работал: «guaranteed», «buy now», «risk-free» и
 * «easy money» уходили без единого замечания. Общие правила действуют всегда, языковые добавляются
 * к ним по opts.language.
 */
const FORBIDDEN_ANY: Array<[RegExp, string]> = [
  [W("\\d{2,4}\\s?[xх]|[xх]\\s?\\d{2,4}|иксы|иксов"), "обещание иксов"],
  [/to the moon|туземун|ту зе мун/iu, "хайп"],
  [W("не является финансовой рекомендацией|nfa|dyor"), "шаблонный дисклеймер"],
  [W("100%"), "ложная уверенность"],
];

const FORBIDDEN_RU: Array<[RegExp, string]> = [
  [W("покупаем|покупайте|закупаемся|закупайтесь|шортим|лонгуем|заходим в|тарим"), "призыв к сделке"],
  [W("гарантирован(?:о|а|ы|ный|ная)?|без\\s?риска|безрисков(?:ый|ая|о)|точно (?:полетит|вырастет|упадёт|упадет)|железно"), "ложная уверенность"],
  // Пост может закончиться указанием, где я торгую; рекламой аккаунта он стать не должен.
  [W("подписывайтесь|подписывайся|подпишись|подпишитесь|переходи(?:те)? по ссылке|жми(?:те)? (?:на )?ссылку|регистрируйся|регистрируйтесь|не упусти(?:те)?|успей(?:те)? зайти"), "рекламный призыв"],
  [W("заработай(?:те)?|заработаешь|заработаете|л[ёе]гкие деньги|л[ёе]гкий профит|пассивный доход|удвои(?:шь|те) депозит"), "обещание заработка"],
];

const FORBIDDEN_EN: Array<[RegExp, string]> = [
  [W("buy(?:\\s+(?:now|the\\s+dip))?|aping\\s+in|ape\\s+in|load(?:ing)?\\s+up|full\\s+port|all\\s+in"), "призыв к сделке"],
  [W("guaranteed|risk[-\\s]?free|can.?t\\s+lose|sure\\s+thing|no[-\\s]brainer|going\\s+straight\\s+up"), "ложная уверенность"],
  [W("subscribe|follow\\s+me|join\\s+now|link\\s+in\\s+bio|don.?t\\s+miss|last\\s+chance|hurry"), "рекламный призыв"],
  [W("easy\\s+money|free\\s+money|passive\\s+income|life[-\\s]changing\\s+money|double\\s+your"), "обещание заработка"],
];

const forbiddenFor = (language: "ru" | "en"): Array<[RegExp, string]> => [...FORBIDDEN_ANY, ...(language === "en" ? FORBIDDEN_EN : FORBIDDEN_RU)];

export interface ValidateOptions {
  maxChars?: number;
  minChars?: number;
  hasRumorOrPrediction?: boolean;
  /** Language the text is supposed to be in (X may be run in English). */
  language?: "ru" | "en";
  /** Leverage of the owner's own trade: "x10"/"10x" with this number is a fact, not a promise of multiples. */
  allowedMultiples?: number[];
  /** Links: unchecked by default. "none" — any link is a violation (X); a URL — only that link is allowed (Threads). */
  links?: "none" | string;
}

export function validateDraft(text: string, facts: VerifiedFact[], opts: ValidateOptions = {}): ValidationResult {
  const violations: Violation[] = [];
  const t = text.trim();
  // Length is counted with the link (the platform counts it too); every other check reads it masked.
  const body = maskUrls(t);
  const maxChars = opts.maxChars ?? 500;
  if (t.length > maxChars) violations.push({ code: "TOO_LONG", message: `Длина ${t.length} символов, максимум ${maxChars}`, severity: t.length > maxChars * 2 ? "block" : "warn" });
  if (t.length < (opts.minChars ?? 40)) violations.push({ code: "TOO_SHORT", message: `Слишком коротко: ${t.length} символов`, severity: "block" });
  if (/^\s*(срочно|breaking|молния)/iu.test(t)) violations.push({ code: "URGENT_OPENER", message: "Пост начинается со «СРОЧНО»", severity: "warn" });
  if (opts.links !== undefined) {
    for (const p of linkProblems(t, opts.links)) violations.push({ code: "LINK_NOT_ALLOWED", message: p.charAt(0).toUpperCase() + p.slice(1), severity: "block" });
  }
  // Тег в конце нужен для того, чтобы пост нашли по теме. В Threads кликается только первый,
  // в X больше двух читаются как спам — поэтому предел зависит от площадки, а не «любой тег плохо».
  const tagLimit = (opts.language ?? "ru") === "en" ? 2 : 1;
  const tags = body.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  const hashtags = tags.length;
  // Тег в русском посте пишется по-русски, в английском — по-английски: его смысл в том, чтобы
  // пост нашли свои, а по латинскому тегу в Threads придёт не та аудитория.
  const wrongTag = tags.find((tag) => ((opts.language ?? "ru") === "en" ? /[а-яё]/i.test(tag) : /[a-z]/i.test(tag)));
  if (wrongTag) violations.push({ code: "HASHTAGS", message: `Тег «${wrongTag}» не на том языке: в ${(opts.language ?? "ru") === "en" ? "X теги английские" : "Threads теги русские"}`, severity: "warn" });
  if (hashtags > tagLimit) violations.push({ code: "HASHTAGS", message: `Тегов ${hashtags}, а нужно не больше ${tagLimit}${tagLimit === 1 ? " — в Threads кликается только первый" : ""}`, severity: "warn" });
  const emoji = (t.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (emoji > 2) violations.push({ code: "EMOJI_SPAM", message: `Слишком много emoji (${emoji})`, severity: "warn" });
  const cyr = (body.match(/[а-яё]/giu) ?? []).length;
  const lat = (body.match(/[a-z]/giu) ?? []).length;
  if ((opts.language ?? "ru") === "en") {
    if (lat < 20 || lat < cyr) violations.push({ code: "NOT_RUSSIAN", message: "Текст для X должен быть на английском", severity: "block" });
  } else if (cyr < 20 || cyr < lat) violations.push({ code: "NOT_RUSSIAN", message: "Текст не похож на русский пост", severity: "block" });
  for (const [re, label] of forbiddenFor(opts.language ?? "ru")) {
    const m = body.match(re);
    // The owner's own leverage is a fact; it may be written either way round.
    const multiple = m ? /^(?:([0-9]{1,4})\s?[xх]|[xх]\s?([0-9]{1,4}))$/i.exec(m[0]) : null;
    const multipleValue = multiple ? Number(multiple[1] ?? multiple[2]) : null;
    if (multipleValue !== null && opts.allowedMultiples?.includes(multipleValue)) continue;
    if (m) violations.push({ code: "FORBIDDEN_PHRASE", message: `${label}: «${m[0]}»`, severity: "block" });
  }

  const numbers = extractNumbers(body);
  const factValues = facts.map((f, i) => ({ i, f, v: factValue(f) }));
  const matched = new Set<number>();
  const hasAttribution = /(по данным|как пишет|как сообщает|сообщает|сообщают|сообщается|@[a-z0-9_.]+|по информации|источник|пишет|отмечает|заявил|заявила|заявили|аналитик)/iu.test(body);
  // A post about a drop usually writes "упал на 12%", while the fact is -12. Same number, opposite
  // spelling: match on size for percentages, and complain separately if the direction is wrong.
  const fallsInText = /(упал|упад|сниж|снизил|потерял|минус|обвал|просел|down|dropped|fell|losing)/iu.test(body);
  for (const n of numbers) {
    if (isExempt(n, body)) continue;
    const sizeMatch = (a: number, b: number): boolean => sameNumber(a, b) || (n.unit === "percent" && sameNumber(Math.abs(a), Math.abs(b)));
    const hits = factValues.filter((x) => x.v && unitsCompatible(n.unit, x.v.unit) && sizeMatch(n.value, x.v.value));
    const wrongWay = hits.length > 0 && n.unit === "percent" && n.value > 0 && hits.every((h) => h.v!.value < 0) && !fallsInText;
    if (wrongWay) {
      violations.push({ code: "WRONG_DIRECTION", message: `Число «${n.raw}» в фактах со знаком минус, а в тексте подано как рост`, severity: "block" });
      for (const h of hits) matched.add(h.i);
      continue;
    }
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
  if (rumorLike && !HEDGES.test(body)) {
    violations.push({ code: "UNCERTAINTY_LOST", message: "В источнике есть слухи/прогнозы, а в тексте нет ни одной оговорки", severity: "warn" });
  }
  const blocking = violations.some((v) => v.severity === "block");
  return { ok: violations.length === 0, blocking, violations, numbersInText: numbers.map((n) => n.raw), matchedFacts: [...matched] };
}
