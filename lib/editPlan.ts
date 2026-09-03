import { Word } from "./transcribe";

/**
 * EditPlan — структурированный монтажный план (EDL).
 * ИИ-планировщик создаёт его, рендерер детерминированно исполняет.
 * План сохраняется в uploads/{id}/edit-plan.json — задел под ручной редактор.
 */

export type EditEventType = "A_ROLL" | "B_ROLL" | "PUNCH_IN" | "TEXT_CALLOUT";

/** Что должно быть видно в перебивке: для semantic-отбора стока. */
export type VisualIntent = {
  subject: string; // главный объект в кадре
  action: string; // что происходит
  environment: string; // окружение
  mood: string;
  mustHave: string[]; // без этого кандидат отклоняется
  avoid: string[]; // с этим кандидат отклоняется
};

/**
 * Откуда брать визуал. Для конкретных сущностей generic-сток — почти последний
 * вариант: «Англия играет с Мексикой» не иллюстрируется случайным стадионом.
 */
export type VisualSourceIntent =
  | "GENERIC_STOCK"
  | "PERSON"
  | "TEAM_MATCHUP"
  | "SPECIFIC_EVENT"
  | "LOCATION"
  | "GRAPHIC";

/**
 * Насколько конкретен визуал, который требуется фразе.
 * EXACT — именно это событие («Хендерсон прыгает через щит»): подмена запрещена.
 * ENTITY — конкретный человек/команда в любой ситуации.
 * GENERAL — общая иллюстрация («болельщики празднуют»).
 */
export type FactualSpecificity = "EXACT" | "ENTITY" | "GENERAL";

/**
 * Как показывается внешний материал.
 * top_inset — прямоугольник в верхней части поверх автора; автор виден.
 * fullscreen — старая полноэкранная перебивка, в новом монтаже не используется.
 */
export type EventLayout = "top_inset" | "fullscreen";

export type EditEvent = {
  type: EditEventType;
  /**
   * Раскладка вставки. У старых сохранённых планов поля нет — тогда берётся
   * top_inset: автор в кадре остаётся при любом раскладе, и это безопаснее,
   * чем неожиданно перекрыть его на весь экран.
   */
  layout?: EventLayout;
  start: number; // сек на чистом (после вырезки пауз) таймлайне
  end: number;
  // B_ROLL
  query?: string;
  altQueries?: string[];
  /** 3–6 поисковых формулировок для фактического поиска в открытых источниках */
  queries?: string[];
  visualIntent?: VisualIntent;
  sourceIntent?: VisualSourceIntent;
  factualSpecificity?: FactualSpecificity;
  entityName?: string; // «Jordan Henderson», «England vs Mexico»
  eventName?: string; // «jump over advertising board after match»
  graphicLines?: string[]; // текст для собственной motion-графики
  file?: string; // заполняется после подбора материала
  // PUNCH_IN
  scale?: number;
  // TEXT_CALLOUT
  text?: string;
};

export type CaptionStyle = {
  maxWords: number;
  uppercase: boolean;
  highlightKeyword: boolean;
  position: "center" | "lower";
  fontSize: number;
};

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  // Короткая смысловая фраза, а не отдельное слово: по одному слову читать
  // тяжело, а взгляд всё время дёргается вслед за сменой текста.
  maxWords: 6,
  uppercase: true,
  highlightKeyword: false,
  position: "lower",
  fontSize: 58,
};

/** Раскладка вставки с безопасным значением для старых планов. */
export const eventLayout = (e: EditEvent): EventLayout => e.layout ?? "top_inset";

export type EditPlan = {
  version: 1;
  duration: number;
  events: EditEvent[];
  captionStyle: CaptionStyle;
  /** индексы слов для смыслового highlight в субтитрах (цифры, имена, панч-слова) */
  captionHighlights?: number[];
};

