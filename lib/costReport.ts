import fs from "fs";
import path from "path";
import { summarize, ledger, infrastructurePerVideo, checkGuard, CostStage, CostProvider } from "./costLedger";
import { policyViolations, COVER_STAGES, isAllowed } from "./providerPolicy";

/**
 * Отчёт о стоимости одного ролика.
 *
 * Разделены три суммы, которые легко перепутать: сколько потратил ЭТОТ прогон,
 * сколько стоила сборка медиатеки внутри него и во сколько обошёлся ролик целиком
 * с учётом стадий, выполненных раньше. Стадия, которая не запускалась, помечается
 * NOT RUN, а не нулём: ноль означает «сделали бесплатно», и это неправда.
 *
 * Рядом с каждой стадией стоит провайдер — тогда чужой провайдер на чужой стадии
 * виден сразу, без чтения кода.
 */

const GROUPS: { title: string; stages: CostStage[] }[] = [
  { title: "RESEARCH / SCRIPT", stages: ["Story Research", "Script Generation", "Script Beats"] },
  { title: "TRANSCRIPTION / CLEANUP", stages: ["Transcription", "Speech Cleanup"] },
  { title: "SEARCH", stages: [] },
  { title: "MEDIA ANALYSIS", stages: ["Source Verification", "Vision Verification", "Beat Matching"] },
  { title: "MONTAGE", stages: ["Creative Director", "Metadata"] },
  { title: "COVER", stages: ["Cover Concept", "Cover Generation", "Cover QC"] },
];

const ASSET_PACK_STAGES: CostStage[] = [
  "Script Beats",
  "Media Research",
  "Source Verification",
  "Vision Verification",
  "Beat Matching",
];

const BRAVE_ENDPOINTS: { label: string; endpoint: string }[] = [
  { label: "Brave News", endpoint: "brave/news/search" },
  { label: "Brave Video", endpoint: "brave/videos/search" },
  { label: "Brave Image", endpoint: "brave/images/search" },
  { label: "Brave Web", endpoint: "brave/web/search" },
];

const usd = (n: number) => `$${n.toFixed(4)}`;
const num = (n: number) => n.toLocaleString("ru-RU");

export type HistoricalCover = {
  generation: number | null;
  qc: number | null;
  provider: string;
  status: string;
  source: string;
  note?: string;
};

/**
 * Стоимость уже сделанной обложки — из сохранённых файлов прогона, без единого
 * нового обращения к API. Если сохранённой цифры нет, так и пишем: выдумывать
 * стоимость нельзя, из неё складывается цена ролика.
 */
export function historicalCoverCost(dataDir = path.join(process.cwd(), "data")): HistoricalCover | null {
  try {
    const uploads = path.join(dataDir, "uploads");
    const found: { file: string; mtime: number }[] = [];
    for (const d of fs.readdirSync(uploads)) {
      const f = path.join(uploads, d, "cover-mode.json");
      if (fs.existsSync(f)) found.push({ file: f, mtime: fs.statSync(f).mtimeMs });
    }
    if (!found.length) return null;
    found.sort((a, b) => b.mtime - a.mtime);
    const j = JSON.parse(fs.readFileSync(found[0].file, "utf8"));
    return {
      generation: typeof j.generationCost === "number" ? j.generationCost : null,
      qc: typeof j.qcCost === "number" ? j.qcCost : null,
      provider: String(j.provider ?? "unknown"),
      status: String(j.status ?? "unknown"),
      source: found[0].file,
      note: j.status === "COVER_FAILED" ? "последний прогон обложки не прошёл QC" : undefined,
    };
  } catch {
    return null;
  }
}

export type ReportOptions = {
  title?: string;
  /** включить в полную стоимость ролика уже оплаченную обложку из прошлого прогона */
  includeHistoricalCover?: boolean;
  dataDir?: string;
};

