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

export type EditEvent = {
  type: EditEventType;
  start: number; // сек на чистом (после вырезки пауз) таймлайне
  end: number;
  // B_ROLL
  query?: string;
  altQueries?: string[];
  visualIntent?: VisualIntent;
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
  maxWords: 3,
  uppercase: true,
  highlightKeyword: false,
  position: "lower",
  fontSize: 84,
};

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
};

const LIMITS: Record<string, { min: number; max: number; count: number }> = {
  B_ROLL: { min: 2.0, max: 7.0, count: 8 },
  PUNCH_IN: { min: 1.2, max: 8.0, count: 5 },
  TEXT_CALLOUT: { min: 1.0, max: 4.5, count: 4 },
};

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
      if (!query || start < 1.2) continue;
      event.query = query;
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
    } else if (type === "PUNCH_IN") {
      const scale = Number(raw.scale);
      event.scale = Number.isFinite(scale) ? Math.min(1.1, Math.max(1.03, scale)) : 1.06;
    } else if (type === "TEXT_CALLOUT") {
      const text = String(raw.text ?? "").trim();
      if (!text) continue;
      event.text = text.slice(0, 40);
    }
    candidates.push(event);
  }

  // дорожки: B_ROLL — видеоисточник; PUNCH_IN — эффект A-roll; TEXT_CALLOUT — текст.
  const result: EditEvent[] = [];
  for (const type of ["B_ROLL", "PUNCH_IN", "TEXT_CALLOUT"] as const) {
    // панч-ины нормируются по длительности (~5 на минуту) и требуют зазор ≥5с — никакого «дёргания камеры»
    const maxCount =
      type === "PUNCH_IN"
        ? Math.max(1, Math.min(8, Math.round((duration / 60) * 5)))
        : LIMITS[type].count;
    const minGap = type === "PUNCH_IN" ? 5.0 : 0.4;
    const track = candidates
      .filter((e) => e.type === type)
      .sort((a, b) => a.start - b.start)
      .slice(0, maxCount * 3);
    let prevEnd = -Infinity;
    let kept = 0;
    for (const ev of track) {
      if (kept >= maxCount) break;
      if (ev.start < prevEnd + minGap) continue; // пересечение/впритык внутри дорожки
      // пан-ин поверх б-ролла бессмыслен: лицо всё равно закрыто
      if (type === "PUNCH_IN" && result.some((b) => b.type === "B_ROLL" && overlaps(b, ev))) continue;
      result.push(ev);
      prevEnd = ev.end;
      kept++;
    }
  }
  return result.sort((a, b) => a.start - b.start);
}

function overlaps(a: EditEvent, b: EditEvent): boolean {
  return a.start < b.end && b.start < a.end;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
