import fs from "fs";
import path from "path";
import { ledger, CostEntry, CostProvider } from "./costLedger";

/**
 * Журнал расходов Gudini — свой учёт вместо баланса, которого API провайдеров
 * (Anthropic, Brave) не отдают.
 *
 * Каждый прогон конвейера на воркере заканчивается файлом cost-runs/<метка>-<статус>.json
 * (копия pipeline-cost.json со всеми записями леджера). Воркер присылает сводку по
 * каждому такому файлу на сайт: сумма и разбивка по провайдерам. Платные действия
 * самого сайта (сценарий, описание, ручная обложка) записываются здесь же через
 * recordSiteSpend. Остаток считается от числа, которое пользователь ввёл из консоли:
 * остаток = введённая сумма − всё, что журнал видел после момента ввода.
 */

export type SpendRun = {
  /** уникально: `<projectId>:<файл леджера>` у воркера, `site:<время>:<случайное>` у сайта */
  runId: string;
  projectId: string | null;
  topic?: string;
  /** ISO-время конца прогона */
  at: string;
  status: "done" | "failed" | "site";
  /** «Монтаж», «Сценарий», «Обложка (ручная)» */
  label: string;
  total: number;
  byProvider: Partial<Record<CostProvider, number>>;
};

export type ManualBalance = { balance: number; at: string };
export type ManualBalances = Partial<Record<CostProvider, ManualBalance>>;

const DATA_DIR = path.join(process.cwd(), "data");
const SPEND_FILE = path.join(DATA_DIR, "spend-log.json");
const MANUAL_FILE = path.join(DATA_DIR, "balances-manual.json");
const PROVIDERS: CostProvider[] = ["anthropic", "openrouter", "brave", "elevenlabs", "openai", "local"];

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Сумма и разбивка по провайдерам: цена, названная провайдером, важнее тарифной. */
export function summarizeEntries(entries: CostEntry[]): { total: number; byProvider: Partial<Record<CostProvider, number>> } {
  const byProvider: Partial<Record<CostProvider, number>> = {};
  let total = 0;
  for (const e of entries) {
    const cost = Number(e.providerReportedCost ?? e.estimatedCost ?? 0);
    if (!(cost > 0)) continue;
    byProvider[e.provider] = round((byProvider[e.provider] ?? 0) + cost);
    total += cost;
  }
  return { total: round(total), byProvider };
}

/** Сводка прогона из файла леджера (pipeline-cost.json или его копии в cost-runs). */
export function runFromLedgerFile(file: string, projectId: string, status: "done" | "failed", topic?: string): SpendRun {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries: CostEntry[] = Array.isArray(json.entries) ? json.entries : [];
  const { total, byProvider } = summarizeEntries(entries);
  const stamp = path.basename(file).match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  const at =
    (typeof json.createdAt === "string" && !Number.isNaN(Date.parse(json.createdAt)) && json.createdAt) ||
    (stamp ? stamp[1].replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z") : null) ||
    new Date(fs.statSync(file).mtimeMs).toISOString();
  // pipeline-cost.json перезаписывается каждым прогоном: его runId — по времени создания,
  // иначе разные прогоны слились бы в один
  const base = path.basename(file);
  const runId = base === "pipeline-cost.json" ? `${projectId}:pipeline-cost@${at}` : `${projectId}:${base}`;
  return { runId, projectId, topic, at, status, label: "Монтаж", total, byProvider };
}

/** Имя копии леджера в cost-runs для данного времени создания (как в keepRunLedger). */
export function ledgerStamp(createdAt: string): string {
  return createdAt.replace(/[:.]/g, "-");
}

/** Проверка прогона, пришедшего снаружи (от воркера): только ожидаемые поля и типы. */
export function sanitizeRun(raw: any): SpendRun | null {
  if (!raw || typeof raw !== "object") return null;
  const runId = String(raw.runId ?? "").slice(0, 200);
  const at = String(raw.at ?? "");
  const status = raw.status;
  if (!runId || Number.isNaN(Date.parse(at))) return null;
  if (status !== "done" && status !== "failed" && status !== "site") return null;
  const byProvider: Partial<Record<CostProvider, number>> = {};
  for (const p of PROVIDERS) {
    const v = Number(raw.byProvider?.[p]);
    if (v > 0) byProvider[p] = round(v);
  }
  const total = Number(raw.total);
  return {
    runId,
    projectId: raw.projectId ? String(raw.projectId).slice(0, 64) : null,
    topic: raw.topic ? String(raw.topic).slice(0, 200) : undefined,
    at: new Date(at).toISOString(),
    status,
    label: String(raw.label ?? "Монтаж").slice(0, 60),
    total: total > 0 ? round(total) : 0,
    byProvider,
  };
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function readSpendLog(file = SPEND_FILE): SpendRun[] {
  const json = readJson<{ runs?: SpendRun[] }>(file, {});
  return Array.isArray(json.runs) ? json.runs : [];
}

/** Добавляет прогоны, пропуская уже известные runId; возвращает, сколько добавлено. */
export function appendSpendRuns(runs: SpendRun[], file = SPEND_FILE): { added: number; total: number } {
  const existing = readSpendLog(file);
  const known = new Set(existing.map((r) => r.runId));
  let added = 0;
  for (const r of runs) {
    if (known.has(r.runId)) continue;
    known.add(r.runId);
    existing.push(r);
    added++;
  }
  if (added) {
    existing.sort((a, b) => a.at.localeCompare(b.at));
    writeJsonAtomic(file, { runs: existing });
  }
  return { added, total: existing.length };
}

/**
 * Платное действие сайта попадает в журнал: считаются записи леджера, появившиеся
 * за время fn. Ошибка внутри fn не мешает записи — оплаченные вызовы были.
 */
export async function recordSiteSpend<T>(args: { projectId: string | null; topic?: string; label: string }, fn: () => Promise<T>): Promise<T> {
  const before = ledger().length;
  try {
    return await fn();
  } finally {
    try {
      const { total, byProvider } = summarizeEntries(ledger().slice(before));
      if (total > 0) {
        appendSpendRuns([
          {
            runId: `site:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
            projectId: args.projectId,
            topic: args.topic,
            at: new Date().toISOString(),
            status: "site",
            label: args.label,
            total,
            byProvider,
          },
        ]);
      }
    } catch {}
  }
}

export function readManualBalances(file = MANUAL_FILE): ManualBalances {
  const json = readJson<ManualBalances>(file, {});
  const out: ManualBalances = {};
  for (const p of PROVIDERS) {
    const v = json?.[p];
    if (v && Number.isFinite(Number(v.balance)) && !Number.isNaN(Date.parse(String(v.at)))) out[p] = { balance: Number(v.balance), at: String(v.at) };
  }
  return out;
}

/** Остаток из консоли провайдера, введённый пользователем; момент ввода — точка отсчёта. */
export function setManualBalance(provider: CostProvider, balance: number | null, file = MANUAL_FILE): ManualBalances {
  const all = readManualBalances(file);
  if (balance === null) delete all[provider];
  else all[provider] = { balance: round(balance), at: new Date().toISOString() };
  writeJsonAtomic(file, all);
  return all;
}

export function isCostProvider(v: unknown): v is CostProvider {
  return typeof v === "string" && (PROVIDERS as string[]).includes(v);
}
