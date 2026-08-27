import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";

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

export type CompleteArgs = {
  system: string;
  user: string;
  maxTokens?: number;
};

/** Один текстовый запрос. Возвращает текст ответа или бросает ошибку — молча не глотаем. */
export async function mediaComplete({ system, user, maxTokens = 8000 }: CompleteArgs): Promise<string> {
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
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(json.error ?? {}).slice(0, 200)}`);
    }
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
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Anthropic вернул пустой ответ");
  return text;
}

export type VisionArgs = {
  system: string;
  user: string;
  image: { base64: string; mediaType: string } | { url: string };
  maxTokens?: number;
};

/**
 * Запрос со зрением через тот же провайдер.
 * Описание кадров — обязательная часть сборки медиатеки: без него ни один
 * видео-сегмент не проходит дальше, поэтому оно не должно зависеть от отдельного счёта.
 */
export async function mediaVision({ system, user, image, maxTokens = 2000 }: VisionArgs): Promise<string> {
  const provider = mediaProvider();
  const model = process.env.MEDIA_VISION_MODEL || mediaModel();
  const settings = getSettings();

  if (provider === "openrouter") {
    const key = settings.openrouterKey;
    if (!key) throw new Error("MEDIA_LLM_PROVIDER=openrouter, но ключ OPENROUTER не задан");
    const url = "url" in image ? image.url : `data:${image.mediaType};base64,${image.base64}`;
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url } },
              { type: "text", text: user },
            ],
          },
        ],
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      throw new Error(`OpenRouter vision ${res.status}: ${JSON.stringify(json.error ?? {}).slice(0, 200)}`);
    }
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
          "url" in image
            ? { type: "image" as const, source: { type: "url" as const, url: image.url } }
            : {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: image.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                  data: image.base64,
                },
              },
          { type: "text" as const, text: user },
        ],
      },
    ],
  });
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
