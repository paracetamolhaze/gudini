import { getSettings } from "./store";

/**
 * Балансы внешних API для дашборда.
 *
 * Показывается только то, что провайдер действительно отдаёт по ключу:
 * OpenRouter — остаток лимита ключа и расход за месяц; ElevenLabs — кредиты тарифа
 * и дата сброса; Brave — лимиты из заголовков ответа (одним дешёвым запросом);
 * Anthropic остаток по API не отдаёт вовсе — проверяется, что ключ принят, а при
 * заданном ANTHROPIC_ADMIN_KEY (ключ со страницы Admin keys, sk-ant-admin01-…)
 * считается расход за сегодня и с начала месяца. Значения ключей наружу не выходят —
 * только числа и статусы.
 */

export type BalanceLevel = "ok" | "low" | "empty" | "unknown" | "missing" | "error";

export type ProviderBalance = {
  id: "anthropic" | "openrouter" | "elevenlabs" | "brave";
  name: string;
  /** за что отвечает в Gudini */
  role: string;
  level: BalanceLevel;
  /** главная величина: остаток, расход или причина, почему их нет */
  value: string;
  /** пояснение: тариф, дата сброса, что включить */
  note: string;
  consoleUrl: string;
};

const TIMEOUT_MS = 8000;

const money = (v: number) => `$${v.toFixed(v >= 100 ? 0 : 2)}`;
const int = (v: number) => Math.round(v).toLocaleString("ru-RU");
const errText = (e: any) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 80);
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

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

// ---------------------------------------------------------------- Anthropic: весь текст, рассуждение и зрение
async function anthropic(): Promise<ProviderBalance> {
  const base = { id: "anthropic" as const, name: "Anthropic", role: "сценарий, исследование, монтаж, чистка речи", consoleUrl: "https://platform.claude.com/settings/billing" };
  const key = getSettings().anthropicKey;
  if (!key) return { ...base, level: "missing", value: "ключ не задан", note: "конвейер не запустится" };
  const admin = process.env.ANTHROPIC_ADMIN_KEY || "";
  let adminNote = "расход покажет ANTHROPIC_ADMIN_KEY (Settings → Admin keys)";
  try {
    if (admin) {
      // расход через Admin API; остаток кредитов API не отдаёт ни одним ключом
      const start = new Date();
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      const url = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(start.toISOString())}&bucket_width=1d&limit=31`;
      const { status, json } = await getJson(url, { "x-api-key": admin, "anthropic-version": "2023-06-01" });
      if (status === 200) {
        const today = new Date().toISOString().slice(0, 10);
        let month = 0;
        let day = 0;
        for (const bucket of json.data ?? []) {
          let sum = 0;
          for (const r of bucket.results ?? []) sum += Number(r.amount ?? 0); // центы
          month += sum;
          if (String(bucket.starting_at ?? "").startsWith(today)) day += sum;
        }
        return {
          ...base,
          level: "unknown",
          value: `${money(month / 100)} с 1 ${MONTHS[start.getUTCMonth()]}`,
          note: `сегодня ${money(day / 100)} · остаток кредитов только в консоли`,
        };
      }
      const msg = String(json?.error?.message ?? "");
      adminNote = /Admin API key|organization-scoped/i.test(msg)
        ? "ANTHROPIC_ADMIN_KEY привязан к workspace — нужен Personal-ключ без workspace (Scope не «gudini»)"
        : status === 403
          ? "у ANTHROPIC_ADMIN_KEY выключены права: включите «Workspace Analytics: Access» в правах ключа"
          : `ANTHROPIC_ADMIN_KEY не принят (${status}${msg ? `: ${errText(msg)}` : ""})`;
    }
    const { status, json } = await getJson("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01" });
    if (status === 401) return { ...base, level: "error", value: "ключ не принят", note: "ответ 401" };
    if (status !== 200) return { ...base, level: "error", value: `ошибка ${status}`, note: errText(json?.error?.message ?? "") };
    return { ...base, level: "unknown", value: "остаток только в консоли", note: adminNote };
  } catch (e) {
    return { ...base, level: "error", value: "нет ответа", note: errText(e) };
  }
}

// ---------------------------------------------------------------- OpenRouter: генерация картинки обложки
async function openrouter(): Promise<ProviderBalance> {
  const base = { id: "openrouter" as const, name: "OpenRouter", role: "картинка обложки (Gemini)", consoleUrl: "https://openrouter.ai/settings/credits" };
  const key = getSettings().openrouterKey;
  if (!key) return { ...base, level: "missing", value: "ключ не задан", note: "обложки генерироваться не будут" };
  try {
    const { status, json } = await getJson("https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${key}` });
    if (status === 401 || status === 403) return { ...base, level: "error", value: "ключ не принят", note: `ответ ${status}` };
    if (status !== 200) return { ...base, level: "error", value: `ошибка ${status}`, note: errText(json?.error?.message ?? "") };
    const d = json.data ?? {};
    const usage = Number(d.usage ?? 0);
    const monthly = Number(d.usage_monthly ?? 0);
    if (d.limit === null || d.limit === undefined) {
      return { ...base, level: "unknown", value: `потрачено ${money(usage)}`, note: `лимит на ключ не задан · за месяц ${money(monthly)} · остаток в консоли` };
    }
    const limit = Number(d.limit);
    const remaining = Number(d.limit_remaining ?? Math.max(0, limit - usage));
    return {
      ...base,
      level: levelByShare(remaining, limit),
      value: `${money(remaining)} из ${money(limit)}`,
      note: `лимит ключа · за месяц ${money(monthly)}`,
    };
  } catch (e) {
    return { ...base, level: "error", value: "нет ответа", note: errText(e) };
  }
}

