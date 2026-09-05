import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";
import { recordTokens, assertBudget, projectRequestCost, CostStage, CostProvider } from "./costLedger";
import { assertProvider, ProviderPolicyError } from "./providerPolicy";

/**
 * Транспорт для текстовых и зрительных вызовов основного видео-конвейера.
 *
 * Модели здесь ровно одного провайдера — Anthropic (Claude). Подмена модели молча
 * меняет качество разбора истории и цену ролика, а понять постфактум, чем собран
 * конкретный ролик, становится невозможно. Кончился доступ — задача останавливается
 * с внятной ошибкой, и решение принимает человек.
 *
 * Транспорт выбирается явно настройкой, а не обстоятельствами:
 * MEDIA_LLM_TRANSPORT=anthropic (по умолчанию) — прямой API Anthropic ключом ANTHROPIC_API_KEY;
 * MEDIA_LLM_TRANSPORT=openrouter — те же модели Claude через OpenRouter ключом
 * OPENROUTER_CLAUDE_KEY (отдельный от ключа обложек). Для этого аккаунта так дешевле:
 * Anthropic добавляет к пополнению 16 % налога, OpenRouter — 5,5 % комиссии, тарифы на
 * токены одинаковые; вдобавок OpenRouter называет точную цену каждого вызова, а остаток
 * ключа виден на странице балансов. Автоматического перехода между транспортами нет:
 * нет ключа выбранного транспорта — стадия падает.
 *
 * MEDIA_LLM_MODEL — модель Anthropic для стадий конвейера.
 * MEDIA_VISION_MODEL — отдельная модель для разбора кадров, если нужна другая.
 */

/** У медиа-конвейера провайдер моделей один и не выбирается. */
export const MEDIA_PROVIDER = "anthropic" as const;

export type MediaTransport = "anthropic" | "openrouter";

const DEFAULT_MODEL = "claude-sonnet-5";

/** Идентификаторы тех же моделей на OpenRouter. */
const OPENROUTER_MODELS: Record<string, string> = {
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
  "claude-opus-5": "anthropic/claude-opus-5",
  "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4.5",
};

export function mediaProvider(): typeof MEDIA_PROVIDER {
  const requested = String(process.env.MEDIA_LLM_PROVIDER ?? "").toLowerCase();
  if (requested && requested !== "anthropic") {
    // Явная попытка увести конвейер на чужого провайдера — это ошибка настройки,
    // а не повод тихо согласиться.
    throw new ProviderPolicyError("Media Research", requested as CostProvider, ["anthropic"]);
  }
  return MEDIA_PROVIDER;
}

export function mediaTransport(): MediaTransport {
  const t = String(process.env.MEDIA_LLM_TRANSPORT ?? "anthropic").toLowerCase();
  if (t === "anthropic" || t === "openrouter") return t;
  throw new Error(`MEDIA_LLM_TRANSPORT=${t}: допустимы только anthropic и openrouter`);
}

export function mediaModel(): string {
  return process.env.MEDIA_LLM_MODEL || DEFAULT_MODEL;
}

/** Имя модели для выбранного транспорта: у OpenRouter — с префиксом anthropic/. */
export function transportModelId(model: string): string {
  if (mediaTransport() !== "openrouter" || model.includes("/")) return model;
  return OPENROUTER_MODELS[model] ?? `anthropic/${model}`;
}

export function mediaLlmAvailable(): boolean {
  return mediaTransport() === "openrouter" ? Boolean(openrouterClaudeKey()) : Boolean(getSettings().anthropicKey);
}

/** Ключ Anthropic или внятный отказ. Никакого перехода на другого провайдера. */
function anthropicKeyOrFail(stage: CostStage): string {
  const key = getSettings().anthropicKey;
  if (!key) {
    throw new Error(
      `Стадия «${stage}» не выполнена: нет ключа Anthropic. ` +
        "Медиа-конвейер работает только на моделях Anthropic, автоматический переход на другого провайдера запрещён.",
    );
  }
  return key;
}

export function openrouterClaudeKey(): string {
  return process.env.OPENROUTER_CLAUDE_KEY || "";
}

/** Ключ OpenRouter для Claude или внятный отказ: на прямой Anthropic не переходим. */
function openrouterClaudeKeyOrFail(stage: CostStage): string {
  const key = openrouterClaudeKey();
  if (!key) {
    throw new Error(
      `Стадия «${stage}» не выполнена: MEDIA_LLM_TRANSPORT=openrouter, а ключ OPENROUTER_CLAUDE_KEY не задан. ` +
        "Автоматического перехода на прямой API Anthropic нет — задайте ключ или смените транспорт.",
    );
  }
  return key;
}

