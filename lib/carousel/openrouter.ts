import { carouselApiKey, KEY_ENV } from "./config";
import { sniffImage, type ImageMime } from "./imageFile";

/**
 * Клиент OpenRouter раздела «Карусели» — отдельный от транспорта видео (lib/mediaLlm) и
 * обложек (lib/coverProvider): свой ключ CAROUSEL_OPENROUTER_API_KEY, свои таймауты, свой
 * учёт. Одним ключом раздел обращается к Claude (текст) и к генераторам изображений.
 *
 * Ошибки делятся на подтверждённые (OpenRouter ответил ошибкой — по его правилам неудачная
 * генерация не оплачивается) и с неизвестным исходом (тайм-аут или обрыв после отправки —
 * запрос мог выполниться и быть оплачен). Вторые никогда не повторяются автоматически.
 */

const BASE = "https://openrouter.ai/api/v1";

export type OpenRouterErrorKind =
  | "no_key"
  | "auth"
  | "credits"
  | "rate_limit"
  | "moderation"
  | "bad_request"
  | "provider"
  | "timeout"
  | "network"
  | "bad_response"
  | "truncated";

export class OpenRouterError extends Error {
  readonly status?: number;
  /** запрос мог выполниться и быть оплачен: ответ не получен */
  readonly uncertain: boolean;
  /** подтверждённая временная ошибка: допустим один повтор */
  readonly retryable: boolean;
  /** стоимость, которую OpenRouter всё же назвал (например, обрезанный ответ оплачен) */
  readonly cost?: number;

