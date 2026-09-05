"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BalanceLevel,
  ManualBalances,
  SpendRun,
  fmtWhen,
  manualRemaining,
  money,
  runsWord,
  spentSince,
  startOfMonth,
  startOfToday,
} from "@/lib/spendMath";

type Balance = {
  id: string;
  name: string;
  role: string;
  level: BalanceLevel;
  value: string;
  note: string;
  consoleUrl: string;
  manualAllowed: boolean;
};
type Payload = { balances: Balance[]; checkedAt: string; spend: SpendRun[]; manual: ManualBalances };

const LEVEL_TITLE: Record<BalanceLevel, string> = {
  ok: "хватает",
  low: "осталось мало",
  empty: "закончился",
  unknown: "остаток API не отдаёт",
  missing: "ключ не задан",
  error: "ошибка",
};

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  elevenlabs: "ElevenLabs",
  brave: "Brave",
  openai: "OpenAI",
  local: "локально",
};

function BalanceRow({ b, runs, manual, onManual }: { b: Balance; runs: SpendRun[]; manual: ManualBalances; onManual: (m: ManualBalances) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const today = spentSince(runs, b.id, startOfToday());
  const month = spentSince(runs, b.id, startOfMonth());
  // введённое вручную число действует только там, где остаток по API недоступен
  const m = b.manualAllowed ? manual[b.id] : undefined;
  let level = b.level;
  let value = b.value;
  let note = `${b.note} · по журналу: сегодня ${money(today)} · за месяц ${money(month)}`;
  if (m) {
    const r = manualRemaining(m, runs, b.id);
    value = `≈ ${money(Math.max(0, r.remaining))} осталось`;
    level = r.level;
    note = `введено ${money(m.balance)} ${fmtWhen(m.at)} · с тех пор ${money(r.since)} · сегодня ${money(today)} · за месяц ${money(month)}`;
  }

  async function save() {
    const balance = Number(draft.replace(",", "."));
    if (!Number.isFinite(balance) || balance < 0) {
      setErr("нужно число, например 0.84");
      return;
    }
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/balances/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: b.id, balance }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `ответ ${res.status}`);
      onManual(j.manual ?? {});
      setEditing(false);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`balance-row level-${level}`} title={LEVEL_TITLE[level]}>
      <span className="balance-dot" />
      <span className="balance-who">
        <span className="balance-name">{b.name}</span>
        <span className="balance-role">{b.role}</span>
      </span>
      <span className="balance-value">{value}</span>
      <span className="balance-note">
        {note}
        {b.manualAllowed && !editing && (
          <button
            className="balance-edit"
            onClick={() => {
              setDraft(m ? String(m.balance) : "");
              setErr("");
              setEditing(true);
            }}
          >
            {m ? "изменить остаток" : "ввести остаток из консоли"}
          </button>
        )}
        {editing && (
          <span className="balance-form">
            <input
              type="text"
              inputMode="decimal"
              value={draft}
              placeholder="0.84"
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setEditing(false);
              }}
            />
            <button className="btn btn-sm" onClick={save} disabled={saving}>
              {saving ? <span className="spin" /> : "OK"}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setEditing(false)} disabled={saving}>
              ✕
            </button>
            {err && <span className="balance-err">{err}</span>}
          </span>
        )}
      </span>
      <a className="balance-link" href={b.consoleUrl} target="_blank" rel="noreferrer">
        консоль ↗
      </a>
    </div>
  );
}

const STATUS_LABEL: Record<SpendRun["status"], { text: string; cls: string }> = {
  done: { text: "готово", cls: "success" },
  failed: { text: "упал", cls: "warn" },
  site: { text: "сайт", cls: "" },
};

export default function BalancesPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState("");

  async function load(refresh = false) {
    setLoading(true);
    setFailed("");
    try {
      const res = await fetch(`/api/balances${refresh ? "?refresh=1" : ""}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `ответ ${res.status}`);
      setData({ ...j, spend: j.spend ?? [], manual: j.manual ?? {} });
    } catch (e: any) {
      setFailed(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const runs = data?.spend ?? [];
  const manual = data?.manual ?? {};
  const problems = data
    ? data.balances.filter((b) => {
        const m = b.manualAllowed ? manual[b.id] : undefined;
        if (m) return manualRemaining(m, runs, b.id).level !== "ok";
        return b.level === "low" || b.level === "empty" || b.level === "error";
      }).length
    : 0;
  const monthStart = startOfMonth();
  const todayAll = spentSince(runs, null, startOfToday());
  const monthAll = spentSince(runs, null, monthStart);
  const monthRuns = runs.filter((r) => Date.parse(r.at) >= monthStart);
  const recent = [...runs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);

  return (
    <main>
      <div className="card balances">
        <div className="balances-head">
          <h2 style={{ margin: 0 }}>💳 Балансы API</h2>
          {data && (
            <span className={`badge ${problems ? "warn" : "success"}`}>{problems ? `${problems} требует внимания` : "всё в порядке"}</span>
          )}
          <span className="spacer" />
          {data && (
            <span className="hint">проверено {new Date(data.checkedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => load(true)} disabled={loading}>
            {loading ? <span className="spin" /> : "Обновить"}
          </button>
        </div>
        <p className="hint" style={{ marginBottom: 8 }}>
          OpenRouter и ElevenLabs отдают остаток сами. Где остатка по API нет (Brave, прямой Anthropic), введите число из консоли —
          дальше остаток считается по журналу расходов Gudini. После пополнения введите новое число.
        </p>
        {failed && <div className="error-box">{failed}</div>}
        {!data && loading && <p className="hint">Опрашиваю провайдеров…</p>}
        {data && (
          <div className="balance-rows">
            <div className="balance-row balance-row-head">
              <span />
              <span>Сервис</span>
              <span>Остаток</span>
              <span>Подробности</span>
              <span />
            </div>
            {data.balances.map((b) => (
              <BalanceRow key={b.id} b={b} runs={runs} manual={manual} onManual={(m) => setData((d) => (d ? { ...d, manual: m } : d))} />
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="balances-head">
          <h2 style={{ margin: 0 }}>📒 Журнал расходов</h2>
          {data && (
            <span className="hint">
              сегодня {money(todayAll)} · за месяц {money(monthAll)} ({monthRuns.length} {runsWord(monthRuns.length)})
            </span>
          )}
        </div>
        {data && !recent.length && <p className="hint">Пока пусто: журнал заполняется после каждого монтажа и платного действия на сайте.</p>}
        {recent.length > 0 && (
          <div className="runs">
            <div className="run-row run-row-head">
              <span>Когда</span>
              <span>Проект</span>
              <span>Действие</span>
              <span>Сумма</span>
              <span>По провайдерам</span>
            </div>
            {recent.map((r) => (
              <div className="run-row" key={r.runId}>
                <span className="hint">{fmtWhen(r.at)}</span>
                <span className="run-topic">
                  {r.projectId ? <Link href={`/project/${r.projectId}`}>{r.topic ?? r.projectId}</Link> : (r.topic ?? "—")}
                </span>
                <span>
                  {r.label} <span className={`badge ${STATUS_LABEL[r.status].cls}`}>{STATUS_LABEL[r.status].text}</span>
                </span>
                <span className="run-total">{money(r.total)}</span>
                <span className="hint">
                  {Object.entries(r.byProvider)
                    .filter(([, v]) => v > 0)
                    .map(([p, v]) => `${PROVIDER_NAMES[p] ?? p} ${money(v)}`)
                    .join(" · ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
