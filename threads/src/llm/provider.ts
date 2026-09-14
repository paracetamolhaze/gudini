/**
 * Provider-agnostic LLM contract. Providers only move bytes; prompts, schemas and business rules
 * live in services/. Nothing here knows about Threads.
 */

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string /* base64 */ };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | LlmContentPart[];
}

export interface LlmJsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  system?: string;
  messages: LlmMessage[];
  maxTokens: number;
  temperature?: number;
  /** Ask the provider for a JSON object matching this schema (json_schema / tool use). */
  jsonSchema?: LlmJsonSchema;
  timeoutMs?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cost in USD when available (OpenRouter returns it). */
  costUsd?: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  model: string;
  provider: string;
  stopReason?: string;
}

export interface EmbeddingResponse {
  vectors: number[][];
  usage: LlmUsage;
  model: string;
  provider: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
  embed?(texts: string[], model: string): Promise<EmbeddingResponse>;
  /** Cheap connectivity check (lists models or similar). Never throws. */
  test(): Promise<{ ok: boolean; message: string }>;
}

export class LlmError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(provider: string, message: string, status = 0, retryable = false) {
    super(`${provider}: ${message}`);
    this.name = "LlmError";
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
  }
}

export const LLM_TASKS = ["analysis", "writer", "reply", "vision", "translation", "embedding"] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

export type LlmProviderKind = "openrouter" | "openai" | "anthropic" | "gemini" | "openai-compatible";

export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "AbortError") return "request timed out";
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const c = cause as { code?: unknown; message?: unknown; errors?: unknown };
    if (typeof c.code === "string" && c.code) return `${err.message} (${c.code})`;
    if (Array.isArray(c.errors)) {
      for (const e of c.errors) {
        const code = (e as { code?: unknown })?.code;
        if (typeof code === "string" && code) return `${err.message} (${code})`;
      }
    }
    if (typeof c.message === "string" && c.message) return `${err.message}: ${c.message}`;
  }
  return err.message;
}

export function snippetOf(text: string, max = 300): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number; body: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}