/** Списание по фактическому расходу токенов Anthropic. */
function recordAnthropic(stage: CostStage, model: string, response: any, failed = false, retry = false): void {
  assertProvider(stage, "anthropic");
  // Бюджет проверяется ДО запроса, а не здесь: ответ уже оплачен, и отказ
  // записать его означал бы потерянные деньги без следа в учёте.
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

/**
 * Списание вызова Claude через OpenRouter. Провайдер в учёте — Anthropic (деньги
 * уходят за его токены), модель — с префиксом anthropic/, цена — та, что назвал
 * OpenRouter в usage.cost, а не расчёт по тарифу.
 */
function recordOpenRouterClaude(stage: CostStage, model: string, usage: any, failed = false, retry = false): void {
  assertProvider(stage, "anthropic");
  const u = usage ?? {};
  const cost = Number(u.cost);
  recordTokens({
    stage,
    provider: "anthropic",
    model,
    inputTokens: Number(u.prompt_tokens ?? 0),
    outputTokens: Number(u.completion_tokens ?? 0),
    cacheCreationTokens: Number(u.prompt_tokens_details?.cache_write_tokens ?? 0),
    cacheReadTokens: Number(u.prompt_tokens_details?.cached_tokens ?? 0),
    providerReportedCost: Number.isFinite(cost) ? cost : undefined,
    failed,
    retry,
  });
}

type OpenRouterPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** Один запрос к OpenRouter (совместимый с OpenAI chat API). Ошибки — наружу, с кодом. */
async function openrouterChat(
  stage: CostStage,
  model: string,
  maxTokens: number,
  system: string,
  user: string | OpenRouterPart[],
): Promise<{ text: string; truncated: boolean; finish: string; usage: any }> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterClaudeKeyOrFail(stage)}`,
      "Content-Type": "application/json",
      "X-Title": "Gudini",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // точная цена вызова в ответе — для учёта денег
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    const code = json?.error?.code ?? res.status;
    const msg = String(json?.error?.message ?? res.statusText ?? "").replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`OpenRouter ${code}: ${msg || "ошибка без описания"}`);
  }
  const choice = json?.choices?.[0] ?? {};
  const content = choice?.message?.content;
  const text = (
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((p: any) => p?.type === "text")
            .map((p: any) => String(p.text ?? ""))
            .join("\n")
        : ""
  ).trim();
  const finish = String(choice?.finish_reason ?? "");
  const truncated = finish === "length" || String(choice?.native_finish_reason ?? "") === "max_tokens";
  return { text, truncated, finish, usage: json?.usage ?? {} };
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
    // Код ошибки может стоять и перед двоеточием, и перед телом ответа («500 {…}»):
    // разовый 500 от провайдера однажды уронил сопоставление после полностью
    // собранной медиатеки, потому что регулярка ждала только «500:».
    // обрезанный ответ повторять бессмысленно — тот же лимит даст тот же обрыв
    if (/обрезан по лимиту/.test(msg)) throw e;
    if (!/пустой ответ|\b(?:429|5\d\d)\b|timeout|ECONNRESET|fetch failed|overloaded|api_error/i.test(msg)) throw e;
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
  const transport = mediaTransport();
  const model = transportModelId(modelOverride || mediaModel());
  mediaProvider(); // чужой провайдер в настройке — ошибка конфигурации
  // Политика проверяется ДО обращения к API: запрещённая пара не должна
  // успеть потратить деньги, а потом быть замеченной при учёте.
  assertProvider(stage, "anthropic");
  assertBudget(stage, projectRequestCost({ model, promptChars: system.length + user.length, maxTokens }));

  if (transport === "openrouter") {
    const r = await openrouterChat(stage, model, maxTokens, system, user);
    recordOpenRouterClaude(stage, model, r.usage, false, isRetry);
    if (r.truncated) {
      throw new Error(
        `Claude через OpenRouter: ответ обрезан по лимиту ${maxTokens} токенов (стадия «${stage}», текста ${r.text.length} символов) — увеличьте maxTokens или сократите запрос`,
      );
    }
    if (!r.text) throw new Error(`Claude через OpenRouter вернул пустой ответ (finish_reason=${r.finish || "нет"})`);
    return r.text;
  }

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
  // Обрезанный по лимиту ответ — не «пустой»: повторять тот же запрос бессмысленно,
  // а сообщение должно называть причину. Режиссёр на 24 блока упёрся в 8000 токенов,
  // и код дважды оплатил один и тот же обрезанный ответ.
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `Anthropic: ответ обрезан по лимиту ${maxTokens} токенов (стадия «${stage}», блоков контента ${response.content.length}, текста ${text.length} символов) — увеличьте maxTokens или сократите запрос`,
    );
  }
  if (!text) {
    const kinds = response.content.map((b) => b.type).join(",") || "нет";
    throw new Error(`Anthropic вернул пустой ответ (stop_reason=${response.stop_reason}, блоки: ${kinds})`);
  }
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
  /** оценка токенов на кадр для резервирования бюджета; по умолчанию — полный кадр */
  imageTokensEach?: number;
  /** модель стадии: QC обложки дешевле делать на младшей модели */
  model?: string;
};

/**
 * Запрос со зрением через тот же транспорт.
 * Описание кадров — обязательная часть сборки медиатеки: без него ни один
 * видео-сегмент не проходит дальше, поэтому оно не должно зависеть от отдельного счёта.
 */
export async function mediaVision(args: VisionArgs): Promise<string> {
  return withOneRetry((isRetry) => visionOnce(args, isRetry));
}

async function visionOnce(
  { system, user, image, images, maxTokens = 2000, stage = "Vision Verification", model: modelOverride, imageTokensEach }: VisionArgs,
  isRetry = false,
): Promise<string> {
  const frames = images ?? (image ? [image] : []);
  if (!frames.length) throw new Error("зрению не передан ни один кадр");
  const transport = mediaTransport();
  const model = transportModelId(modelOverride || process.env.MEDIA_VISION_MODEL || mediaModel());
  mediaProvider();
  assertProvider(stage, "anthropic");
  assertBudget(
    stage,
    projectRequestCost({ model, promptChars: system.length + user.length, images: frames.length, imageTokensEach, maxTokens }),
  );

  if (transport === "openrouter") {
    const parts: OpenRouterPart[] = [
      ...frames.map((f): OpenRouterPart => ({
        type: "image_url",
        image_url: { url: "url" in f ? f.url : `data:${f.mediaType};base64,${f.base64}` },
      })),
      { type: "text", text: user },
    ];
    const r = await openrouterChat(stage, model, maxTokens, system, parts);
    recordOpenRouterClaude(stage, model, r.usage, false, isRetry);
    if (!r.text) throw new Error(`Claude vision через OpenRouter вернул пустой ответ (finish_reason=${r.finish || "нет"})`);
    return r.text;
  }

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