// «Сырое» событие от LLM: границы в индексах слов
export type RawPlanEvent = {
  type?: string;
  from?: number;
  to?: number;
  query?: string;
  alt?: string[];
  intent?: {
    subject?: string;
    action?: string;
    environment?: string;
    mood?: string;
    mustHave?: string[];
    avoid?: string[];
  };
  scale?: number;
  text?: string;
  sourceIntent?: string;
  factualSpecificity?: string;
  entity?: string;
  event?: string;
  queries?: string[];
  graphic?: string[];
};

const SPECIFICITY: FactualSpecificity[] = ["EXACT", "ENTITY", "GENERAL"];

// GRAPHIC (текст на чёрном фоне) убран: такая «перебивка» хуже исходного кадра.
const SOURCE_INTENTS: VisualSourceIntent[] = [
  "GENERIC_STOCK",
  "PERSON",
  "TEAM_MATCHUP",
  "SPECIFIC_EVENT",
  "LOCATION",
];

/**
 * В production остались только перебивки. PUNCH_IN отключён (пересканированная копия
 * кадра меняла цвет A-roll), TEXT_CALLOUT отключён (крупная типографика — только на обложке).
 */
const LIMITS: Record<string, { min: number; max: number; count: number }> = {
  // короткие частые вставки: визуальное состояние меняется каждые ~2–4 сек
  B_ROLL: { min: 1.5, max: 5.0, count: 18 },
};

/** Доля ролика, занятая внешними визуалами. Цель 0.55–0.65, минимум 0.50. */
export function visualCoverage(events: EditEvent[], duration: number): number {
  if (duration <= 0) return 0;
  const spans = events
    .filter((e) => e.type === "B_ROLL" && e.file)
    .map((e) => ({ start: e.start, end: e.end }))
    .sort((a, b) => a.start - b.start);
  let covered = 0;
  let cursor = -Infinity;
  for (const s of spans) {
    const from = Math.max(s.start, cursor);
    if (s.end > from) {
      covered += s.end - from;
      cursor = s.end;
    }
  }
  return Number((covered / duration).toFixed(3));
}

/** Куски, где подряд слишком долго видно только автора, — кандидаты на доп. поиск. */
export function aRollGaps(events: EditEvent[], duration: number, maxGap = 5.5): { start: number; end: number }[] {
  const spans = events
    .filter((e) => e.type === "B_ROLL" && e.file)
    .sort((a, b) => a.start - b.start);
  const gaps: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start - cursor > maxGap) gaps.push({ start: round2(cursor), end: round2(s.start) });
    cursor = Math.max(cursor, s.end);
  }
  if (duration - cursor > maxGap) gaps.push({ start: round2(cursor), end: round2(duration) });
  return gaps;
}

/**
 * Сдвигает перебивки так, чтобы они закрывали склейки после чистки речи.
 * Вырезанная запинка даёт видимый скачок лица (jump cut). Если рядом есть перебивка,
 * начинаем её чуть раньше склейки и заканчиваем позже — монтаж речи становится незаметен.
 */
export function coverSpeechCuts(
  events: EditEvent[],
  cutPoints: number[],
  duration: number,
  lead = 0.3,
  tail = 0.3,
): EditEvent[] {
  const brolls = events.filter((e) => e.type === "B_ROLL").sort((a, b) => a.start - b.start);
  for (const t of cutPoints) {
    if (!Number.isFinite(t) || t <= 0.2 || t >= duration - 0.2) continue;
    if (brolls.some((b) => b.start <= t - 0.05 && b.end >= t + 0.05)) continue; // уже закрыт

    // ближайшая перебивка, которую разумно растянуть на склейку
    const after = brolls.find((b) => b.start > t && b.start - t <= 1.6);
    const before = [...brolls].reverse().find((b) => b.end < t && t - b.end <= 1.6);
    const candidate = after ?? before;
    if (!candidate) continue;

    const idx = brolls.indexOf(candidate);
    const prev = brolls[idx - 1];
    const next = brolls[idx + 1];
    if (candidate === after) {
      const newStart = Math.max(t - lead, prev ? prev.end + 0.1 : 0.2);
      if (newStart < candidate.start) candidate.start = round2(newStart);
    } else {
      const newEnd = Math.min(t + tail, next ? next.start - 0.1 : duration - 0.1);
      if (newEnd > candidate.end) candidate.end = round2(newEnd);
    }
  }
  return events;
}

