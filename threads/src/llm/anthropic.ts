import {
  LlmError,
  describeFetchError,
  fetchWithTimeout,
  snippetOf,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "./provider.js";

/**
 * Anthropic Messages API. Structured output goes through forced tool use (`input_schema`),
 * which is the reliable way to get schema-shaped JSON from Claude.
 */

const ANTHROPIC_VERSION = "2023-06-01";
type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v !== null && typeof v === "object" ? (v as Json) : {});

function toAnthropicContent(m: LlmMessage): unknown {
  if (typeof m.content === "string") return m.content;
  return m.content.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image", source: { type: "base64", media_type: p.mimeType, data: p.data } },
  );
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { "x-api-key": this.apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" };
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    if (!this.apiKey) return { ok: false, message: "anthropic: ANTHROPIC_API_KEY is empty" };
    try {
      const res = await fetchWithTimeout(`${this.baseUrl}/v1/models`, { headers: this.headers() }, 15_000, this.fetchImpl);
      if (!res.ok) return { ok: false, message: `anthropic: HTTP ${res.status} — ${snippetOf(res.body, 160)}` };
      return { ok: true, message: "anthropic: connected" };
    } catch (err) {
      return { ok: false, message: `anthropic: ${describeFetchError(err)}` };
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) throw new LlmError(this.name, "ANTHROPIC_API_KEY is empty");
    const body: Json = {
      model: req.model,
      max_tokens: req.maxTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages.map((m) => ({ role: m.role, content: toAnthropicContent(m) })),
      ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
    };
    if (req.jsonSchema) {
      body.tools = [{ name: req.jsonSchema.name, description: "Return the result as structured data.", input_schema: req.jsonSchema.schema }];
      body.tool_choice = { type: "tool", name: req.jsonSchema.name };
    }
    let res: { ok: boolean; status: number; body: string };
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/v1/messages`,
        { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
        req.timeoutMs ?? 180_000,
        this.fetchImpl,
      );
    } catch (err) {
      throw new LlmError(this.name, describeFetchError(err), 0, true);
    }
    if (!res.ok) {
      throw new LlmError(this.name, `HTTP ${res.status} — ${snippetOf(res.body)}`, res.status, res.status === 429 || res.status >= 500 || res.status === 529);
    }
    let parsed: Json;
    try {
      parsed = asObj(JSON.parse(res.body));
    } catch {
      throw new LlmError(this.name, `non-JSON response — ${snippetOf(res.body)}`);
    }
    const blocks = Array.isArray(parsed.content) ? parsed.content : [];
    let text = "";
    for (const block of blocks) {
      const b = asObj(block);
      if (req.jsonSchema && b.type === "tool_use" && b.name === req.jsonSchema.name) {
        text = JSON.stringify(b.input ?? {});
        break;
      }
      if (b.type === "text" && typeof b.text === "string") text += b.text;
    }
    text = text.trim();
    if (!text) throw new LlmError(this.name, `response had no ${req.jsonSchema ? "tool_use" : "text"} content — ${snippetOf(res.body)}`);
    const usage = asObj(parsed.usage);
    const inTok = num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
    return {
      text,
      usage: { inputTokens: inTok, outputTokens: num(usage.output_tokens) },
      model: typeof parsed.model === "string" ? parsed.model : req.model,
      provider: this.name,
      stopReason: typeof parsed.stop_reason === "string" ? parsed.stop_reason : undefined,
    };
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
