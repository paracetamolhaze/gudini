/**
 * Время публикации по расписанию. Пользователь выбирает дату и время в своём часовом поясе
 * (по умолчанию Asia/Qyzylorda), сервер хранит момент в UTC. Чистые функции без сети —
 * одинаково работают в браузере и на сервере.
 */

export const DEFAULT_TIME_ZONE = "Asia/Qyzylorda";

export const COMMON_TIME_ZONES = ["Asia/Qyzylorda", "Asia/Almaty", "Asia/Tashkent", "Asia/Yekaterinburg", "Europe/Moscow", "Europe/Kyiv", "Europe/Berlin", "UTC"];

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsInZone(ms: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const get = (type: string) => Number(f.formatToParts(new Date(ms)).find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** Смещение часового пояса от UTC в минутах в указанный момент. */
export function zoneOffsetMinutes(ms: number, tz: string): number {
  const p = partsInZone(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * «2026-09-14T10:00» в поясе tz → момент UTC (мс). null — неверная строка или время, которого
 * в этом поясе нет (переход на летнее время).
 */
export function zonedLocalToUtc(local: string, tz: string): number | null {
  const m = LOCAL_RE.exec(local);
  if (!m || !isValidTimeZone(tz)) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - zoneOffsetMinutes(guess, tz) * 60_000;
  const second = guess - zoneOffsetMinutes(t, tz) * 60_000;
  if (second !== t) t = second;
  return utcToZonedLocal(t, tz) === local ? t : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function utcToZonedLocal(ms: number, tz: string): string {
  const p = partsInZone(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function offsetLabel(ms: number, tz: string): string {
  const off = zoneOffsetMinutes(ms, tz);
  const sign = off < 0 ? "−" : "+";
  const abs = Math.abs(off);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ""}`;
}

/** «14 сентября 2026, 10:00 · Asia/Qyzylorda (UTC+5)» */
export function formatInZone(ms: number, tz: string): string {
  const text = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  return `${text} · ${tz} (${offsetLabel(ms, tz)})`;
}

/** Месяц бюджета «2026-09» по часовому поясу раздела. */
export function monthKey(ms: number, tz = DEFAULT_TIME_ZONE): string {
  const p = partsInZone(ms, tz);
  return `${p.year}-${pad(p.month)}`;
}
