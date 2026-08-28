import { test } from "node:test";
import assert from "node:assert/strict";
import { assertProvider, ProviderPolicyError, resetPolicyViolations, policyViolations, isAllowed } from "../lib/providerPolicy";
import { resetLedger, recordTokens, recordFlat } from "../lib/costLedger";
import { formatCostReport } from "../lib/costReport";

test("1: чужой провайдер на чужой стадии запрещён и запоминается", () => {
  resetPolicyViolations();
  // именно этот случай и требовалось исключить: медиа-стадия уходит на OpenRouter
  assert.throws(() => assertProvider("Vision Verification", "openrouter"), ProviderPolicyError);
  assert.throws(() => assertProvider("Beat Matching", "openrouter"), ProviderPolicyError);
  assert.throws(() => assertProvider("Creative Director", "openrouter"), ProviderPolicyError);
  assert.throws(() => assertProvider("Script Beats", "brave"), ProviderPolicyError);
  // обложка — единственное место OpenRouter
  assert.doesNotThrow(() => assertProvider("Cover Generation", "openrouter"));
  assert.throws(() => assertProvider("Cover Generation", "anthropic"), ProviderPolicyError);
  // поиск — только Brave
  assert.ok(isAllowed("Media Research", "brave"));
  assert.ok(!isAllowed("Media Research", "openrouter"));
  // расшифровка — только ASR
  assert.ok(isAllowed("Transcription", "elevenlabs"));
  assert.ok(!isAllowed("Transcription", "anthropic"));

  assert.equal(policyViolations().length, 5, "все нарушения записаны для отчёта");
});

test("2: нарушение невозможно провести мимо учёта денег", () => {
  resetLedger();
  resetPolicyViolations();
  // запись расхода сама проверяет политику: обойти учёт и правило порознь нельзя
  assert.throws(
    () => recordTokens({ stage: "Vision Verification", provider: "openrouter", model: "x", inputTokens: 10 }),
    ProviderPolicyError,
  );
});

test("3: отчёт отвечает на три вопроса об изоляции и берёт цену обложки из файла", () => {
  resetLedger();
  resetPolicyViolations();
  recordTokens({ stage: "Vision Verification", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 5000, outputTokens: 500 });
  recordFlat({ stage: "Cover Generation", provider: "openrouter", model: "google/gemini-3.1-flash-image", cost: 0.068 });

  const report = formatCostReport({ title: "TEST" });
  assert.match(report, /OpenRouter calls outside COVER: 0/);
  assert.match(report, /Brave calls outside SEARCH:\s+0/);
  assert.match(report, /Anthropic calls for COVER:\s+0/);
  assert.ok(!report.includes("PROVIDER POLICY VIOLATION"), "нарушений нет — раздела нет");
  assert.match(report, /PROVIDER TOTALS/);
  assert.match(report, /yt-dlp\s+\$0/);
  assert.match(report, /FFmpeg\s+\$0/);
});
