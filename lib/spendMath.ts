/**
 * Чистая арифметика журнала расходов для страниц браузера: без файлов и серверных
 * зависимостей. «Сегодня» и «месяц» считаются в часовом поясе пользователя.
 */

export type SpendRun = {
  runId: string;
  projectId: string | null;
  topic?: string;
  at: string;
  status: "done" | "failed" | "site";
  label: string;
  total: number;
  byProvider: Record<string, number>;
};

export type ManualBalance = { balance: number; at: string };
export type ManualBalances = Record<string, ManualBalance>;

export type BalanceLevel = "ok" | "low" | "empty" | "unknown" | "missing" | "error";

export const money = (v: number) => `$${v.toFixed(2)}`;

export const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfMonth(): number {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Расход по журналу с момента since: по одному провайдеру или всего. */
export function spentSince(runs: SpendRun[], provider: string | null, since: number): number {
  let sum = 0;
  for (const r of runs) if (Date.parse(r.at) >= since) sum += provider ? (r.byProvider[provider] ?? 0) : r.total;
  return sum;
}

/**
 * Остаток от введённого из консоли числа: введённое − расход по журналу после ввода.
 * «Мало» — меньше 15 % введённого; абсолютного порога нет: $0.84 при введённых $0.84 — это
 * полный остаток, а не тревога.
 */
export function manualRemaining(m: ManualBalance, runs: SpendRun[], provider: string): { remaining: number; since: number; level: BalanceLevel } {
  const since = spentSince(runs, provider, Date.parse(m.at));
  const remaining = m.balance - since;
  const level: BalanceLevel = remaining <= 0 ? "empty" : remaining < m.balance * 0.15 ? "low" : "ok";
  return { remaining, since, level };
}

export function runsWord(n: number): string {
  const tail = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && tail === 1) return "прогон";
  if (!teen && tail >= 2 && tail <= 4) return "прогона";
  return "прогонов";
}
