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
 * Local Claude Code bridge (scripts/claude-bridge.mjs on the Windows host): text is written by the
 * owner's Max subscription through the CLI, so nothing here is billed as API usage.
 *
 * The CLI gives no schema guarantee, so structured calls only get a hard instruction to emit one JSON
 * document; parsing and validation stay with structured.ts on the caller's side.
 */

export interface ClaudeBridgeOptions {
  baseUrl: string;
  token: string;
  /** CLI runs are slow; the client must outlive the bridge's own run timeout. */
  defaultTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v !== null && typeof v === "object" ? (v as Json) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** `claude-sonnet-5+web` lets the owner turn on live search for one task from Settings, without code changes. */
export function splitModelSpec(model: string): { model: string; tools: "none" | "web" } {
  const trimmed = model.trim();
  const web = /\+web$/i.test(trimmed);
  return { model: web ? trimmed.replace(/\+web$/i, "") : trimmed, tools: web ? "web" : "none" };
}

function toText(m: LlmMessage): string {
  if (typeof m.content === "string") return m.content;
  if (m.content.some((p) => p.type === "image")) {
    throw new LlmError("claude-bridge", "the local Claude bridge takes text only; route vision tasks to another provider");
  }
  return m.content
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n")
    .trim();
}

export class ClaudeBridgeProvider implements LlmProvider {
  readonly name = "claude-bridge";
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClaudeBridgeOptions) {
    this.baseUrl = (opts.baseUrl ?? "").trim().replace(/\/+$/, "");
    this.token = (opts.token ?? "").trim();
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 330_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.token}` };
  }

  private assertConfigured(): void {
    if (!this.baseUrl) throw new LlmError(this.name, "CLAUDE_BRIDGE_URL is not set: start the bridge on Windows with `npm run bridge`", 0, false);
    if (!this.token) throw new LlmError(this.name, "CLAUDE_BRIDGE_TOKEN is not set", 0, false);
  }

  /** The bridge already phrases login and limit failures for the owner; keep its text and only set retryability. */
  private fail(status: number, body: string): never {
    const message = typeof asObj(safeJson(body)).error === "string" ? String(asObj(safeJson(body)).error) : `HTTP ${status} — ${snippetOf(body)}`;
    const retryable = status === 504 || (status >= 500 && status !== 503) || (status === 503 && /занят/i.test(message));
    throw new LlmError(this.name, message, status, retryable);
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      this.assertConfigured();
      const res = await fetchWithTimeout(`${this.baseUrl}/health`, { headers: this.headers() }, 15_000, this.fetchImpl);
      if (!res.ok) return { ok: false, message: `${this.name}: HTTP ${res.status} — ${snippetOf(res.body, 160)}` };
      const parsed = asObj(safeJson(res.body));
      return { ok: true, message: `${this.name}: connected${typeof parsed.model === "string" ? `, default model ${parsed.model}` : ""}` };
    } catch (err) {
      return { ok: false, message: `${this.name}: ${err instanceof LlmError ? err.message : describeFetchError(err)}` };
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.assertConfigured();
    const { model, tools } = splitModelSpec(req.model);
    const system = req.jsonSchema
      ? `${req.system ?? ""}\n\nJSON ONLY: return exactly one JSON document matching the schema above — no markdown fence, no explanation, nothing before or after it.`.trim()
      : req.system;
    const body = {
      model,
      tools,
      system,
      messages: req.messages.map((m) => ({ role: m.role, content: toText(m) })),
      maxTokens: req.maxTokens,
      ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
      ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}),
    };
    let res: { ok: boolean; status: number; body: string };
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/complete`,
        { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
        req.timeoutMs ?? this.defaultTimeoutMs,
        this.fetchImpl,
      );
    } catch (err) {
      throw new LlmError(this.name, describeFetchError(err), 0, true);
    }
    if (!res.ok) this.fail(res.status, res.body);
    const parsed = asObj(safeJson(res.body));
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) throw new LlmError(this.name, `bridge returned no text — ${snippetOf(res.body)}`);
    const usage = asObj(parsed.usage);
    return {
      text,
      // Subscription runs are not billed, so no costUsd is reported.
      usage: { inputTokens: num(usage.inputTokens), outputTokens: num(usage.outputTokens) },
      model: typeof parsed.model === "string" && parsed.model ? parsed.model : model,
      provider: this.name,
    };
  }
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}
