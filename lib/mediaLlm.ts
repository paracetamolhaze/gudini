import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";
import { recordTokens, assertBudget, projectRequestCost, CostStage, CostProvider } from "./costLedger";
import { assertProvider, ProviderPolicyError } from "./providerPolicy";

/**
 * Транспорт для текстовых и зрительных вызовов основного видео-конвейера.
 *
 * Провайдер здесь ровно один — Anthropic. OpenRouter сюда не подключается даже
 * при недоступности Anthropic: подмена провайдера молча меняет качество разбора
 * истории и цену ролика, а понять постфактум, чем собран конкретный ролик,
 * становится невозможно. Кончился доступ — задача останавливается с внятной
 * ошибкой, и решение о смене провайдера принимает человек.
 *
 * OpenRouter в проекте остаётся, но только внутри конвейера обложек.
 *
 * MEDIA_LLM_MODEL — модель Anthropic для стадий конвейера.
 * MEDIA_VISION_MODEL — отдельная модель для разбора кадров, если нужна другая.
 */

/** У медиа-конвейера провайдер один и не выбирается. */
export const MEDIA_PROVIDER = "anthropic" as const;

const DEFAULT_MODEL = "claude-sonnet-5";

export function mediaProvider(): typeof MEDIA_PROVIDER {
  const requested = String(process.env.MEDIA_LLM_PROVIDER ?? "").toLowerCase();
  if (requested && requested !== "anthropic") {
    // Явная попытка увести конвейер на чужого провайдера — это ошибка настройки,
    // а не повод тихо согласиться.
    throw new ProviderPolicyError("Media Research", requested as CostProvider, ["anthropic"]);
  }
  return MEDIA_PROVIDER;
}

export function mediaModel(): string {
  return process.env.MEDIA_LLM_MODEL || DEFAULT_MODEL;
}

export function mediaLlmAvailable(): boolean {
  return Boolean(getSettings().anthropicKey);
}

/** Ключ Anthropic или внятный отказ. Никакого перехода на другого провайдера. */
function anthropicKeyOrFail(stage: CostStage): string {
  const key = getSettings().anthropicKey;
  if (!key) {
    throw new Error(
      `Стадия «${stage}» не выполнена: нет ключа Anthropic. ` +
        "Медиа-конвейер работает только через Anthropic, автоматический переход на другого провайдера запрещён.",
    );
  }
  return key;
}

/** Списание по фактическому расходу токенов Anthropic. */
function recordAnthropic(stage: CostStage, model: string, response: any, failed = false, retry = false): void {
  assertProvider(stage, "anthropic");
  assertBudget(stage);
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
  /** модель стадии: сценарий пишет Opus, утилитарные задачи — Sonnet */
  model?: string;
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
  { system, user, maxTokens = 8000, stage = "Media Research", model: modelOverride }: CompleteArgs,
  isRetry = false,
): Promise<string> {
  const model = modelOverride || mediaModel();
  mediaProvider(); // чужой провайдер в настройке — ошибка конфигурации
  // Политика проверяется ДО обращения к API: запрещённая пара не должна
  // успеть потратить деньги, а потом быть замеченной при учёте.
  assertProvider(stage, "anthropic");
  assertBudget(stage);

  const client = new Anthropic({ apiKey: anthropicKeyOrFail(stage) });
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
  /** модель стадии: QC обложки дешевле делать на младшей модели */
  model?: string;
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
  { system, user, image, images, maxTokens = 2000, stage = "Vision Verification", model: modelOverride }: VisionArgs,
  isRetry = false,
): Promise<string> {
  const frames = images ?? (image ? [image] : []);
  if (!frames.length) throw new Error("зрению не передан ни один кадр");
  const model = modelOverride || process.env.MEDIA_VISION_MODEL || mediaModel();
  mediaProvider();
  assertProvider(stage, "anthropic");
  assertBudget(
    stage,
    projectRequestCost({ model, promptChars: system.length + user.length, images: frames.length, maxTokens }),
  );

  const client = new Anthropic({ apiKey: anthropicKeyOrFail(stage) });
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
