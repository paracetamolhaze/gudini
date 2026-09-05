import { getSettings } from "./store";

/**
 * Балансы внешних API для дашборда.
 *
 * Показывается только то, что провайдер действительно отдаёт по обычному ключу:
 * OpenRouter — остаток лимита ключа и расход; ElevenLabs — кредиты тарифа и дата
 * сброса; Brave — лимиты из заголовков ответа (одним дешёвым запросом); Anthropic
 * и OpenAI баланс по API не отдают — для них проверяется, что ключ принят, а при
 * заданном ANTHROPIC_ADMIN_KEY считается расход с начала месяца. Значения ключей
 * наружу не выходят никогда — только числа и статусы.
 */

export type BalanceLevel = "ok" | "low" | "empty" | "unknown" | "missing" | "error";

export type ProviderBalance = {
  id: "anthropic" | "openrouter" | "elevenlabs" | "brave" | "openai";
  name: string;
  /** за что отвечает в Gudini */
  role: string;
  level: BalanceLevel;
  /** главная строка: остаток или причина, почему его нет */
  headline: string;
  /** вторая строка: расход, тариф, дата сброса */
  detail: string;
  consoleUrl: string;
};

const TIMEOUT_MS = 8000;

const money = (v: number) => `$${v.toFixed(v >= 100 ? 0 : 2)}`;
const int = (v: number) => Math.round(v).toLocaleString("ru-RU");
const errText = (e: any) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 80);

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}

function levelByShare(remaining: number, total: number): BalanceLevel {
  if (remaining <= 0) return "empty";
  if (total > 0 && remaining / total < 0.15) return "low";
  return "ok";
}

// ---------------------------------------------------------------- OpenRouter: генерация картинки обложки
async function openrouter(): Promise<ProviderBalance> {
  const base = { id: "openrouter" as const, name: "OpenRouter", role: "картинка обложки (Gemini)", consoleUrl: "https://openrouter.ai/settings/credits" };
  const key = getSettings().openrouterKey;
  if (!key) return { ...base, level: "missing", headline: "ключ не задан", detail: "обложки генерироваться не будут" };
  try {
    const { status, json } = await getJson("https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${key}` });
    if (status === 401 || status === 403) return { ...base, level: "error", headline: "ключ не принят", detail: `ответ ${status}` };
    if (status !== 200) return { ...base, level: "error", headline: `ошибка ${status}`, detail: errText(json?.error?.message ?? "") };
    const d = json.data ?? {};
    const usage = Number(d.usage ?? 0);
    const monthly = Number(d.usage_monthly ?? 0);
    if (d.limit === null || d.limit === undefined) {
      return {
        ...base,
        level: "unknown",
        headline: "лимит на ключ не задан",
        detail: `потрачено всего ${money(usage)}, за месяц ${money(monthly)} · остаток кредитов виден только в консоли`,
      };
    }
    const limit = Number(d.limit);
    const remaining = Number(d.limit_remaining ?? Math.max(0, limit - usage));
    return {
      ...base,
      level: levelByShare(remaining, limit),
      headline: `осталось ${money(remaining)} из ${money(limit)}`,
      detail: `потрачено за месяц ${money(monthly)}, всего ${money(usage)}`,
    };
  } catch (e) {
    return { ...base, level: "error", headline: "нет ответа", detail: errText(e) };
  }
}

// ---------------------------------------------------------------- ElevenLabs: расшифровка речи (Scribe)
async function elevenlabs(): Promise<ProviderBalance> {
  const base = { id: "elevenlabs" as const, name: "ElevenLabs", role: "расшифровка речи (Scribe)", consoleUrl: "https://elevenlabs.io/app/subscription" };
  const key = getSettings().elevenLabsKey;
  if (!key) return { ...base, level: "missing", headline: "ключ не задан", detail: "расшифровка пойдёт через Whisper, если задан OpenAI" };
  try {
    const { status, json } = await getJson("https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": key });
    if (status === 401 && json?.detail?.status === "missing_permissions") {
      // ключ годится для расшифровки, но без права user_read остаток не отдаёт
      return {
        ...base,
        level: "unknown",
        headline: "у ключа нет права User: Read",
        detail: "включите его в настройках ключа на elevenlabs.io → API keys — остаток появится",
      };
    }
    if (status === 401) return { ...base, level: "error", headline: "ключ не принят", detail: errText(json?.detail?.message ?? "ответ 401") };
    if (status !== 200) return { ...base, level: "error", headline: `ошибка ${status}`, detail: errText(json?.detail?.message ?? json?.detail ?? "") };
    const used = Number(json.character_count ?? 0);
    const limit = Number(json.character_limit ?? 0);
    const remaining = Math.max(0, limit - used);
    const reset = json.next_character_count_reset_unix ? new Date(Number(json.next_character_count_reset_unix) * 1000) : null;
    const tier = String(json.tier ?? "").replace(/_/g, " ");
    return {
      ...base,
      level: levelByShare(remaining, limit),
      headline: `осталось ${int(remaining)} из ${int(limit)} кредитов`,
      detail: `тариф ${tier || "—"}${reset ? `, сброс ${reset.toLocaleDateString("ru-RU")}` : ""}`,
    };
  } catch (e) {
    return { ...base, level: "error", headline: "нет ответа", detail: errText(e) };
  }
}

