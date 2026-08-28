import { summarize, ledger, infrastructurePerVideo, checkGuard, CostStage } from "./costLedger";

/**
 * Человекочитаемый отчёт о стоимости одного ролика.
 *
 * Разделены три вещи, которые легко перепутать: сколько стоила сборка медиатеки,
 * сколько потрачено на все уже выполненные стадии текущей задачи и сколько стоит
 * ролик целиком. Стадия, которая ещё не запускалась, помечается NOT RUN, а не
 * нулём: ноль означает «сделали бесплатно», а это неправда.
 */

const ORDER: CostStage[] = [
  "Story Research",
  "Script Generation",
  "Script Beats",
  "Media Research",
  "Source Verification",
  "Vision Verification",
  "Beat Matching",
  "Speech Cleanup",
  "Creative Director",
  "Transcription",
  "Metadata",
  "Cover Concept",
  "Cover Generation",
  "Cover QC",
];

/** Стадии, из которых состоит именно сборка медиатеки. */
const ASSET_PACK_STAGES: CostStage[] = [
  "Script Beats",
  "Media Research",
  "Source Verification",
  "Vision Verification",
  "Beat Matching",
];

const usd = (n: number) => `$${n.toFixed(4)}`;
const num = (n: number) => n.toLocaleString("ru-RU");

export function formatCostReport(title = "COST PER VIDEO"): string {
  const s = summarize();
  const entries = ledger();
  const byStage = new Map(s.stages.map((x) => [x.stage, x]));
  const lines: string[] = [];

  lines.push(`=== ${title} ===`);
  for (const stage of ORDER) {
    const t = byStage.get(stage);
    if (!t) {
      lines.push(`${stage.padEnd(24)} ${"NOT RUN".padStart(11)}`);
      continue;
    }
    lines.push(`${stage.padEnd(24)} ${usd(t.cost).padStart(11)}  ${t.hasEstimates ? "по тарифу" : "счёт провайдера"}`);
  }
  for (const t of s.stages) if (!ORDER.includes(t.stage)) lines.push(`${t.stage.padEnd(24)} ${usd(t.cost).padStart(11)}`);

  // Brave тарифицирует запросы, а не найденные результаты
  const brave = entries.filter((e) => e.provider === "brave");
  if (brave.length) {
    lines.push("");
    lines.push("Поисковые запросы (платим за запрос, не за находку):");
    const byEndpoint = new Map<string, { n: number; cost: number }>();
    for (const e of brave) {
      const cur = byEndpoint.get(e.model) ?? { n: 0, cost: 0 };
      cur.n += e.requests;
      cur.cost += e.estimatedCost;
      byEndpoint.set(e.model, cur);
    }
    for (const [ep, v] of byEndpoint) {
      lines.push(`  ${ep.padEnd(24)} ${String(v.n).padStart(4)} запр.  ${usd(v.cost).padStart(10)}`);
    }
  }

  // расход токенов по стадиям: видно не только цену, но и её причину
  const ai = entries.filter((e) => e.provider !== "brave" && (e.inputTokens || e.outputTokens));
  if (ai.length) {
    lines.push("");
    lines.push("Токены по стадиям:");
    lines.push(
      "  " +
        "стадия".padEnd(22) +
        "модель".padEnd(30) +
        "выз.".padStart(5) +
        "вход".padStart(10) +
        "выход".padStart(9) +
        "кэш".padStart(9) +
        "стоимость".padStart(12),
    );
    const key = (e: (typeof ai)[number]) => `${e.stage}|${e.model}`;
    const grouped = new Map<string, { stage: string; model: string; n: number; i: number; o: number; c: number; cost: number; reported: boolean }>();
    for (const e of ai) {
      const g = grouped.get(key(e)) ?? { stage: e.stage, model: e.model, n: 0, i: 0, o: 0, c: 0, cost: 0, reported: false };
      g.n += e.requests;
      g.i += e.inputTokens;
      g.o += e.outputTokens;
      g.c += e.cacheReadTokens + e.cacheCreationTokens;
      g.cost += e.estimatedCost;
      g.reported = g.reported || e.providerReportedCost !== undefined;
      grouped.set(key(e), g);
    }
    for (const g of grouped.values()) {
      lines.push(
        "  " +
          g.stage.slice(0, 21).padEnd(22) +
          g.model.slice(0, 29).padEnd(30) +
          String(g.n).padStart(5) +
          num(g.i).padStart(10) +
          num(g.o).padStart(9) +
          num(g.c).padStart(9) +
          usd(g.cost).padStart(12) +
          (g.reported ? "" : " ~"),
      );
    }
    lines.push("  (~ означает расчёт по тарифу; без пометки — сумма, названная провайдером)");
  }

  lines.push("");
  lines.push("Итого расход:");
  lines.push(`  LLM-вызовов          ${s.totals.llmCalls}`);
  lines.push(`  вызовов зрения       ${s.totals.visionCalls}`);
  lines.push(`  поисковых запросов   ${s.totals.searchRequests}`);
  lines.push(`  входных токенов      ${num(s.totals.inputTokens)}`);
  lines.push(`  выходных токенов     ${num(s.totals.outputTokens)}`);
  lines.push(`  токенов из кэша      ${num(s.totals.cacheReadTokens)}`);
  if (s.totals.failedOrRetryCalls) {
    lines.push(`  неудачных/повторов   ${s.totals.failedOrRetryCalls} на ${usd(s.totals.failedOrRetryCost)} — включены в сумму`);
  }

  const packCost = s.stages.filter((x) => ASSET_PACK_STAGES.includes(x.stage)).reduce((n, x) => n + x.cost, 0);
  const jobCost = s.totals.variableApiCost;
  const notRun = ORDER.filter((st) => !byStage.has(st));

  lines.push("");
  lines.push(`ASSET PACK COST            ${usd(packCost)}   — только сборка медиатеки`);
  lines.push(`CURRENT JOB COST           ${usd(jobCost)}   — все стадии, выполненные в этой задаче`);
  if (notRun.length) {
    lines.push(`FULL VIDEO VARIABLE COST   недоступна: не запускались ${notRun.join(", ")}`);
  } else {
    lines.push(`FULL VIDEO VARIABLE COST   ${usd(jobCost)}   — весь конвейер целиком`);
  }

  const infra = infrastructurePerVideo();
  lines.push(`INFRASTRUCTURE / VIDEO     ${infra.cost === null ? "нет данных" : usd(infra.cost)}  — ${infra.note}`);
  lines.push("(Railway/сервер/трафик считаются отдельно и в переменную стоимость API не входят.)");

  lines.push("");
  lines.push("Gross usage cost — суммы выше: сколько ресурсов израсходовано по тарифу.");
  lines.push(
    "Estimated out-of-pocket — достоверно определить нельзя: остаток бесплатных лимитов (Brave) " +
      "через API не читается. Бесплатный кредит не делает расход бесплатным, он лишь откладывает оплату.",
  );

  if (s.unpricedModels.length) {
    lines.push("");
    lines.push(`ВНИМАНИЕ: тариф неизвестен для ${s.unpricedModels.join(", ")} — итог занижен.`);
  }
  const guard = checkGuard();
  if (guard.message) lines.push("", `ВНИМАНИЕ: ${guard.message}`);

  lines.push("");
  lines.push("Бесплатно: yt-dlp $0, FFmpeg $0, перцептивные хэши сцен $0 (только машинное время).");
  return lines.join("\n");
}
