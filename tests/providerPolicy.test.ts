import { test } from "node:test";
import assert from "node:assert/strict";
import { assertProvider, ProviderPolicyError, resetPolicyViolations, policyViolations, isAllowed } from "../lib/providerPolicy";
import { resetLedger, recordTokens, recordFlat, assertBudget, CostLimitError } from "../lib/costLedger";
import { formatCostReport } from "../lib/costReport";

test("1: чужой провайдер на чужой стадии запрещён и запоминается", () => {
  resetPolicyViolations();
  // именно этот случай и требовалось исключить: медиа-стадия уходит на OpenRouter
  assert.throws(() => assertProvider("Vision Verification", "openrouter"), ProviderPolicyError);
  assert.throws(() => assertProvider("Beat Matching", "openrouter"), ProviderPolicyError);
  assert.throws(() => assertProvider("Creative Director", "openrouter"), ProviderPolicyError);
  assert.throws(() => assertProvider("Script Beats", "brave"), ProviderPolicyError);
  // обложка — единственное место OpenRouter
  // OpenRouter разрешён РОВНО одной стадии — платной генерации картинки
  assert.doesNotThrow(() => assertProvider("Cover Generation", "openrouter"));
  assert.throws(() => assertProvider("Cover Generation", "anthropic"), ProviderPolicyError);
  // концепт и проверка обложки — это рассуждение и зрение, значит Anthropic
  assert.doesNotThrow(() => assertProvider("Cover Concept", "anthropic"));
  assert.doesNotThrow(() => assertProvider("Cover QC", "anthropic"));
  assert.throws(() => assertProvider("Cover Concept", "openrouter"), ProviderPolicyError);
  assert.throws(() => assertProvider("Cover QC", "openrouter"), ProviderPolicyError);
  // поиск — только Brave
  assert.ok(isAllowed("Media Research", "brave"));
  assert.ok(!isAllowed("Media Research", "openrouter"));
  // расшифровка — только ASR
  assert.ok(isAllowed("Transcription", "elevenlabs"));
  assert.ok(!isAllowed("Transcription", "anthropic"));

  assert.equal(policyViolations().length, 7, "все нарушения записаны для отчёта");
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
  assert.match(report, /OpenRouter calls outside COVER IMAGE GENERATION: 0/);
  assert.match(report, /Brave calls outside SEARCH:\s+0/);
  assert.match(report, /Anthropic calls for COVER IMAGE GENERATION: 0/);
  assert.ok(!report.includes("PROVIDER POLICY VIOLATION"), "нарушений нет — раздела нет");
  assert.match(report, /PROVIDER USAGE/);
  assert.match(report, /current run calls: 1/, "вызовы OpenRouter в этом прогоне видны отдельно");
  assert.match(report, /yt-dlp[\s\S]{0,30}cost:\s+\$0/, "yt-dlp бесплатен");
  assert.match(report, /FFmpeg[\s\S]{0,30}cost:\s+\$0/, "FFmpeg бесплатен");
});

test("4: жёсткий лимит останавливает трату ДО запроса", () => {
  resetLedger();
  process.env.MEDIA_JOB_HARD_LIMIT = "1";
  process.env.MEDIA_JOB_MAX_COST_USD = "1.00";
  try {
    // пока лимит не выбран, запросы разрешены
    assert.doesNotThrow(() => assertBudget("Script Beats"));
    recordTokens({ stage: "Script Beats", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 10, providerReportedCost: 0.6 });
    assert.doesNotThrow(() => assertBudget("Beat Matching"), "0.60$ из 1.00$ — работаем дальше");

    // как только предел достигнут, следующий платный запрос не отправляется
    recordTokens({ stage: "Vision Verification", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 10, providerReportedCost: 0.45 });
    assert.throws(() => assertBudget("Beat Matching"), CostLimitError, "1.05$ > 1.00$ — стоп до отправки");

    // историческая обложка в лимит не входит: она оплачена в прошлом запуске
    const report = formatCostReport({ title: "T" });
    assert.ok(!report.includes("PROVIDER POLICY VIOLATION"), "лимит — это не нарушение политики");
  } finally {
    delete process.env.MEDIA_JOB_HARD_LIMIT;
    delete process.env.MEDIA_JOB_MAX_COST_USD;
  }
});