// ---------------------------------------------------------------- Brave: поиск источников
async function brave(): Promise<ProviderBalance> {
  const base = { id: "brave" as const, name: "Brave Search", role: "поиск источников", consoleUrl: "https://api-dashboard.search.brave.com/app/dashboard" };
  const key = process.env.BRAVE_API_KEY || process.env.BRAVE || "";
  if (!key) return { ...base, level: "missing", headline: "ключ не задан", detail: "поиск источников не работает" };
  try {
    // API баланс не отдаёт; лимиты приходят в заголовках любого ответа — один запрос
    // на минимальную выдачу, результат кэшируется в маршруте
    const res = await fetch("https://api.search.brave.com/res/v1/web/search?q=gudini&count=1", {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 401 || res.status === 403) return { ...base, level: "error", headline: "ключ не принят", detail: `ответ ${res.status}` };
    if (res.status === 429) return { ...base, level: "empty", headline: "лимит запросов исчерпан", detail: "ответ 429" };
    if (res.status !== 200) return { ...base, level: "error", headline: `ошибка ${res.status}`, detail: "" };
    // формат: "50, 0" — в секунду и в месяц; 0 в месяц = лимита нет (оплата за запросы)
    const limits = (res.headers.get("x-ratelimit-limit") ?? "").split(",").map((x) => Number(x.trim()));
    const remaining = (res.headers.get("x-ratelimit-remaining") ?? "").split(",").map((x) => Number(x.trim()));
    const monthLimit = limits[1] ?? 0;
    const monthLeft = remaining[1] ?? 0;
    if (!monthLimit) {
      return {
        ...base,
        level: "unknown",
        headline: "без месячного лимита",
        detail: `оплата за запросы, до ${limits[0] || "?"} в секунду · расход виден в консоли`,
      };
    }
    return {
      ...base,
      level: levelByShare(monthLeft, monthLimit),
      headline: `осталось ${int(monthLeft)} из ${int(monthLimit)} запросов`,
      detail: "в этом месяце",
    };
  } catch (e) {
    return { ...base, level: "error", headline: "нет ответа", detail: errText(e) };
  }
}

// ---------------------------------------------------------------- Anthropic: весь текст, рассуждение и зрение
async function anthropic(): Promise<ProviderBalance> {
  const base = { id: "anthropic" as const, name: "Anthropic", role: "сценарий, исследование, монтаж, чистка речи", consoleUrl: "https://console.anthropic.com/settings/billing" };
  const key = getSettings().anthropicKey;
  if (!key) return { ...base, level: "missing", headline: "ключ не задан", detail: "конвейер не запустится" };
  const admin = process.env.ANTHROPIC_ADMIN_KEY || "";
  try {
    if (admin) {
      // расход с начала месяца через Admin API; баланс кредитов API не отдаёт
      const start = new Date();
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      const url = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(start.toISOString())}&bucket_width=1d&limit=31`;
      const { status, json } = await getJson(url, { "x-api-key": admin, "anthropic-version": "2023-06-01" });
      if (status === 200) {
        let cents = 0;
        for (const bucket of json.data ?? []) for (const r of bucket.results ?? []) cents += Number(r.amount ?? 0);
        return {
          ...base,
          level: "unknown",
          headline: `потрачено с 1-го числа ${money(cents / 100)}`,
          detail: "остаток кредитов API не отдаёт — смотреть в консоли",
        };
      }
      // админ-ключ не сработал — ниже обычная проверка ключа
    }
    const { status, json } = await getJson("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01" });
    if (status === 401) return { ...base, level: "error", headline: "ключ не принят", detail: "ответ 401" };
    if (status !== 200) return { ...base, level: "error", headline: `ошибка ${status}`, detail: errText(json?.error?.message ?? "") };
    return {
      ...base,
      level: "unknown",
      headline: "ключ работает, баланс API не отдаёт",
      detail: admin ? "ANTHROPIC_ADMIN_KEY не принят" : "расход за месяц покажет ANTHROPIC_ADMIN_KEY; остаток — в консоли",
    };
  } catch (e) {
    return { ...base, level: "error", headline: "нет ответа", detail: errText(e) };
  }
}

// ---------------------------------------------------------------- OpenAI: запасная расшифровка (Whisper)
async function openai(): Promise<ProviderBalance> {
  const base = { id: "openai" as const, name: "OpenAI", role: "запасная расшифровка (Whisper)", consoleUrl: "https://platform.openai.com/settings/organization/billing/overview" };
  const key = getSettings().openaiKey;
  if (!key) return { ...base, level: "missing", headline: "ключ не задан", detail: "необязателен: запасной вариант для ElevenLabs" };
  try {
    const { status, json } = await getJson("https://api.openai.com/v1/models?limit=1", { Authorization: `Bearer ${key}` });
    if (status === 401) return { ...base, level: "error", headline: "ключ не принят", detail: "ответ 401" };
    if (status !== 200) return { ...base, level: "error", headline: `ошибка ${status}`, detail: errText(json?.error?.message ?? "") };
    return { ...base, level: "unknown", headline: "ключ работает, баланс API не отдаёт", detail: "остаток — в консоли" };
  } catch (e) {
    return { ...base, level: "error", headline: "нет ответа", detail: errText(e) };
  }
}

/** Все провайдеры параллельно; порядок — по месту в конвейере. */
export async function collectBalances(): Promise<ProviderBalance[]> {
  return Promise.all([anthropic(), openrouter(), elevenlabs(), brave(), openai()]);
}
