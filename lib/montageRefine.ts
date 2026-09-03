import { chainTimeline, MontagePlan, MontageEvent } from "./creativeDirector";
import { StoryAssetPackV2, PackAsset, pickFrameForNeeds } from "./storyAssetPack";
import { Word } from "./transcribe";
import { taste } from "./montageTaste";
import { groupWordsIntoPhrases } from "./subtitles";
import { isFunctionWord } from "./scriptPunctuation";

/**
 * Уплотнение плана режиссёра по блокам сценария — детерминированно, без второго
 * платного вызова.
 *
 * Режиссёр на проекте Хендерсона отдал 10 карточек на 57 секунд: две по 6.3 с
 * подряд и одна на 16.6 с. Валидатор это пропускал (длина вставки — предупреждение),
 * а смотреть такое нельзя. Здесь трек перестраивается от блоков сценария:
 *  - отрезок каждого блока — по времени его слов в речи (выравнивание по двум
 *    первым значимым словам ≥4 букв с терпимостью к окончаниям; «так», «его» не в счёт);
 *  - выбор режиссёра закрепляется за тем из перекрытых им блоков, где у кадра выше
 *    оценка сопоставления (гипс — на «рука в гипсе», медики — на «носилках»);
 *  - блоки с самым коротким списком сильных кандидатов получают материал первыми —
 *    иначе портреты героя уходят в начало, а концовке нечего показывать;
 *  - отрезок длиннее max_visual_duration делится по границам фраз субтитров; части
 *    заполняются своими кандидатами, запасной пул контекста — только для отрезков
 *    длиннее 8 с (на коротком лучше одна карточка чуть длиннее нормы, чем чужой кадр);
 *  - порядок частей внутри отрезка — по совпадению сказанных слов с описанием кадра.
 * Правила проекта соблюдаются: материал используется один раз, у каждой вставки —
 * дословная цитата речи, две соседние карточки всегда разные.
 */

export type RefineBeat = { id: string; text: string; visualNeed: string };
export type RefineNeed = { beatId: string; intent?: string; entities?: string[]; visualDescription: string };
export type RefineSlot = { beatId: string; start: number; end: number; need: string };
export type RefineResult = { plan: MontagePlan; slots: RefineSlot[]; notes: string[] };

/** Речь ↔ описание кадра: кадр встаёт туда, где о нём говорят. */
const SYNC: [RegExp, RegExp][] = [
  [/гипс|перелом|бинт/i, /cast|bandag|wrist|plaster|sling/i],
  [/носилк|увозят|уносят|врач|медик|больниц/i, /stretcher|medic|injur|treat|physio|carried/i],
  [/судь|карточк|спор/i, /referee|card|argu|protest/i],
  [/скамейк|запас|тренер/i, /bench|dugout|substitut|sideline|coach|manager/i],
  [/щит|перепрыг|кромк/i, /advertis|board|hoarding|jump/i],
  [/падает|спотык|упал/i, /fall|ground|lies|stumbl|collaps/i],
  [/празд|побежда|свист|четвертьфинал/i, /celebrat|applau|cheer|victory|win/i],
  [/стадион|чемпионат|мексик|англи|матч/i, /stadium|crowd|fans|pitch|match/i],
  [/хендерсон|футболист|человек/i, /henderson|portrait|player|footballer|man\b/i],
];
/** Запасной пул контекста — только когда отрезок длиннее этого. */
const FALLBACK_MIN_LEN = 8;

const skeleton = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");
function sameStem(a: string, b: string): boolean {
  if (!a || !b || Math.abs(a.length - b.length) > 3) return false;
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n >= Math.max(3, Math.min(a.length, b.length) - 2);
}

