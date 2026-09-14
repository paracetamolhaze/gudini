import {
  LlmError,
  describeFetchError,
  fetchWithTimeout,
  snippetOf,
  type EmbeddingResponse,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "./provider.js";

/**
 * Any OpenAI-compatible chat endpoint: OpenRouter, OpenAI, Gemini's OpenAI layer, Ollama, LM Studio.
 * Adapted from eisenjimmy/autoTHREADS llm.ts (MIT) with structured output and usage accounting added.
 */

export interface OpenAiCompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  /** OpenRouter reports cost when `usage.include` is requested. */
  requestUsageCost?: boolean;
  defaultTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v !== null && typeof v === "object" ? (v as Json) : {});

function toOpenAiMessages(req: LlmRequest): Json[] {
  const out: Json[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) out.push({ role: m.role, content: toContent(m) });
  return out;
}

function toContent(m: LlmMessage): unknown {
  if (typeof m.content === "string") return m.content;
  return m.content.map((p) =>
    p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } },
  );
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly requestUsageCost: boolean;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiCompatibleOptions) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
    this.apiKey = (opts.apiKey ?? "").trim();
    this.extraHeaders = opts.extraHeaders ?? {};
    this.requestUsageCost = opts.requestUsageCost ?? false;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      ...this.extraHeaders,
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetchWithTimeout(`${this.baseUrl}/models`, { headers: this.headers() }, 15_000, this.fetchImpl);
      if (!res.ok) return { ok: false, message: `${this.name}: HTTP ${res.status} — ${snippetOf(res.body, 160)}` };
      const list = asObj(safeJson(res.body)).data;
      const count = Array.isArray(list) ? list.length : 0;
      return { ok: true, message: `${this.name}: connected${count ? `, ${count} models listed` : ""}` };
    } catch (err) {
      return { ok: false, message: `${this.name}: ${describeFetchError(err)}` };
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const timeout = req.timeoutMs ?? this.defaultTimeoutMs;
    const hasImages = req.messages.some((m) => typeof m.content !== "string" && m.content.some((p) => p.type === "image"));
    const base: Json = {
      model: req.model,
      messages: toOpenAiMessages(req),
      max_tokens: req.maxTokens,
      ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
      ...(this.requestUsageCost ? { usage: { include: true } } : {}),
    };
    // First try a strict JSON schema; providers that reject response_format get a plain json_object retry.
    const attempts: Json[] = req.jsonSchema
      ? [
          { ...base, response_format: { type: "json_schema", json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: false } } },
          { ...base, response_format: { type: "json_object" } },
          base,
        ]
      : [base];

    let lastErr: LlmError | null = null;
    for (const body of attempts) {
      let res: { ok: boolean; status: number; body: string };
      try {
        res = await fetchWithTimeout(
          `${this.baseUrl}/chat/completions`,
          { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
          hasImages ? Math.max(timeout, 180_000) : timeout,
          this.fetchImpl,
        );
      } catch (err) {
        throw new LlmError(this.name, describeFetchError(err), 0, true);
      }
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        lastErr = new LlmError(this.name, `HTTP ${res.status} — ${snippetOf(res.body)}`, res.status, retryable);
        const mentionsFormat = /response_format|json_schema|json_object/i.test(res.body) && res.status === 400;
        if (mentionsFormat && attempts.indexOf(body) < attempts.length - 1) continue;
        throw lastErr;
      }
      const parsed = asObj(safeJson(res.body));
      const err = asObj(parsed.error);
      if (typeof err.message === "string" && err.message) {
        // OpenRouter reports upstream failures inside a 200 body.
        const code = typeof err.code === "number" ? err.code : 0;
        throw new LlmError(this.name, err.message, code, code === 429 || code >= 500);
      }
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      const first = asObj(choices[0]);
      const message = asObj(first.message);
      const text = extractText(message.content);
      if (!text && !hasToolText(message)) throw new LlmError(this.name, `response had no message content — ${snippetOf(res.body)}`);
      const usage = asObj(parsed.usage);
      return {
        text: text || hasToolText(message) || "",
        usage: {
          inputTokens: num(usage.prompt_tokens),
          outputTokens: num(usage.completion_tokens),
          ...(typeof usage.cost === "number" ? { costUsd: usage.cost } : {}),
        },
        model: typeof parsed.model === "string" ? parsed.model : req.model,
        provider: this.name,
        stopReason: typeof first.finish_reason === "string" ? first.finish_reason : undefined,
      };
    }
    throw lastErr ?? new LlmError(this.name, "no attempts made");
  }

  async embed(texts: string[], model: string): Promise<EmbeddingResponse> {
    let res: { ok: boolean; status: number; body: string };
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/embeddings`,
        { method: "POST", headers: this.headers(), body: JSON.stringify({ model, input: texts }) },
        60_000,
        this.fetchImpl,
      );
    } catch (err) {
      throw new LlmError(this.name, describeFetchError(err), 0, true);
    }
    if (!res.ok) throw new LlmError(this.name, `embeddings HTTP ${res.status} — ${snippetOf(res.body)}`, res.status, res.status >= 500);
    const parsed = asObj(safeJson(res.body));
    const data = Array.isArray(parsed.data) ? parsed.data : [];
    const vectors = data
      .map((d) => asObj(d).embedding)
      .filter((v): v is number[] => Array.isArray(v) && v.every((x) => typeof x === "number"));
    if (vectors.length !== texts.length) throw new LlmError(this.name, `embeddings returned ${vectors.length} vectors for ${texts.length} inputs`);
    const usage = asObj(parsed.usage);
    return { vectors, usage: { inputTokens: num(usage.prompt_tokens), outputTokens: 0 }, model, provider: this.name };
  }
}

function hasToolText(message: Json): string {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const first = asObj(calls[0]);
  const fn = asObj(first.function);
  return typeof fn.arguments === "string" ? fn.arguments : "";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const o = asObj(p);
        return typeof o.text === "string" ? o.text : "";
      })
      .join("")
      .trim();
  }
  return "";
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