/**
 * Валидация плана от LLM: индексы слов → секунды, клампы длительностей,
 * запрет пересечений внутри дорожки, лимиты количества. Неизвестные типы
 * и битые события молча отбрасываются (fallback — обычный A-roll).
 */
export function validatePlan(rawEvents: RawPlanEvent[], words: Word[], duration: number): EditEvent[] {
  const candidates: EditEvent[] = [];
  for (const raw of rawEvents ?? []) {
    const type = String(raw.type ?? "").toUpperCase() as EditEventType;
    if (!LIMITS[type]) continue;
    const from = Math.max(0, Math.min(Math.trunc(Number(raw.from)), words.length - 1));
    const to = Math.max(from, Math.min(Math.trunc(Number(raw.to)), words.length - 1));
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;

    let start = words[from]?.start ?? NaN;
    let end = (words[to]?.end ?? NaN) + 0.15;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= duration) continue;

    const lim = LIMITS[type];
    if (end - start < lim.min) end = start + lim.min;
    if (end - start > lim.max) end = start + lim.max;
    end = Math.min(end, duration - 0.05);
    if (end - start < lim.min * 0.8) continue;

    const event: EditEvent = { type, start: round2(start), end: round2(end) };
    if (type === "B_ROLL") {
      const query = String(raw.query ?? "").trim();
      const sourceIntent = SOURCE_INTENTS.includes(raw.sourceIntent as VisualSourceIntent)
        ? (raw.sourceIntent as VisualSourceIntent)
        : "GENERIC_STOCK";
      if (!query || start < 1.8) continue; // первая фраза — лицо автора
      event.query = query;
      event.sourceIntent = sourceIntent;
      event.factualSpecificity = SPECIFICITY.includes(raw.factualSpecificity as FactualSpecificity)
        ? (raw.factualSpecificity as FactualSpecificity)
        : "GENERAL";
      if (raw.entity) event.entityName = String(raw.entity).slice(0, 60);
      if (raw.event) event.eventName = String(raw.event).slice(0, 100);
      // 3–6 формулировок для фактического поиска; primary query всегда первым
      const queries = Array.isArray(raw.queries) ? raw.queries.map((q) => String(q).trim()).filter(Boolean) : [];
      event.queries = [...new Set([query, ...queries])].slice(0, 8);
      event.altQueries = Array.isArray(raw.alt) ? raw.alt.map(String).filter(Boolean).slice(0, 3) : [];
      if (raw.intent && typeof raw.intent === "object") {
        event.visualIntent = {
          subject: String(raw.intent.subject ?? "").slice(0, 80),
          action: String(raw.intent.action ?? "").slice(0, 120),
          environment: String(raw.intent.environment ?? "").slice(0, 120),
          mood: String(raw.intent.mood ?? "").slice(0, 80),
          mustHave: Array.isArray(raw.intent.mustHave) ? raw.intent.mustHave.map(String).slice(0, 5) : [],
          avoid: Array.isArray(raw.intent.avoid) ? raw.intent.avoid.map(String).slice(0, 6) : [],
        };
      }
    }
    candidates.push(event);
  }

  // единственная дорожка — перебивки; минимального количества нет: лучше три
  // точных перебивки, чем шесть «по квоте»
  const result: EditEvent[] = [];
  const track = candidates
    .filter((e) => e.type === "B_ROLL")
    .sort((a, b) => a.start - b.start)
    .slice(0, LIMITS.B_ROLL.count * 3);
  let prevEnd = -Infinity;
  for (const ev of track) {
    if (result.length >= LIMITS.B_ROLL.count) break;
    if (ev.start < prevEnd + 0.25) continue; // пересечение/впритык
    result.push(ev);
    prevEnd = ev.end;
  }
  return result.sort((a, b) => a.start - b.start);
}

function overlaps(a: EditEvent, b: EditEvent): boolean {
  return a.start < b.end && b.start < a.end;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
