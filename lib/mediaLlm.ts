import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";
import { recordTokens, CostStage } from "./costLedger";

/**
 * Транспорт для текстовых LLM-вызовов медиа-конвейера.
 *
 * Промпты и схемы ответов остаются прежними — меняется только то, через кого
 * идёт запрос. Нужно, чтобы медиа-конвейер не зависел от одного биллинга:
 * когда на прямом счёте Anthropic кончились деньги, вся сборка медиатеки встала,
 * хотя OpenRouter в проекте уже подключён и оплачен.
 *
 * MEDIA_LLM_PROVIDER = anthropic | openrouter
 * MEDIA_LLM_MODEL    = модель провайдера (у каждого своё имя)
 */

export type MediaLlmProvider = "anthropic" | "openrouter";

const DEFAULT_MODELS: Record<MediaLlmProvider, string> = {
  anthropic: "claude-sonnet-5",
  openrouter: "anthropic/claude-sonnet-4.5",
};

export function mediaProvider(): MediaLlmProvider {
  const raw = String(process.env.MEDIA_LLM_PROVIDER ?? "").toLowerCase();
  if (raw === "openrouter") return "openrouter";
  if (raw === "anthropic") return "anthropic";
  // по умолчанию идём туда, где есть ключ: сперва прямой Anthropic, иначе OpenRouter
  return getSettings().anthropicKey ? "anthropic" : "openrouter";
}

export function mediaModel(): string {
  return process.env.MEDIA_LLM_MODEL || DEFAULT_MODELS[mediaProvider()];
}

export function mediaLlmAvailable(): boolean {
  const s = getSettings();
  return mediaProvider() === "openrouter" ? Boolean(s.openrouterKey) : Boolean(s.anthropicKey);
}


/** Списание фактической стоимости, которую назвал OpenRouter. */
function recordOpenRouter(stage: CostStage, model: string, json: any, failed = false, retry = false): void {
  const u = json?.usage ?? {};
  recordTokens({
    stage,
    provider: "openrouter",
    model,
    inputTokens: Number(u.prompt_tokens ?? 0),
    outputTokens: Number(u.completion_tokens ?? 0),
    cacheReadTokens: Number(u.prompt_tokens_details?.cached_tokens ?? 0),
    providerReportedCost: typeof u.cost === "number" ? u.cost : undefined,
    failed,
    retry,
  });
}

/** Списание по фактическому расходу токенов Anthropic. */
function recordAnthropic(stage: CostStage, model: string, response: any, failed = false, retry = false): void {
  const u = response?.usage ?? {};
  recordTokens({
    stage,
    provider: "anthropic",
    model,
    inputTokens: Number(u.input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0),
    cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
    failed,
    retry,
  });
}

export type CompleteArgs = {
  system: string;
  user: string;
  maxTokens?: number;
  /** для отчёта по стоимости: на какую стадию списывать этот вызов */
  stage?: CostStage;
};

/**
 * Один повтор при разовом сбое провайдера.
 *
 * Пустой ответ или 429/5xx — это икота сети, а не сломанная стадия: ронять из-за
 * неё всю сборку так же неправильно, как молча её проглатывать. Повтор ровно один,
 * и он попадает в отчёт о стоимости, иначе цена ролика окажется занижена.
 */
async function withOneRetry<T>(fn: (isRetry: boolean) => Promise<T>): Promise<T> {
  try {
    return await fn(false);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!/пустой ответ|429|5\d\d:|timeout|ECONNRESET|fetch failed/i.test(msg)) throw e;
    return await fn(true);
  }
}

/** Один текстовый запрос. Возвращает текст ответа или бросает ошибку — молча не глотаем. */
export async function mediaComplete(args: CompleteArgs): Promise<string> {
  return withOneRetry((isRetry) => completeOnce(args, isRetry));
}