  constructor(
    message: string,
    readonly kind: OpenRouterErrorKind,
    opts: { status?: number; uncertain?: boolean; retryable?: boolean; cost?: number } = {},
  ) {
    super(message);
    this.name = "OpenRouterError";
    this.status = opts.status;
    this.uncertain = Boolean(opts.uncertain);
    this.retryable = Boolean(opts.retryable);
    this.cost = opts.cost;
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
let fetchOverride: FetchLike | null = null;

/** Только для тестов: подменить сеть. */
export function setOpenRouterFetch(f: FetchLike | null): void {
  fetchOverride = f;
}

const doFetch: FetchLike = (input, init) => (fetchOverride ?? fetch)(input, init);

function requireKey(): string {
  const key = carouselApiKey();
  if (!key) throw new OpenRouterError(`Не задан ключ OpenRouter для каруселей (${KEY_ENV}) — платный запрос не отправлялся`, "no_key");
  return key;
}

/** Вычищает ключи из текста, который может попасть в ошибку, лог или интерфейс. */
export function redactSecrets(s: string): string {
  const key = carouselApiKey();
  let t = key ? s.split(key).join("***") : s;
  return t.replace(/sk-or-[A-Za-z0-9_-]{6,}/g, "***").replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***");
}

const positiveCost = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function classify(status: number, err: any, text: string): OpenRouterError {
  const base = redactSecrets(String(err?.message ?? text ?? "").replace(/\s+/g, " ")).slice(0, 300) || `HTTP ${status}`;
  const raw = err?.metadata?.raw ? redactSecrets(String(typeof err.metadata.raw === "string" ? err.metadata.raw : JSON.stringify(err.metadata.raw))).slice(0, 200) : "";
  const detail = raw && !base.includes(raw) ? `${base} — ${raw}` : base;
  const cost = positiveCost(err?.metadata?.cost);
  if (status === 401 || status === 403) return new OpenRouterError(`OpenRouter отклонил ключ каруселей (${status}): ${detail}. Проверьте ${KEY_ENV}.`, "auth", { status });
  if (status === 402) return new OpenRouterError(`На ключе OpenRouter для каруселей не хватает кредитов или исчерпан его лимит: ${detail}`, "credits", { status });
  if (status === 429) return new OpenRouterError(`OpenRouter ограничил частоту запросов: ${detail}`, "rate_limit", { status, retryable: true });
  if (/moderat|safety|flagged|policy violation|content policy/i.test(detail)) {
    return new OpenRouterError(`Модель отказалась выполнять запрос по правилам безопасности: ${detail}`, "moderation", { status, cost });
  }
  if (status === 408 || status >= 500) return new OpenRouterError(`Провайдер модели вернул ошибку (${status}): ${detail}`, "provider", { status, retryable: true, cost });
  return new OpenRouterError(`OpenRouter не принял запрос (${status}): ${detail}`, "bad_request", { status, cost });
}

async function call(path: string, init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number; auth: boolean }): Promise<any> {
  const headers: Record<string, string> = { "X-Title": "Gudini Carousels" };
  if (init.auth) headers.Authorization = `Bearer ${requireKey()}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await doFetch(`${BASE}${path}`, {
      method: init.method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (e: any) {
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    const post = init.method === "POST";
    throw new OpenRouterError(
      timeout
        ? `Нет ответа OpenRouter за ${Math.round(init.timeoutMs / 1000)} с${post ? " — запрос мог выполниться и быть оплачен" : ""}`
        : `Сетевая ошибка при обращении к OpenRouter: ${redactSecrets(String(e?.message ?? e)).slice(0, 160)}${post ? " — исход запроса неизвестен" : ""}`,
      timeout ? "timeout" : "network",
      { uncertain: post },
    );
  }
  let text = "";
  try {
    text = await res.text();
  } catch {
    throw new OpenRouterError("Ответ OpenRouter оборвался на чтении — исход запроса неизвестен", "network", { status: res.status, uncertain: init.method === "POST" });
  }
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok || json?.error) throw classify(res.status, json?.error, text);
  if (json === null) throw new OpenRouterError(`OpenRouter вернул не JSON (HTTP ${res.status})`, "bad_response", { status: res.status, uncertain: init.method === "POST" });
  return json;
}

export type TextResult = { text: string; cost: number | null; promptTokens: number; completionTokens: number };

export async function chatText(args: { model: string; system: string; user: string; maxTokens: number; timeoutMs: number }): Promise<TextResult> {
  const json = await call("/chat/completions", {
    method: "POST",
    auth: true,
    timeoutMs: args.timeoutMs,
    body: {
      model: args.model,
      max_tokens: args.maxTokens,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      usage: { include: true },
    },
  });
  const choice = json?.choices?.[0] ?? {};
  const content = choice?.message?.content;
  const text = (
    typeof content === "string" ? content : Array.isArray(content) ? content.filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "")).join("\n") : ""
  ).trim();
  const cost = positiveCost(json?.usage?.cost) ?? null;
  const finish = String(choice?.finish_reason ?? "");
  if (finish === "length") {
    throw new OpenRouterError(`Ответ модели обрезан по лимиту ${args.maxTokens} токенов`, "truncated", { cost: cost ?? undefined });
  }
  if (!text) throw new OpenRouterError(`Модель вернула пустой ответ (finish_reason=${finish || "нет"})`, "bad_response", { cost: cost ?? undefined });
  return {
    text,
    cost,
    promptTokens: Number(json?.usage?.prompt_tokens ?? 0) || 0,
    completionTokens: Number(json?.usage?.completion_tokens ?? 0) || 0,
  };
}

export type ImageRequest = {
  model: string;
  prompt: string;
  aspectRatio: string;
  resolution: string | null;
  quality?: string;
  /** картинки-референсы data:URL в порядке важности */
  references: string[];
  timeoutMs: number;
};

export type ImageResult = { buffer: Buffer; mediaType: ImageMime; cost: number | null };

/** Одна картинка через POST /api/v1/images. Параметры, которых модель не принимает, не отправляются. */
export async function generateImage(req: ImageRequest): Promise<ImageResult> {
  const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, aspect_ratio: req.aspectRatio, n: 1 };
  if (req.resolution) body.resolution = req.resolution;
  if (req.quality) body.quality = req.quality;
  if (req.references.length) body.input_references = req.references.map((url) => ({ type: "image_url", image_url: { url } }));
  const json = await call("/images", { method: "POST", auth: true, timeoutMs: req.timeoutMs, body });
  const cost = positiveCost(json?.usage?.cost) ?? null;
  const b64 = json?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) {
    throw new OpenRouterError("OpenRouter ответил без изображения", "bad_response", { cost: cost ?? undefined });
  }
  const buffer = Buffer.from(b64, "base64");
  const mediaType = sniffImage(buffer);
  if (!mediaType) throw new OpenRouterError("Генератор вернул файл, который не похож на PNG, JPEG или WebP", "bad_response", { cost: cost ?? undefined });
  return { buffer, mediaType, cost };
}

export type KeyInfo = { label: string | null; limit: number | null; usage: number; remaining: number | null };

/** Лимит и расход самого ключа раздела — чтение, без генераций. */
export async function keyInfo(timeoutMs = 15_000): Promise<KeyInfo> {
  const json = await call("/key", { method: "GET", auth: true, timeoutMs });
  const d = json?.data ?? {};
  const limit = d.limit === null || d.limit === undefined ? null : Number(d.limit);
  const usage = Number(d.usage ?? 0) || 0;
  const remaining = d.limit_remaining === null || d.limit_remaining === undefined ? (limit === null ? null : Math.max(0, limit - usage)) : Number(d.limit_remaining);
  return { label: typeof d.label === "string" ? redactSecrets(d.label).slice(0, 60) : null, limit, usage, remaining };
}

type CatalogEntry = { id: string; params: Record<string, any> };
const catalogCache = new Map<string, { at: number; value: Map<string, CatalogEntry> }>();
const CATALOG_TTL_MS = 6 * 3600_000;

/** Публичные каталоги моделей OpenRouter (без ключа): есть ли модель сейчас и что она принимает. */
export async function modelCatalog(kind: "images" | "text", timeoutMs = 20_000): Promise<Map<string, CatalogEntry>> {
  const cached = catalogCache.get(kind);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value;
  const json = await call(kind === "images" ? "/images/models" : "/models", { method: "GET", auth: false, timeoutMs });
  const value = new Map<string, CatalogEntry>();
  for (const m of Array.isArray(json?.data) ? json.data : []) {
    if (typeof m?.id === "string") value.set(m.id, { id: m.id, params: m.supported_parameters ?? {} });
  }
  catalogCache.set(kind, { at: Date.now(), value });
  return value;
}

export function clearCatalogCache(): void {
  catalogCache.clear();
}