/** Начало каждого блока в речи (null — не найдено). */
export function beatStarts(beats: RefineBeat[], words: Word[]): (number | null)[] {
  const sk = words.map((w) => skeleton(w.word));
  let j = 0;
  return beats.map((b) => {
    const toks = String(b.text).split(/\s+/).map(skeleton).filter((t) => t.length >= 4).slice(0, 5);
    if (!toks.length) return null;
    const heads = toks.slice(0, 2);
    const lim = Math.min(words.length, j + 80);
    let hit = -1;
    for (let k = j; k < lim && hit < 0; k++) {
      if (!heads.some((t) => sameStem(sk[k], t))) continue;
      let found = 0;
      for (let m = k; m < Math.min(words.length, k + 8); m++) if (toks.some((t) => sameStem(sk[m], t))) found++;
      if (found >= Math.min(2, toks.length)) hit = k;
    }
    if (hit < 0) return null;
    j = hit + 1;
    return words[hit].start;
  });
}

function permutations<X>(xs: X[]): X[][] {
  return xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

export function refineMontage(args: {
  montage: MontagePlan;
  pack: StoryAssetPackV2;
  beats: RefineBeat[];
  needs: RefineNeed[];
  words: Word[];
  duration: number;
  /** имена людей-героев истории: их портреты годятся любому блоку о них (оценка 1) */
  personNames?: string[];
}): RefineResult {
  const { montage, pack, beats, needs, words, duration } = args;
  const T = taste();
  const MIN = T.min_visual_duration;
  const TYP = T.typical_visual_duration;
  const MAX = T.max_visual_duration;
  const FIRST_BY = T.first_visual_by;
  const notes: string[] = [];
  const byId = new Map<string, PackAsset>(pack.assets.map((a) => [a.id, a]));
  const needOf = (beatId: string) => needs.find((n) => n.beatId === beatId);
  const persons = (beatId: string) => {
    const names = (args.personNames ?? []).map((n) => n.toLowerCase());
    return (needOf(beatId)?.entities ?? []).filter((e) => names.length ? names.includes(e.toLowerCase()) : false);
  };

  // 1) отрезки блоков по времени речи
  const starts = beatStarts(beats, words);
  const slots: RefineSlot[] = [];
  beats.forEach((b, i) => {
    const s = starts[i];
    if (s == null) {
      notes.push(`блок ${b.id}: начало в речи не найдено — присоединён к предыдущему`);
      return;
    }
    if (b.visualNeed === "NONE") return; // блок без визуала: предыдущая карточка продолжается
    slots.push({ beatId: b.id, start: s, end: duration, need: b.visualNeed });
  });
  if (!slots.length) return { plan: montage, slots, notes: [...notes, "ни один блок не найден в речи — план режиссёра оставлен как есть"] };
  for (let i = 0; i < slots.length; i++) slots[i].end = i + 1 < slots.length ? slots[i + 1].start : duration;
  slots[0].start = FIRST_BY; // первая карточка — ровно к концу вступительного наезда
  // Короткий отрезок (после чистки речи «с поля на носилках» длится 1.5 с) не
  // исчезает, а занимает недостающее у соседа, если тот остаётся не короче минимума:
  // сначала у предыдущего (картинка встаёт чуть раньше слов — это естественно),
  // потом у следующего. Только если занять не у кого — сливается с предыдущим.
  for (let i = 1; i < slots.length; ) {
    const len = slots[i].end - slots[i].start;
    if (len >= MIN) {
      i++;
      continue;
    }
    const need = MIN - len + 0.05;
    const prev = slots[i - 1];
    const next = slots[i + 1];
    if (prev.end - prev.start - need >= MIN) {
      prev.end -= need;
      slots[i].start = prev.end;
      i++;
    } else if (next && next.end - next.start - need >= MIN) {
      next.start += need;
      slots[i].end = next.start;
      i++;
    } else {
      notes.push(`блок ${slots[i].beatId}: ${len.toFixed(1)}с — слит с предыдущим, занять не у кого`);
      prev.end = slots[i].end;
      slots.splice(i, 1);
    }
  }

  // 2) кандидаты блока: свои (по оценке) и материалы блоков о том же человеке (оценка 1)
  const beatIdx = new Map<string, number>(beats.map((b, i) => [b.id, i]));
  const candidates = (beatId: string): { a: PackAsset; s: number }[] => {
    const out = new Map<string, { a: PackAsset; s: number }>();
    for (const a of pack.assets) {
      const own = a.beatScores?.[beatId] ?? 0;
      if (own >= 1) out.set(a.id, { a, s: own });
    }
    const mine = persons(beatId);
    if (mine.length) {
      for (const a of pack.assets) {
        if (out.has(a.id)) continue;
        const viaPerson = beats.some((b) => (a.beatScores?.[b.id] ?? 0) >= 2 && persons(b.id).some((p) => mine.includes(p)));
        if (viaPerson) out.set(a.id, { a, s: 1 });
      }
    }
    return [...out.values()];
  };
  // выбор режиссёра резервируется за одним из перекрытых его вставкой блоков: за тем,
  // где у кадра выше оценка; при равенстве — за блоком, который назвал режиссёр
  const reserved = new Map<string, string>(); // assetId → beatId
  for (const e of montage.events) {
    if (reserved.has(e.assetId)) continue;
    const a = byId.get(e.assetId);
    const overlapped = slots
      .map((s) => ({ s, ov: Math.min(e.end, s.end) - Math.max(e.start, s.start) }))
      .filter(({ ov }) => ov >= 0.5)
      .sort(
        (x, y) =>
          (a?.beatScores?.[y.s.beatId] ?? 0) - (a?.beatScores?.[x.s.beatId] ?? 0) ||
          (y.s.beatId === e.beatId ? 1 : 0) - (x.s.beatId === e.beatId ? 1 : 0) ||
          y.ov - x.ov,
      );
    const target = overlapped.find(({ s }) => ![...reserved.values()].includes(s.beatId))?.s;
    if (target) reserved.set(e.assetId, target.beatId);
  }
  const used = new Set<string>();
  const fit = (beatId: string, a: PackAsset) => {
    const need = needOf(beatId);
    return need ? pickFrameForNeeds([{ description: a.description }], [need]).score : 0;
  };
  const free = (beatId: string, a: PackAsset) => !used.has(a.id) && (!reserved.has(a.id) || reserved.get(a.id) === beatId);
  const order = (a: PackAsset) => pack.assets.indexOf(a);
  const ranked = (beatId: string) =>
    candidates(beatId)
      .filter(({ a }) => free(beatId, a))
      .sort((x, y) => {
        const rx = reserved.get(x.a.id) === beatId ? 2 : 0;
        const ry = reserved.get(y.a.id) === beatId ? 2 : 0;
        return y.s + ry - (x.s + rx) || fit(beatId, y.a) - fit(beatId, x.a) || order(x.a) - order(y.a);
      });
  const fallback = (beatId: string) =>
    pack.assets
      .filter((a) => free(beatId, a) && Math.max(0, ...Object.values(a.beatScores ?? {}).map(Number)) >= 2)
      .map((a) => {
        const best = Object.entries(a.beatScores ?? {}).sort((x, y) => Number(y[1]) - Number(x[1]))[0]?.[0] ?? "";
        return { a, dist: Math.abs((beatIdx.get(best) ?? 0) - (beatIdx.get(beatId) ?? 0)) };
      })
      .sort((x, y) => fit(beatId, y.a) - fit(beatId, x.a) || x.dist - y.dist || order(x.a) - order(y.a))
      .map((x) => x.a);

  // 3) главные кадры: блоки с самым коротким списком сильных кандидатов — первыми
  const chosenBySlot = new Map<string, PackAsset[]>();
  const strong = (beatId: string) => ranked(beatId).filter(({ s }) => s >= 2).length;
  for (const s of [...slots].sort((a, b) => strong(a.beatId) - strong(b.beatId))) {
    const first = ranked(s.beatId)[0]?.a ?? fallback(s.beatId)[0];
    if (!first) throw new Error(`уплотнение: для блока ${s.beatId} не осталось ни одного материала`);
    used.add(first.id);
    chosenBySlot.set(s.beatId, [first]);
  }
  // части длинных отрезков: сначала самые длинные; свои кандидаты (≥2, или ≥1 если
  // это выбор режиссёра либо отрезок длиннее FALLBACK_MIN_LEN), затем запасной пул
  const wasDirector = new Set(montage.events.map((e) => e.assetId));
  for (const s of [...slots].sort((a, b) => b.end - b.start - (a.end - a.start))) {
    const len = s.end - s.start;
    let parts = len > MAX ? Math.max(2, Math.round(len / TYP)) : 1;
    parts = Math.min(parts, Math.floor(len / MIN));
    const chosen = chosenBySlot.get(s.beatId)!;
    while (chosen.length < parts) {
      const own = ranked(s.beatId).find(({ a, s: sc }) => sc >= 2 || ((len > FALLBACK_MIN_LEN || wasDirector.has(a.id)) && sc >= 1))?.a;
      const alt = own ?? (len > FALLBACK_MIN_LEN ? fallback(s.beatId)[0] : undefined);
      if (!alt) break;
      used.add(alt.id);
      chosen.push(alt);
    }
  }

  // 4) события: границы частей — по ближайшей границе фразы субтитров; порядок частей —
  //    по совпадению речи с описанием; цитата — слова под вставкой
  const phrases = groupWordsIntoPhrases(words, 6);
  const boundaries = phrases.map((p) => p.start).filter((t) => t > FIRST_BY);
  const nearestBoundary = (t: number, lo: number, hi: number) => {
    let best = t;
    let d = Infinity;
    for (const b of boundaries) {
      if (b <= lo + MIN || b >= hi - MIN) continue;
      if (Math.abs(b - t) < d) {
        d = Math.abs(b - t);
        best = b;
      }
    }
    return best;
  };
  const quoteFor = (start: number, end: number) =>
    words
      .filter((w) => w.end > start && w.start < end)
      .map((w) => w.word.replace(/[{}\\]/g, ""))
      .slice(0, 12)
      .join(" ");
  const syncScore = (spoken: string[], a: PackAsset) =>
    SYNC.reduce((n, [ru, en]) => n + (spoken.some((w) => ru.test(w)) && en.test(String(a.description)) ? 1 : 0), 0);
  const events: MontageEvent[] = [];
  for (const s of slots) {
    const chosen = chosenBySlot.get(s.beatId)!;
    const n = chosen.length;
    const len = s.end - s.start;
    const ranges: [number, number][] = [];
    let from = s.start;
    for (let k = 0; k < n; k++) {
      const to = k === n - 1 ? s.end : nearestBoundary(s.start + (len * (k + 1)) / n, from, s.end);
      ranges.push([from, to]);
      from = to;
    }
    const spokenIn = ranges.map(([a, b]) => words.filter((w) => w.end > a && w.start < b).map((w) => w.word));
    let bestOrder = chosen;
    let bestSync = -1;
    for (const perm of permutations(chosen)) {
      const sc = perm.reduce((acc, a, k) => acc + syncScore(spokenIn[k], a), 0);
      if (sc > bestSync) {
        bestSync = sc;
        bestOrder = perm;
      }
    }
    bestOrder.forEach((a, k) => {
      const [st, en] = ranges[k];
      events.push({ type: "EXTERNAL_IMAGE", assetId: a.id, beatId: s.beatId, quote: quoteFor(st, en), start: st, end: en, layout: "smart_crop", motion: "static", role: a.role });
    });
  }
  chainTimeline(events, duration);
  notes.push(`карточек: ${montage.events.length} → ${events.length}`);
  // «служебные слова» из subtitles нужны только для типов; здесь импорт держит модуль общим
  void isFunctionWord;
  return { plan: { ...montage, events }, slots, notes };
}
