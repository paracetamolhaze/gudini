import type { z } from "zod";
import { env, type Env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { AnthropicProvider } from "./anthropic.js";
import { DEFAULT_PRICING, estimateCostUsd, type PricingTable } from "./costs.js";
import { OpenAiCompatibleProvider } from "./openaiCompatible.js";
import {
  LlmError,
  type EmbeddingResponse,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderKind,
  type LlmRequest,
  type LlmResponse,
  type LlmTask,
} from "./provider.js";
import { StructuredOutputError, jsonSchemaFor, parseStructured } from "./structured.js";

/**
 * Task → (provider, model) routing plus the cost ledger. Model ids are written as `provider:model`
 * (`openrouter:anthropic/claude-sonnet-5`, `anthropic:claude-sonnet-5`, `gemini:gemini-3.5-flash`);
 * a bare model id uses the default provider from LLM_PROVIDER.
 */

export interface ModelSettings {
  analysis: string;
  writer: string;
  reply: string;
  vision: string;
  translation: string;
  embedding: string;
}

export interface LlmCallRecord {
  provider: string;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number | null;
  durationMs: number;
  ok: boolean;
  error?: string;
  refs?: LlmRefs;
}

export interface LlmRefs {
  candidateId?: string;
  draftId?: string;
  interactionId?: string;
  mediaAssetId?: string;
}

export type LlmLedger = (record: LlmCallRecord) => Promise<void> | void;

export interface ResolvedModel {
  provider: LlmProvider;
  providerKind: string;
  model: string;
}

export interface StructuredCallOptions<T> {
  task: LlmTask;
  operation: string;
  schema: z.ZodType<T>;
  schemaName: string;
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  refs?: LlmRefs;
  /** Retry once with the validation errors appended when the first answer does not validate. */
  repairRetry?: boolean;
  modelOverride?: string;
}

export interface TextCallOptions {
  task: LlmTask;
  operation: string;
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  refs?: LlmRefs;
  modelOverride?: string;
}

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

export function defaultModels(e: Env): ModelSettings {
  const fallback = e.LLM_PROVIDER === "anthropic" ? "claude-sonnet-5" : e.LLM_PROVIDER === "gemini" ? "gemini-3.5-flash" : e.LLM_PROVIDER === "openai" ? "gpt-5-mini" : DEFAULT_MODEL;
  return {
    analysis: e.LLM_MODEL_ANALYSIS || fallback,
    writer: e.LLM_MODEL_WRITER || fallback,
    reply: e.LLM_MODEL_REPLY || fallback,
    vision: e.LLM_MODEL_VISION || fallback,
    translation: e.LLM_MODEL_TRANSLATION || fallback,
    embedding: e.LLM_MODEL_EMBEDDING || "",
  };
}

export class LlmRouter {
  private readonly providers = new Map<string, LlmProvider>();
  private ledger: LlmLedger = () => undefined;
  private getModels: () => ModelSettings;
  private getPricing: () => PricingTable = () => DEFAULT_PRICING;
  private readonly e: Env;

  constructor(e: Env, getModels?: () => ModelSettings) {
    this.e = e;
    this.getModels = getModels ?? (() => defaultModels(e));
  }

  setModelsSource(fn: () => ModelSettings): void {
    this.getModels = fn;
  }

  setPricingSource(fn: () => PricingTable): void {
    this.getPricing = fn;
  }

  setLedger(fn: LlmLedger): void {
    this.ledger = fn;
  }

  registerProvider(kind: string, provider: LlmProvider): void {
    this.providers.set(kind, provider);
  }

  /** Build (and cache) a provider from env. Missing keys surface as errors at call time, not at boot. */
  provider(kind: LlmProviderKind | string): LlmProvider {
    const cached = this.providers.get(kind);
    if (cached) return cached;
    const e = this.e;
    let p: LlmProvider;
    switch (kind) {
      case "openrouter":
        p = new OpenAiCompatibleProvider({
          name: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: e.OPENROUTER_API_KEY || (e.LLM_PROVIDER === "openrouter" ? e.LLM_API_KEY : ""),
          extraHeaders: { "HTTP-Referer": e.PUBLIC_BASE_URL ?? "https://gudinijr.duckdns.org", "X-Title": "Gudini Threads" },
          requestUsageCost: true,
        });
        break;
      case "openai":
        p = new OpenAiCompatibleProvider({
          name: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: e.OPENAI_API_KEY || (e.LLM_PROVIDER === "openai" ? e.LLM_API_KEY : ""),
        });
        break;
      case "gemini":
        p = new OpenAiCompatibleProvider({
          name: "gemini",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          apiKey: e.GEMINI_API_KEY || (e.LLM_PROVIDER === "gemini" ? e.LLM_API_KEY : ""),
        });
        break;
      case "anthropic":
        p = new AnthropicProvider({ apiKey: e.ANTHROPIC_API_KEY || (e.LLM_PROVIDER === "anthropic" ? e.LLM_API_KEY : "") });
        break;
      case "openai-compatible":
        if (!e.LLM_BASE_URL) throw new LlmError("openai-compatible", "LLM_BASE_URL is required for the openai-compatible provider");
        p = new OpenAiCompatibleProvider({ name: "openai-compatible", baseUrl: e.LLM_BASE_URL, apiKey: e.LLM_API_KEY });
        break;
      default:
        throw new LlmError(kind, `unknown LLM provider "${kind}"`);
    }
    this.providers.set(kind, p);
    return p;
  }

  resolve(task: LlmTask, override?: string): ResolvedModel {
    const spec = (override ?? this.getModels()[task] ?? "").trim();
    if (!spec) throw new LlmError("router", `no model configured for task "${task}" (LLM_MODEL_${task.toUpperCase()} or Settings → Models)`);
    const m = spec.match(/^([a-z-]+):(.+)$/i);
    const kind = m ? m[1]!.toLowerCase() : this.e.LLM_PROVIDER;
    const model = m ? m[2]!.trim() : spec;
    return { provider: this.provider(kind), providerKind: kind, model };
  }

  private async record(rec: LlmCallRecord): Promise<void> {
    try {
      await this.ledger(rec);
    } catch (err) {
      logger().warn({ err }, "llm ledger write failed");
    }
  }

  async complete(task: LlmTask, req: Omit<LlmRequest, "model"> & { operation: string; refs?: LlmRefs; modelOverride?: string }): Promise<LlmResponse> {
    const { provider, model, providerKind } = this.resolve(task, req.modelOverride);
    const started = Date.now();
    try {
      const res = await provider.complete({ ...req, model });
      await this.record({
        provider: providerKind,
        model: res.model,
        operation: req.operation,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        estimatedCost: estimateCostUsd(res.model, res.usage, this.getPricing()),
        durationMs: Date.now() - started,
        ok: true,
        refs: req.refs,
      });
      return res;
    } catch (err) {
      await this.record({
        provider: providerKind,
        model,
        operation: req.operation,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: null,
        durationMs: Date.now() - started,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        refs: req.refs,
      });
      throw err;
    }
  }

  async text(opts: TextCallOptions): Promise<LlmResponse> {
    return this.complete(opts.task, {
      operation: opts.operation,
      system: opts.system,
      messages: opts.messages,
      maxTokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature,
      refs: opts.refs,
      modelOverride: opts.modelOverride,
    });
  }

  async structured<T>(opts: StructuredCallOptions<T>): Promise<{ data: T; response: LlmResponse }> {
    const jsonSchema = jsonSchemaFor(opts.schemaName, opts.schema);
    const system = `${opts.system}\n\nOUTPUT FORMAT: respond with a single JSON object matching this JSON schema and nothing else:\n${JSON.stringify(jsonSchema.schema)}`;
    const first = await this.complete(opts.task, {
      operation: opts.operation,
      system,
      messages: opts.messages,
      maxTokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature,
      jsonSchema,
      refs: opts.refs,
      modelOverride: opts.modelOverride,
    });
    try {
      return { data: parseStructured(opts.schema, first.text), response: first };
    } catch (err) {
      if (!(err instanceof StructuredOutputError) || opts.repairRetry === false) throw err;
      const repair = await this.complete(opts.task, {
        operation: `${opts.operation}:repair`,
        system,
        messages: [
          ...opts.messages,
          { role: "assistant", content: first.text.slice(0, 6000) },
          {
            role: "user",
            content: `Your previous answer did not validate against the schema: ${err.issues.slice(0, 8).join("; ")}. Return the corrected JSON object only.`,
          },
        ],
        maxTokens: opts.maxTokens ?? 2048,
        temperature: 0,
        jsonSchema,
        refs: opts.refs,
        modelOverride: opts.modelOverride,
      });
      return { data: parseStructured(opts.schema, repair.text), response: repair };
    }
  }

  async embed(texts: string[], refs?: LlmRefs): Promise<EmbeddingResponse | null> {
    const spec = this.getModels().embedding?.trim();
    if (!spec) return null;
    const { provider, model, providerKind } = this.resolve("embedding");
    if (!provider.embed) throw new LlmError(providerKind, "provider does not support embeddings");
    const started = Date.now();
    const res = await provider.embed(texts, model);
    await this.record({
      provider: providerKind,
      model,
      operation: "embedding",
      inputTokens: res.usage.inputTokens,
      outputTokens: 0,
      estimatedCost: estimateCostUsd(model, res.usage, this.getPricing()),
      durationMs: Date.now() - started,
      ok: true,
      refs,
    });
    return res;
  }

  /** Connectivity check for the provider behind each configured task model. Never throws. */
  async test(): Promise<Array<{ task: LlmTask; model: string; ok: boolean; message: string }>> {
    const out: Array<{ task: LlmTask; model: string; ok: boolean; message: string }> = [];
    const tested = new Map<string, { ok: boolean; message: string }>();
    for (const task of ["analysis", "writer", "reply", "vision", "translation"] as LlmTask[]) {
      try {
        const { provider, providerKind, model } = this.resolve(task);
        let result = tested.get(providerKind);
        if (!result) {
          result = await provider.test();
          tested.set(providerKind, result);
        }
        out.push({ task, model: `${providerKind}:${model}`, ...result });
      } catch (err) {
        out.push({ task, model: "", ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }
}

let router: LlmRouter | null = null;

export function llm(): LlmRouter {
  if (!router) router = new LlmRouter(env());
  return router;
}

export function setLlmRouterForTests(next: LlmRouter | null): void {
  router = next;
}

export * from "./provider.js";
export { StructuredOutputError, parseStructured, jsonSchemaFor, extractJsonDocument } from "./structured.js";
export { estimateCostUsd, DEFAULT_PRICING } from "./costs.js";
export type { PricingTable } from "./costs.js";
