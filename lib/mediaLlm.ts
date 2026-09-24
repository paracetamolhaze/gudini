import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";
import { recordTokens, withBudget, projectRequestCost, CostStage, CostProvider } from "./costLedger";
import { assertProvider, ProviderPolicyError } from "./providerPolicy";
import { codexComplete, codexModel, codexEffort, CODEX_ADAPTER_VERSION } from "./codexLlm";
import { claudeBridgeComplete } from "./claudeBridgeClient";

/**
 * Explicit transport for the main video pipeline:
 * anthropic = direct Claude API, openrouter = Claude via OpenRouter,
 * codex = local CLI/Windows bridge using the owner's ChatGPT subscription.
 * No automatic switch after missing credentials, quota or failed requests.
 * Claude model overrides stay in their existing stage callers; Codex resolves
 * CODEX_SCRIPT_MODEL / CODEX_STORY_MODEL / CODEX_MODEL / CODEX_UTIL_MODEL by stage.
 * The script stage alone can go to the Claude bridge (SCRIPT_LLM_TRANSPORT=claude):
 * the owner compared scripts and chose Claude's text; research and the rest stay on the media transport.
 */
export const MEDIA_PROVIDER = "anthropic" as const;

export type MediaTransport = "anthropic" | "openrouter" | "codex";

const DEFAULT_MODEL = "claude-sonnet-5";

/** Идентификаторы тех же моделей на OpenRouter. */
const OPENROUTER_MODELS: Record<string, string> = {
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
  "claude-opus-5": "anthropic/claude-opus-5",
  "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4.5",
};

export function mediaProvider(): "anthropic" | "codex" {
  const provider = mediaTransport() === "codex" ? "codex" : MEDIA_PROVIDER;
  const requested = String(process.env.MEDIA_LLM_PROVIDER ?? "").toLowerCase();
  if (requested && requested !== provider) {
    // Явная попытка увести конвейер на чужого провайдера — это ошибка настройки,
    // а не повод тихо согласиться.
    throw new ProviderPolicyError("Media Research", requested as CostProvider, [provider]);
  }
  return provider;
}

export function mediaTransport(): MediaTransport {
  const t = String(process.env.MEDIA_LLM_TRANSPORT ?? "anthropic").toLowerCase();
  if (t === "anthropic" || t === "openrouter" || t === "codex") return t;
  throw new Error(`MEDIA_LLM_TRANSPORT=${t}: допустимы anthropic, openrouter и codex`);
}

/** Actual engine identity for plan cache invalidation and diagnostics. */
export function mediaEngine(stage: CostStage, legacyModel?: string) {
  const transport = mediaTransport();
  return transport === "codex"
    ? { transport, model: codexModel(stage), effort: codexEffort(stage), adapterVersion: CODEX_ADAPTER_VERSION }
    : { transport, model: transportModelId(legacyModel || mediaModel()) };
}

export function mediaModel(): string {
  return process.env.MEDIA_LLM_MODEL || DEFAULT_MODEL;
}

/** Имя модели для выбранного транспорта: у OpenRouter — с префиксом anthropic/. */
export function transportModelId(model: string): string {
  if (mediaTransport() !== "openrouter" || model.includes("/")) return model;
  return OPENROUTER_MODELS[model] ?? `anthropic/${model}`;
}

/**
 * Тип изображения по сигнатуре байтов, а не по расширению файла: генератор может
 * вернуть JPEG в файле .png, и тогда заявленный media_type ломает запрос к модели.
 */
export function detectImageMediaType(buffer: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && buffer.toString("latin1", 0, 3) === "GIF") return "image/gif";
  if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP")
    return "image/webp";
  return "image/jpeg";
}