export function formatCostReport(opts: ReportOptions | string = {}): string {
  const o: ReportOptions = typeof opts === "string" ? { title: opts } : opts;
  const s = summarize();
  const entries = ledger();
  const byStage = new Map(s.stages.map((x) => [x.stage, x]));
  const L: string[] = [];

  // провайдер и модель, реально обслужившие стадию
  const infoOf = (stage: CostStage) => {
    const es = entries.filter((e) => e.stage === stage);
    if (!es.length) return null;
    const provider = [...new Set(es.map((e) => e.provider))].join("+");
    const model = [...new Set(es.map((e) => e.model))].join(", ");
    return { provider, model, calls: es.reduce((n, e) => n + e.requests, 0) };
  };

  const bar = "=".repeat(60);
  L.push(bar);
  L.push(o.title ?? "GUDINI — COST PER VIDEO");
  L.push(bar);

  const cover = o.includeHistoricalCover ? historicalCoverCost(o.dataDir) : null;
  let historicalTotal = 0;
  const notRunStages: CostStage[] = [];
  const unknownStages: CostStage[] = [];

  for (const g of GROUPS) {
    L.push("");
    L.push(g.title);
    if (g.title === "SEARCH") {
      for (const b of BRAVE_ENDPOINTS) {
        const es = entries.filter((e) => e.model === b.endpoint);
        if (!es.length) {
          L.push(`  ${b.label.padEnd(24)} ${"NOT RUN".padStart(11)}`);
          continue;
        }
        const n = es.reduce((x, e) => x + e.requests, 0);
        const c = es.reduce((x, e) => x + e.estimatedCost, 0);
        L.push(`  ${b.label.padEnd(24)} ${usd(c).padStart(11)}   brave        ${n} запр.`);
      }
      continue;
    }
    for (const stage of g.stages) {
      const t = byStage.get(stage);
      if (!t) {
        // обложка могла быть сделана раньше — тогда её цена известна и берётся из файла
        if (cover && COVER_STAGES.includes(stage)) {
          const val = stage === "Cover Generation" ? cover.generation : stage === "Cover QC" ? cover.qc : null;
          if (val !== null) {
            historicalTotal += val;
            L.push(`  ${stage.padEnd(24)} ${usd(val).padStart(11)}   HISTORICAL — NOT RUN THIS JOB   ${cover.provider}`);
            continue;
          }
          // цену старой стадии восстановить нельзя — так и пишем, заново её не запускаем
          unknownStages.push(stage);
          L.push(`  ${stage.padEnd(24)} ${"UNKNOWN".padStart(11)}   HISTORICAL — значение не сохранено`);
          continue;
        }
        notRunStages.push(stage);
        L.push(`  ${stage.padEnd(24)} ${"NOT RUN".padStart(11)}`);
        continue;
      }
      const i = infoOf(stage);
      const flag = i && !isAllowed(stage, i.provider.split("+")[0] as CostProvider) ? "  ← ЧУЖОЙ ПРОВАЙДЕР" : "";
      L.push(
        `  ${stage.padEnd(24)} ${usd(t.cost).padStart(11)}   CURRENT   ${(i?.provider ?? "").padEnd(11)} ${i?.calls ?? 0} выз.${flag}`,
      );
    }
  }

  L.push("");
  L.push("-".repeat(60));
  L.push(`  ${"VARIABLE API COST".padEnd(24)} ${usd(s.totals.variableApiCost).padStart(11)}   — только этот прогон`);
  L.push(bar);

  // подробная таблица: стадия, провайдер, модель, вызовы, токены, цена
  const ai = entries.filter((e) => e.inputTokens || e.outputTokens);
  if (ai.length) {
    L.push("");
    L.push("ПОДРОБНО ПО СТАДИЯМ");
    L.push(
      "  " +
        "стадия".padEnd(21) +
        "провайдер".padEnd(12) +
        "модель".padEnd(24) +
        "выз.".padStart(5) +
        "вход".padStart(10) +
        "выход".padStart(9) +
        "кэш".padStart(9) +
        "цена".padStart(11),
    );
    const grouped = new Map<string, any>();
    for (const e of ai) {
      const k = `${e.stage}|${e.provider}|${e.model}`;
      const g = grouped.get(k) ?? { ...e, requests: 0, inputTokens: 0, outputTokens: 0, cache: 0, cost: 0, reported: false };
      g.requests += e.requests;
      g.inputTokens += e.inputTokens;
      g.outputTokens += e.outputTokens;
      g.cache += e.cacheReadTokens + e.cacheCreationTokens;
      g.cost += e.estimatedCost;
      g.reported = g.reported || e.providerReportedCost !== undefined;
      grouped.set(k, g);
    }
    for (const g of grouped.values()) {
      L.push(
        "  " +
          String(g.stage).slice(0, 20).padEnd(21) +
          String(g.provider).padEnd(12) +
          String(g.model).slice(0, 23).padEnd(24) +
          String(g.requests).padStart(5) +
          num(g.inputTokens).padStart(10) +
          num(g.outputTokens).padStart(9) +
          num(g.cache).padStart(9) +
          usd(g.cost).padStart(11) +
          (g.reported ? "" : " ~"),
      );
    }
    L.push("  (~ — цена по тарифу; без пометки — сумма, названная провайдером)");
  }

  L.push("");
  L.push("ИТОГО РАСХОД");
  L.push(`  LLM-вызовов          ${s.totals.llmCalls}`);
  L.push(`  вызовов зрения       ${s.totals.visionCalls}`);
  L.push(`  поисковых запросов   ${s.totals.searchRequests}`);
  L.push(`  входных токенов      ${num(s.totals.inputTokens)}`);
  L.push(`  выходных токенов     ${num(s.totals.outputTokens)}`);
  L.push(`  токенов из кэша      ${num(s.totals.cacheReadTokens)}`);
  if (s.totals.failedOrRetryCalls) {
    L.push(`  неудачных/повторов   ${s.totals.failedOrRetryCalls} на ${usd(s.totals.failedOrRetryCost)} — включены в сумму`);
  }

  // PROVIDER USAGE: вызовы и деньги по каждому провайдеру отдельно
  L.push("");
  L.push("PROVIDER USAGE");
  const stat = new Map<CostProvider, { calls: number; cost: number }>();
  for (const e of entries) {
    const cur = stat.get(e.provider) ?? { calls: 0, cost: 0 };
    cur.calls += e.requests;
    cur.cost += e.estimatedCost;
    stat.set(e.provider, cur);
  }
  const show = (name: string, key: CostProvider) => {
    const v = stat.get(key) ?? { calls: 0, cost: 0 };
    L.push(`  ${name}`);
    L.push(`    calls: ${v.calls}`);
    L.push(`    cost:  ${usd(v.cost)}`);
  };
  show("Anthropic", "anthropic");
  show("Brave", "brave");

  const orCalls = stat.get("openrouter")?.calls ?? 0;
  const orCost = stat.get("openrouter")?.cost ?? 0;
  L.push("  OpenRouter");
  L.push(`    current run calls: ${orCalls}`);
  L.push(`    current run cost:  ${usd(orCost)}`);
  L.push(`    historical cover cost: ${cover ? usd(historicalTotal) : "нет данных"}`);

  const asr = (stat.get("elevenlabs")?.cost ?? 0) + (stat.get("openai")?.cost ?? 0);
  const asrCalls = (stat.get("elevenlabs")?.calls ?? 0) + (stat.get("openai")?.calls ?? 0);
  L.push("  ASR");
  L.push(`    calls: ${asrCalls}`);
  L.push(`    cost:  ${usd(asr)}`);
  L.push("  yt-dlp");
  L.push("    cost:  $0");
  L.push("  FFmpeg");
  L.push("    cost:  $0");

  // изоляция провайдеров — три обязательных ответа
  const outsideCover = entries.filter((e) => e.provider === "openrouter" && !COVER_STAGES.includes(e.stage));
  const braveOutsideSearch = entries.filter((e) => e.provider === "brave" && e.model.startsWith("brave/") === false);
  const anthropicOnCover = entries.filter((e) => e.provider === "anthropic" && COVER_STAGES.includes(e.stage));
  L.push("");
  L.push("ИЗОЛЯЦИЯ ПРОВАЙДЕРОВ");
  L.push(`  OpenRouter calls outside COVER: ${outsideCover.length}`);
  L.push(`  Brave calls outside SEARCH:     ${braveOutsideSearch.length}`);
  L.push(`  Anthropic calls for COVER:      ${anthropicOnCover.length}`);

  const violations = policyViolations();
  if (violations.length || outsideCover.length || braveOutsideSearch.length || anthropicOnCover.length) {
    L.push("");
    L.push("*** PROVIDER POLICY VIOLATION ***");
    for (const v of violations) L.push(`  ${v.stage} → ${v.provider} (${v.at})`);
    for (const e of outsideCover) L.push(`  ${e.stage} → openrouter (${e.model})`);
    for (const e of anthropicOnCover) L.push(`  ${e.stage} → anthropic (${e.model})`);
    L.push("  Прогон считается неуспешным.");
  }

  const packCost = s.stages.filter((x) => ASSET_PACK_STAGES.includes(x.stage)).reduce((n, x) => n + x.cost, 0);
  const byProv = new Map<CostProvider, number>();
  for (const e of entries) byProv.set(e.provider, (byProv.get(e.provider) ?? 0) + e.estimatedCost);
  const asrCost = (byProv.get("elevenlabs") ?? 0) + (byProv.get("openai") ?? 0);

  L.push("");
  L.push(bar);
  L.push("1. CURRENT RUN COST — только этот запуск");
  L.push(`  Anthropic    ${usd(byProv.get("anthropic") ?? 0).padStart(11)}`);
  L.push(`  Brave        ${usd(byProv.get("brave") ?? 0).padStart(11)}`);
  L.push(`  OpenRouter   ${usd(byProv.get("openrouter") ?? 0).padStart(11)}`);
  L.push(`  Other paid   ${usd(asrCost).padStart(11)}`);
  L.push("  " + "-".repeat(24));
  L.push(`  CURRENT RUN  ${usd(s.totals.variableApiCost).padStart(11)}`);
  L.push(`  ASSET PACK   ${usd(packCost).padStart(11)}   — сборка медиатеки внутри этого запуска`);

  L.push("");
  L.push("2. FULL VIDEO VARIABLE COST — один production-ролик");
  const knownSoFar = s.totals.variableApiCost + historicalTotal;
  if (notRunStages.length || unknownStages.length) {
    L.push("  FULL VIDEO VARIABLE COST: INCOMPLETE");
    L.push(`  KNOWN COST SO FAR: ${usd(knownSoFar)}`);
    if (notRunStages.length) L.push(`  NOT RUN (нулём не считаем): ${notRunStages.join(", ")}`);
    if (unknownStages.length) L.push(`  UNKNOWN (цена не сохранена): ${unknownStages.join(", ")}`);
  } else {
    L.push(`  FULL VIDEO VARIABLE COST: ${usd(knownSoFar)}`);
  }

  L.push("");
  L.push("PROVIDER TOTALS / ONE VIDEO");
  L.push(`  Anthropic       ${usd(byProv.get("anthropic") ?? 0).padStart(11)}`);
  L.push(`  Brave           ${usd(byProv.get("brave") ?? 0).padStart(11)}`);
  L.push(`  OpenRouter      ${usd((byProv.get("openrouter") ?? 0) + historicalTotal).padStart(11)}   (только обложка)`);
  L.push(`  Transcription   ${asrCost ? usd(asrCost).padStart(11) : "NOT RUN".padStart(11)}`);
  L.push(`  Other paid      ${"$0".padStart(11)}`);
  L.push(`  yt-dlp          ${"$0".padStart(11)}`);
  L.push(`  FFmpeg          ${"$0".padStart(11)}`);
  L.push(bar);

  const infra = infrastructurePerVideo();
  L.push("");
  L.push(`INFRASTRUCTURE / VIDEO    ${infra.cost === null ? "нет данных" : usd(infra.cost)}  — ${infra.note}`);
  L.push("Railway/сервер/трафик в переменную стоимость API не входят.");
  if (cover) {
    L.push("");
    L.push(`Обложка взята из файла ${cover.source}`);
    L.push(`  провайдер ${cover.provider}, статус ${cover.status}${cover.note ? ` (${cover.note})` : ""}`);
  }

  if (s.unpricedModels.length) {
    L.push("");
    L.push(`ВНИМАНИЕ: тариф неизвестен для ${s.unpricedModels.join(", ")} — итог занижен.`);
  }
  const guard = checkGuard();
  if (guard.message) L.push("", `ВНИМАНИЕ: ${guard.message}`);
  return L.join("\n");
}