async function completeOnce(
  { system, user, maxTokens = 8000, stage = "Media Research" }: CompleteArgs,
  isRetry = false,
): Promise<string> {
  const provider = mediaProvider();
  const model = mediaModel();
  const settings = getSettings();

  if (provider === "openrouter") {
    const key = settings.openrouterKey;
    if (!key) throw new Error("MEDIA_LLM_PROVIDER=openrouter, но ключ OPENROUTER не задан");
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // просим вернуть фактическую стоимость: свою цифру придумывать не будем
        usage: { include: true },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      // неудачный запрос провайдер мог оттарифицировать — он тоже идёт в стоимость
      recordOpenRouter(stage, model, json, true, isRetry);
      throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(json.error ?? {}).slice(0, 200)}`);
    }
    recordOpenRouter(stage, model, json, false, isRetry);
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("OpenRouter вернул пустой ответ");
    return text.trim();
  }

  const key = settings.anthropicKey;
  if (!key) throw new Error("MEDIA_LLM_PROVIDER=anthropic, но ключ ANTHROPIC_API_KEY не задан");
  const client = new Anthropic({ apiKey: key });
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  recordAnthropic(stage, model, response, false, isRetry);
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Anthropic вернул пустой ответ");
  return text;
}

export type VisionImage = { base64: string; mediaType: string } | { url: string };

export type VisionArgs = {
  system: string;
  user: string;
  /** один кадр или сразу пачка кадров одного исходника — пачка дешевле */
  image?: VisionImage;
  images?: VisionImage[];
  maxTokens?: number;
  stage?: CostStage;
};

/**
 * Запрос со зрением через тот же провайдер.
 * Описание кадров — обязательная часть сборки медиатеки: без него ни один
 * видео-сегмент не проходит дальше, поэтому оно не должно зависеть от отдельного счёта.
 */
export async function mediaVision(args: VisionArgs): Promise<string> {
  return withOneRetry((isRetry) => visionOnce(args, isRetry));
}

async function visionOnce(
  { system, user, image, images, maxTokens = 2000, stage = "Vision Verification" }: VisionArgs,
  isRetry = false,
): Promise<string> {
  const frames = images ?? (image ? [image] : []);
  if (!frames.length) throw new Error("зрению не передан ни один кадр");
  const provider = mediaProvider();
  const model = process.env.MEDIA_VISION_MODEL || mediaModel();
  const settings = getSettings();

  if (provider === "openrouter") {
    const key = settings.openrouterKey;
    if (!key) throw new Error("MEDIA_LLM_PROVIDER=openrouter, но ключ OPENROUTER не задан");
    const parts = frames.map((f) => ({
      type: "image_url" as const,
      image_url: { url: "url" in f ? f.url : `data:${f.mediaType};base64,${f.base64}` },
    }));
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        usage: { include: true },
        messages: [
          { role: "system", content: system },
          { role: "user", content: [...parts, { type: "text", text: user }] },
        ],
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      recordOpenRouter(stage, model, json, true, isRetry);
      throw new Error(`OpenRouter vision ${res.status}: ${JSON.stringify(json.error ?? {}).slice(0, 200)}`);
    }
    recordOpenRouter(stage, model, json, false, isRetry);
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("OpenRouter vision вернул пустой ответ");
    return text.trim();
  }

  const key = settings.anthropicKey;
  if (!key) throw new Error("MEDIA_LLM_PROVIDER=anthropic, но ключ ANTHROPIC_API_KEY не задан");
  const client = new Anthropic({ apiKey: key });
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [
      {
        role: "user",
        content: [
          ...frames.map((f) =>
            "url" in f
              ? { type: "image" as const, source: { type: "url" as const, url: f.url } }
              : {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: f.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                    data: f.base64,
                  },
                },
          ),
          { type: "text" as const, text: user },
        ],
      },
    ],
  });
  recordAnthropic(stage, model, response, false, isRetry);
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Anthropic vision вернул пустой ответ");
  return text;
}

/** Снимает markdown-ограждение и парсит JSON. Ошибка разбора — это ошибка стадии. */
export function parseJson<T>(raw: string, stage: string): T {
  const cleaned = raw
    .replace(/^```(json)?/m, "")
    .replace(/```$/m, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {}
    }
    throw new Error(`${stage}: ответ модели не разобрался как JSON`);
  }
}