export function mediaLlmAvailable(): boolean {
  // Missing CLI/auth must produce an actionable transport error, never demo content.
  if (mediaTransport() === "codex") return true;
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
/** Режим размышлений модели в OpenRouter: "off" — выключить (Claude 5 думает адаптивно и сам). */
export type ReasoningMode = "auto" | "off";

/**
 * Тело запроса OpenRouter. Размышления выключаются явно там, где они опасны: разбор
 * истории AI-фильма на речи в 124 с однажды потратил все 16 000 токенов ответа на
 * скрытые размышления и не выдал ни символа текста ($0.17 впустую).
 */
export function openrouterRequestBody(model: string, maxTokens: number, system: string, user: string | OpenRouterPart[], reasoning: ReasoningMode = "auto") {
  return {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // точная цена вызова в ответе — для учёта денег
    usage: { include: true },
    ...(reasoning === "off" ? { reasoning: { enabled: false } } : {}),
  };
}

async function openrouterChat(
  stage: CostStage,
  model: string,
  maxTokens: number,
  system: string,
  user: string | OpenRouterPart[],
  reasoning: ReasoningMode = "auto",
): Promise<{ text: string; truncated: boolean; finish: string; usage: any; reasoningTokens: number }> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterClaudeKeyOrFail(stage)}`,
      "Content-Type": "application/json",
      "X-Title": "Gudini",
    },
    body: JSON.stringify(openrouterRequestBody(model, maxTokens, system, user, reasoning)),
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
  // выходные токены, ушедшие в скрытые размышления модели, а не в текст: разбор истории
  // однажды упёрся в 6000 токенов с пустым текстом, и причина была не видна
  const reasoningTokens = Number(json?.usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
  return { text, truncated, finish, usage: json?.usage ?? {}, reasoningTokens };
}

export type CompleteArgs = {
  system: string;
  user: string;
  maxTokens?: number;
  /** для отчёта по стоимости: на какую стадию списывать этот вызов */
  stage?: CostStage;
  /** модель стадии: сценарий пишет Opus, утилитарные задачи — Sonnet */
  model?: string;
  /** "off" — запретить модели скрытые размышления (только транспорт OpenRouter) */
  reasoning?: ReasoningMode;
  /** "web" — Claude через мост сам проверяет свежие факты поиском (только мост Claude) */
  claudeTools?: "web";
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

/** Кто пишет сценарии: Claude через мост на Windows или общий транспорт конвейера. */
export function scriptTransport(): "claude" | "media" {
  const t = String(process.env.SCRIPT_LLM_TRANSPORT ?? "").toLowerCase();
  if (t === "" || t === "media") return "media";
  if (t === "claude") return "claude";
  throw new Error(`SCRIPT_LLM_TRANSPORT=${t}: допустимы claude и media`);
}

/** Один текстовый запрос. Возвращает текст ответа или бросает ошибку — молча не глотаем. */
export async function mediaComplete(args: CompleteArgs): Promise<string> {
  if (args.stage === "Script Generation" && scriptTransport() === "claude") return completeWithClaudeBridge(args);
  if (mediaTransport() === "codex") return completeWithCodex(args);
  return withOneRetry((isRetry) => completeOnce(args, isRetry));
}

async function completeWithClaudeBridge(args: CompleteArgs): Promise<string> {
  const stage = args.stage || "Script Generation";
  assertProvider(stage, "anthropic");
  const model = process.env.CLAUDE_SCRIPT_MODEL || "claude-opus-5";
  return claudeBridgeComplete({ stage, model, system: args.system, user: args.user, task: "script", tools: args.claudeTools });
}

async function completeWithCodex(args: CompleteArgs & { images?: VisionImage[] }): Promise<string> {
  const stage = args.stage || "Media Research";
  mediaProvider();
  assertProvider(stage, "codex");
  const model = codexModel(stage);
  const effort = codexEffort(stage);
  const response = await codexComplete({ system: args.system, user: args.user, stage, model, effort, images: args.images });
  return response.text;
}

async function completeOnce(
  { system, user, maxTokens = 8000, stage = "Media Research", model: modelOverride, reasoning = "auto" }: CompleteArgs,
  isRetry = false,
): Promise<string> {
  const transport = mediaTransport();
  const model = transportModelId(modelOverride || mediaModel());
  mediaProvider(); // чужой провайдер в настройке — ошибка конфигурации
  // Политика проверяется ДО обращения к API: запрещённая пара не должна
  // успеть потратить деньги, а потом быть замеченной при учёте.
  assertProvider(stage, "anthropic");
  // Оценка запроса держит место в бюджете, пока провайдер не ответил: параллельные
  // вызовы больше не проходят проверку по одному и тому же остатку.
  return withBudget(stage, projectRequestCost({ model, promptChars: system.length + user.length, maxTokens }), async () => {
  if (transport === "openrouter") {
    const r = await openrouterChat(stage, model, maxTokens, system, user, reasoning);
    recordOpenRouterClaude(stage, model, r.usage, false, isRetry);
    if (r.truncated) {
      throw new Error(
        `Claude через OpenRouter: ответ обрезан по лимиту ${maxTokens} токенов (стадия «${stage}», текста ${r.text.length} символов` +
          `${r.reasoningTokens ? `, из них ${r.reasoningTokens} токенов ушло в размышления модели` : ""}) — увеличьте maxTokens или сократите запрос`,
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
  });
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
  if (mediaTransport() === "codex") {
    const images = args.images ?? (args.image ? [args.image] : []);
    if (!images.length) throw new Error("зрению не передан ни один кадр");
    return completeWithCodex({ ...args, stage: args.stage || "Vision Verification", images });
  }
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
  return withBudget(
    stage,
    projectRequestCost({ model, promptChars: system.length + user.length, images: frames.length, imageTokensEach, maxTokens }),
    async () => {
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
    },
  );
}

/** Снимает markdown-ограждение и парсит JSON. Ошибка разбора — это ошибка стадии. */
/**
 * Разбор JSON из ответа модели. Модель иногда пишет перед JSON рассуждение («Смотрю на историю:
 * это реальное событие…») и кладёт сам ответ в блок ```json. Прежний разбор снимал ограду только
 * в начале строки и брал текст от первой фигурной скобки, поэтому скобка в рассуждении ломала
 * весь ответ, и оплаченный план пропадал. Теперь сначала берётся содержимое ограды ```json, где
 * бы она ни стояла, затем перебираются сбалансированные объекты от каждой открывающей скобки.
 */
/** Позиция «}», на которой глубина скобок падает до нуля раньше конца текста; null — таких нет. */
function earlyClose(text: string): number | null {
  let depth = 0;
  let inString = false;
  const last = text.trimEnd().length - 1;
  for (let j = 0; j < text.length; j++) {
    const ch = text[j];
    if (inString) {
      if (ch === "\\") j++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && ch === "}" && j < last) return j;
    }
  }
  return null;
}

export function parseJson<T>(raw: string, stage: string): T {
  const candidates: string[] = [];
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim()).filter(Boolean);
  candidates.push(...fenced);
  candidates.push(raw.replace(/^```(json)?/m, "").replace(/```$/m, "").trim());
  // сбалансированные объекты: от каждой открывающей скобки до парной закрывающей, длинные первыми
  const spans: string[] = [];
  for (let i = raw.indexOf("{"); i >= 0 && spans.length < 8; i = raw.indexOf("{", i + 1)) {
    let depth = 0;
    let inString = false;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (inString) {
        if (ch === "\\") j++;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        spans.push(raw.slice(i, j + 1));
        break;
      }
    }
  }
  // Ранее закрытый объект: модель ставит лишнюю «}» после одного из списков, и дальше идёт
  // «, "beats": [...]}». Сбалансированный объект тогда обрывается на середине ответа, а
  // остаток — «лишние данные». Если после раннего закрытия стоит запятая, эта скобка лишняя.
  // Починенный вариант пробуется ДО сбалансированных обрезков: иначе разбор принимал первую
  // половину ответа за весь ответ, и план выходил без единой сцены.
  for (const c of [...candidates]) {
    const early = earlyClose(c);
    if (early != null && /^\s*,/.test(c.slice(early + 1))) candidates.push(c.slice(0, early) + c.slice(early + 1));
  }
  candidates.push(...spans.sort((a, b) => b.length - a.length));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object") return v as T;
    } catch {}
  }
  throw new Error(`${stage}: ответ модели не разобрался как JSON`);
}
