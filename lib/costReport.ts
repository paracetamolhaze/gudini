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
            L.push(`  ${stage.padEnd(24)} ${usd(val).padStart(11)}   HISTORICAL / NOT RUN THIS JOB`);
            continue;
          }
          L.push(`  ${stage.padEnd(24)} ${"unknown".padStart(11)}   HISTORICAL / значение не сохранено`);
          continue;
        }
        L.push(`  ${stage.padEnd(24)} ${"NOT RUN".padStart(11)}`);
        continue;
      }
      const i = infoOf(stage);
      const flag = i && !isAllowed(stage, i.provider.split("+")[0] as CostProvider) ? "  ← ЧУЖОЙ ПРОВАЙДЕР" : "";
      L.push(
        `  ${stage.padEnd(24)} ${usd(t.cost).padStart(11)}   ${(i?.provider ?? "").padEnd(12)} ${i?.calls ?? 0} выз.${flag}`,
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

  // суммы по провайдерам: сразу видно, кто чем занимался
  L.push("");
  L.push("PROVIDER TOTALS");
  const byProvider = new Map<CostProvider, number>();
  for (const e of entries) byProvider.set(e.provider, (byProvider.get(e.provider) ?? 0) + e.estimatedCost);
  const label: Record<string, string> = {
    anthropic: "Anthropic",
    openrouter: "OpenRouter",
    brave: "Brave",
    elevenlabs: "ElevenLabs (ASR)",
    openai: "OpenAI (ASR)",
    local: "Local",
  };
  for (const key of ["anthropic", "openrouter", "brave", "elevenlabs", "openai"] as CostProvider[]) {
    L.push(`  ${label[key].padEnd(20)} ${usd(byProvider.get(key) ?? 0).padStart(11)}`);
  }
  if (cover) {
    L.push(`  ${"OpenRouter (обложка)".padEnd(20)} ${usd(historicalTotal).padStart(11)}   историческая, не в этом прогоне`);
  }
  L.push(`  ${"yt-dlp".padEnd(20)} ${"$0".padStart(11)}`);
  L.push(`  ${"FFmpeg".padEnd(20)} ${"$0".padStart(11)}`);

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
  const notRun = GROUPS.flatMap((g) => g.stages).filter(
    (st) => !byStage.has(st) && !(cover && COVER_STAGES.includes(st)),
  );

  L.push("");
  L.push(bar);
  L.push(`ASSET PACK COST:          ${usd(packCost)}   — только сборка медиатеки`);
  L.push(`CURRENT RUN COST:         ${usd(s.totals.variableApiCost)}   — вызовы, сделанные в этом прогоне`);
  if (notRun.length) {
    L.push(`FULL VIDEO VARIABLE COST: неполная — не запускались: ${notRun.join(", ")}`);
    L.push(`  (посчитано на сегодня: ${usd(s.totals.variableApiCost + historicalTotal)} = прогон + обложка из прошлого прогона)`);
  } else {
    L.push(`FULL VIDEO VARIABLE COST: ${usd(s.totals.variableApiCost + historicalTotal)}`);
  }
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
