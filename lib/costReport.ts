import { summarize, ledger, infrastructurePerVideo, checkGuard, CostStage } from "./costLedger";

/**
 * Человекочитаемый отчёт о стоимости одного ролика.
 *
 * Разделены три вещи, которые легко перепутать: сколько ресурсов ролик израсходовал
 * по тарифу, сколько из этого реально добавится к счёту с учётом бесплатных лимитов,
 * и во сколько обходится инфраструктура. Бесплатный лимит — не нулевая себестоимость:
 * израсходованный кредит кто-то оплатит следующим роликом.
 */

const ORDER: CostStage[] = [
  "Story Research",
  "Script Generation",
  "Script Beats",
  "Speech Cleanup",
  "Media Research",
  "Source Verification",
  "Vision Verification",
  "Beat Matching",
  "Creative Director",
  "Transcription",
  "Metadata",
  "Cover Concept",
  "Cover Generation",
  "Cover QC",
];

const usd = (n: number) => `$${n.toFixed(4)}`;

export function formatCostReport(title = "COST PER VIDEO"): string {
  const s = summarize();
  const entries = ledger();
  const lines: string[] = [];
  const byStage = new Map(s.stages.map((x) => [x.stage, x]));

  lines.push(`=== ${title} ===`);
  for (const stage of ORDER) {
    const t = byStage.get(stage);
    if (!t) continue;
    lines.push(`${stage.padEnd(24)} ${usd(t.cost).padStart(10)}${t.hasEstimates ? "  (по тарифу)" : "  (счёт провайдера)"}`);
  }
  for (const t of s.stages) if (!ORDER.includes(t.stage)) lines.push(`${t.stage.padEnd(24)} ${usd(t.cost).padStart(10)}`);

  lines.push("-".repeat(48));
  lines.push(`${"AI / API VARIABLE COST".padEnd(24)} ${usd(s.totals.variableApiCost).padStart(10)}`);

  // отдельно по поисковым запросам: Brave берёт деньги за запрос, а не за находку
  const brave = entries.filter((e) => e.provider === "brave");
  if (brave.length) {
    lines.push("");
    lines.push("Поисковые запросы (тарифицируются запросы, не результаты):");
    const byEndpoint = new Map<string, number>();
    for (const e of brave) byEndpoint.set(e.model, (byEndpoint.get(e.model) ?? 0) + e.requests);
    for (const [ep, n] of byEndpoint) lines.push(`  ${ep.padEnd(24)} ${String(n).padStart(4)} запросов`);
  }

  lines.push("");
  lines.push("Расход:");
  lines.push(`  LLM-вызовов        ${s.totals.llmCalls}`);
  lines.push(`  вызовов зрения     ${s.totals.visionCalls}`);
  lines.push(`  поисковых запросов ${s.totals.searchRequests}`);
  lines.push(`  входных токенов    ${s.totals.inputTokens.toLocaleString("ru-RU")}`);
  lines.push(`  выходных токенов   ${s.totals.outputTokens.toLocaleString("ru-RU")}`);
  lines.push(`  чтений из кэша     ${s.totals.cacheReadTokens.toLocaleString("ru-RU")}`);
  if (s.totals.failedOrRetryCalls) {
    lines.push(`  неудачных/повторов ${s.totals.failedOrRetryCalls} на ${usd(s.totals.failedOrRetryCost)} — включены в сумму`);
  }

  lines.push("");
  lines.push(`FULL VIDEO VARIABLE COST   ${usd(s.totals.variableApiCost)}`);
  const infra = infrastructurePerVideo();
  lines.push(`INFRASTRUCTURE / VIDEO     ${infra.cost === null ? "нет данных" : usd(infra.cost)}  — ${infra.note}`);
  lines.push(
    `TOTAL ESTIMATED / VIDEO    ${infra.cost === null ? "только переменная часть: " + usd(s.totals.variableApiCost) : usd(s.totals.variableApiCost + infra.cost)}`,
  );

  // бесплатные кредиты Brave программно не видны, поэтому вторую цифру не выдумываем
  lines.push("");
  lines.push("Gross usage cost — сумма выше: сколько ресурсов израсходовал ролик по тарифу.");
  lines.push(
    "Estimated out-of-pocket — определить нельзя: остаток бесплатных лимитов (Brave) через API не читается. " +
      "Бесплатный кредит не делает расход бесплатным, он лишь откладывает оплату.",
  );

  if (s.unpricedModels.length) {
    lines.push("");
    lines.push(`ВНИМАНИЕ: тариф неизвестен для ${s.unpricedModels.join(", ")} — итог занижен.`);
  }
  const guard = checkGuard();
  if (guard.message) lines.push("", `ВНИМАНИЕ: ${guard.message}`);

  lines.push("");
  lines.push("Бесплатно: yt-dlp $0, FFmpeg $0 (счёт идёт только за машинное время).");
  return lines.join("\n");
}