// ---------------------------------------------------------------- ElevenLabs: расшифровка речи (Scribe)
const TIERS: Record<string, string> = { payg: "оплата по факту", free: "бесплатный", starter: "Starter", creator: "Creator", pro: "Pro", scale: "Scale", business: "Business" };

async function elevenlabs(): Promise<ProviderBalance> {
  const base = { id: "elevenlabs" as const, name: "ElevenLabs", role: "расшифровка речи (Scribe)", consoleUrl: "https://elevenlabs.io/app/subscription" };
  const key = getSettings().elevenLabsKey;
  if (!key) return { ...base, level: "missing", value: "ключ не задан", note: "расшифровка речи не работает" };
  try {
    const { status, json } = await getJson("https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": key });
    if (status === 401 && json?.detail?.status === "missing_permissions") {
      // ключ годится для расшифровки, но без права user_read остаток не отдаёт
      return { ...base, level: "unknown", value: "остаток недоступен", note: "у ключа нет права User: Read — включите в настройках ключа на elevenlabs.io" };
    }
    if (status === 401) return { ...base, level: "error", value: "ключ не принят", note: errText(json?.detail?.message ?? "ответ 401") };
    if (status !== 200) return { ...base, level: "error", value: `ошибка ${status}`, note: errText(json?.detail?.message ?? json?.detail ?? "") };
    const used = Number(json.character_count ?? 0);
    const limit = Number(json.character_limit ?? 0);
    const remaining = Math.max(0, limit - used);
    const reset = json.next_character_count_reset_unix ? new Date(Number(json.next_character_count_reset_unix) * 1000) : null;
    const tierKey = String(json.tier ?? "").toLowerCase();
    const tier = TIERS[tierKey] ?? tierKey.replace(/_/g, " ");
    return {
      ...base,
      level: levelByShare(remaining, limit),
      value: `${int(remaining)} из ${int(limit)} кредитов`,
      note: `${tier || "тариф не указан"}${reset ? ` · сброс ${reset.getDate()} ${MONTHS[reset.getMonth()]}` : ""}`,
    };
  } catch (e) {
    return { ...base, level: "error", value: "нет ответа", note: errText(e) };
  }
}

// ---------------------------------------------------------------- Brave: поиск источников
async function brave(): Promise<ProviderBalance> {
  const base = { id: "brave" as const, name: "Brave Search", role: "поиск источников", consoleUrl: "https://api-dashboard.search.brave.com/app/dashboard" };
  const key = process.env.BRAVE_API_KEY || process.env.BRAVE || "";
  if (!key) return { ...base, level: "missing", value: "ключ не задан", note: "поиск источников не работает" };
  try {
    // API баланс не отдаёт; лимиты приходят в заголовках любого ответа — один запрос
    // на минимальную выдачу, результат кэшируется в маршруте
    const res = await fetch("https://api.search.brave.com/res/v1/web/search?q=gudini&count=1", {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 401 || res.status === 403) return { ...base, level: "error", value: "ключ не принят", note: `ответ ${res.status}` };
    if (res.status === 429) return { ...base, level: "empty", value: "лимит исчерпан", note: "ответ 429" };
    if (res.status !== 200) return { ...base, level: "error", value: `ошибка ${res.status}`, note: "" };
    // формат: "50, 0" — в секунду и в месяц; 0 в месяц = лимита нет (оплата за запросы)
    const limits = (res.headers.get("x-ratelimit-limit") ?? "").split(",").map((x) => Number(x.trim()));
    const remaining = (res.headers.get("x-ratelimit-remaining") ?? "").split(",").map((x) => Number(x.trim()));
    const monthLimit = limits[1] ?? 0;
    const monthLeft = remaining[1] ?? 0;
    if (!monthLimit) {
      return { ...base, level: "ok", value: "без месячного лимита", note: `оплата за запросы · до ${limits[0] || "?"} в секунду · расход в консоли` };
    }
    return { ...base, level: levelByShare(monthLeft, monthLimit), value: `${int(monthLeft)} из ${int(monthLimit)} запросов`, note: "в этом месяце" };
  } catch (e) {
    return { ...base, level: "error", value: "нет ответа", note: errText(e) };
  }
}

/** Все провайдеры параллельно; порядок — по доле в цене ролика. */
export async function collectBalances(): Promise<ProviderBalance[]> {
  return Promise.all([anthropic(), openrouter(), elevenlabs(), brave()]);
}
