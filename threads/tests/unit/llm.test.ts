import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { extractJsonDocument, parseStructured, StructuredOutputError, jsonSchemaFor } from "../../src/llm/structured.js";
import { estimateCostUsd } from "../../src/llm/costs.js";
import { LlmRouter, type LlmCallRecord } from "../../src/llm/index.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../src/llm/provider.js";
import { loadEnv } from "../../src/config/env.js";

const baseEnv = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", LLM_PROVIDER: "openrouter", LLM_MODEL_ANALYSIS: "fake:m1" };

class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly answers: string[];
  readonly requests: LlmRequest[] = [];
  constructor(answers: string[]) {
    this.answers = answers;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const text = this.answers.shift() ?? "";
    return { text, usage: { inputTokens: 10, outputTokens: 5 }, model: req.model, provider: "fake" };
  }
  async test() {
    return { ok: true, message: "fake" };
  }
}

test("extractJsonDocument tolerates fences and prose around the JSON", () => {
  assert.equal(extractJsonDocument('Here you go:\n```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJsonDocument('text {"a":{"b":"}"}} trailing'), '{"a":{"b":"}"}}');
  assert.equal(extractJsonDocument("no json here"), null);
});

test("parseStructured rejects output that does not match the schema instead of guessing", () => {
  const schema = z.object({ relevanceScore: z.number().min(0).max(100), worthPosting: z.boolean() });
  assert.deepEqual(parseStructured(schema, '{"relevanceScore": 80, "worthPosting": true}'), { relevanceScore: 80, worthPosting: true });
  assert.throws(() => parseStructured(schema, '{"relevanceScore": "high", "worthPosting": true}'), StructuredOutputError);
  assert.throws(() => parseStructured(schema, "The score is 80"), StructuredOutputError);
});

test("jsonSchemaFor produces a JSON schema without the $schema marker", () => {
  const js = jsonSchemaFor("x", z.object({ a: z.string() }));
  assert.equal(js.name, "x");
  assert.equal((js.schema as { type?: string }).type, "object");
  assert.equal("$schema" in js.schema, false);
});

test("estimateCostUsd prefers provider cost, then the pricing table, else null", () => {
  assert.equal(estimateCostUsd("anthropic/claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0, costUsd: 1.23 }), 1.23);
  assert.equal(estimateCostUsd("anthropic/claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 18);
  assert.equal(estimateCostUsd("some/unknown-model", { inputTokens: 100, outputTokens: 100 }), null);
});

test("router.structured repairs once on invalid output and records both calls in the ledger", async () => {
  const provider = new FakeProvider(['{"score": "bad"}', '{"score": 42}']);
  const router = new LlmRouter(loadEnv(baseEnv));
  router.registerProvider("fake", provider);
  const ledger: LlmCallRecord[] = [];
  router.setLedger((r) => {
    ledger.push(r);
  });
  const { data } = await router.structured({
    task: "analysis",
    operation: "test",
    schema: z.object({ score: z.number() }),
    schemaName: "Score",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(data.score, 42);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[1]?.operation, "test:repair");
  assert.ok(provider.requests[0]?.system?.includes("OUTPUT FORMAT"));
  assert.ok(provider.requests[0]?.jsonSchema);
});

test("router fails loudly when a task has no model configured", () => {
  const router = new LlmRouter(loadEnv({ ...baseEnv, LLM_MODEL_ANALYSIS: "" }), () => ({ analysis: "", writer: "", reply: "", vision: "", translation: "", embedding: "" }));
  assert.throws(() => router.resolve("analysis"), /no model configured/);
});
