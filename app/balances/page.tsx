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
  reported?: { today: number; month: number; total: number };
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
  anthropic: "Claude",
  openrouter: "OpenRouter",
  elevenlabs: "ElevenLabs",
  brave: "Brave",
  google: "Google Veo",
  openai: "OpenAI",
  local: "локально",
};

/**
 * Карточка провайдера: одна главная цифра, под ней таблица расхода с двумя строками —
 * что сообщил сам провайдер и что видел журнал Gudini. Ввод остатка из консоли —
 * отдельной строкой, а не внутри текста.
 */
function BalanceCard({ b, runs, manual, onManual }: { b: Balance; runs: SpendRun[]; manual: ManualBalances; onManual: (m: ManualBalances) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const today = spentSince(runs, b.id, startOfToday());
  const month = spentSince(runs, b.id, startOfMonth());
  const m = b.manualAllowed ? manual[b.id] : undefined;
  let level = b.level;
  let value = b.value;
  let caption = LEVEL_TITLE[level];
  let sinceManual: number | null = null;
  if (m) {
    const r = manualRemaining(m, runs, b.id);
    value = `≈ ${money(Math.max(0, r.remaining))}`;
    level = r.level;
    caption = `осталось от ${money(m.balance)}, введённых ${fmtWhen(m.at)}`;
    sinceManual = r.since;
  }
  // цифры провайдера показываются в таблице — дублировать их в подписи не нужно
  const note = b.reported ? "" : b.note;

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
    <div className={`balance-card level-${level}`}>
      <div className="balance-card-head">
        <span className="balance-dot" title={LEVEL_TITLE[level]} />
        <span className="balance-name">{b.name}</span>
        <span className="spacer" />
        <a className="balance-link" href={b.consoleUrl} target="_blank" rel="noreferrer">
          консоль ↗
        </a>
      </div>
      <div className="balance-role">{b.role}</div>
      <div className="balance-big">{value}</div>
      <div className="balance-caption">{caption}</div>
      <table className="balance-table">
        <thead>
          <tr>
            <th>Расход</th>
            <th>Сегодня</th>
            <th>Месяц</th>
            <th>{m ? "С момента ввода" : "Всего"}</th>
          </tr>
        </thead>
        <tbody>
          {b.reported && (
            <tr>
              <td>По данным провайдера</td>
              <td>{money(b.reported.today)}</td>
              <td>{money(b.reported.month)}</td>
              <td>{money(b.reported.total)}</td>
            </tr>
          )}
          <tr>
            <td>По журналу Gudini</td>
            <td>{money(today)}</td>
            <td>{money(month)}</td>
            <td>{sinceManual == null ? "—" : money(sinceManual)}</td>
          </tr>
        </tbody>
      </table>
      {note && <div className="balance-caption">{note}</div>}
      {b.manualAllowed && !editing && (
        <div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setDraft(m ? String(m.balance) : "");
              setErr("");
              setEditing(true);
            }}
          >
            {m ? "Изменить остаток" : "Ввести остаток из консоли"}
          </button>
        </div>
      )}
      {editing && (
        <div className="balance-form">
          <input
            type="text"
            inputMode="decimal"
            value={draft}
            placeholder="например 294.5"
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
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<SpendRun["status"], { text: string; cls: string }> = {
  done: { text: "готово", cls: "success" },
  failed: { text: "упал", cls: "warn" },
  site: { text: "на сайте", cls: "" },
};

const dayKey = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

export default function BalancesPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState("");
  const [showZero, setShowZero] = useState(false);
  const [showHow, setShowHow] = useState(false);

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
  const sorted = [...runs].sort((a, b) => b.at.localeCompare(a.at));
  const zeroCount = sorted.filter((r) => r.total < 0.005).length;
  const recent = sorted.filter((r) => showZero || r.total >= 0.005).slice(0, 60);
  const monthByProvider = Object.entries(
    monthRuns.reduce<Record<string, number>>((acc, r) => {
      for (const [p, v] of Object.entries(r.byProvider)) acc[p] = (acc[p] ?? 0) + v;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);

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
        {failed && <div className="error-box">{failed}</div>}
        {!data && loading && <p className="hint">Опрашиваю провайдеров…</p>}
        {data && (
          <>
            <div className="summary-tiles">
              <div className="tile">
                <div className="tile-label">Сегодня</div>
                <div className="tile-value">{money(todayAll)}</div>
              </div>
              <div className="tile">
                <div className="tile-label">Этот месяц</div>
                <div className="tile-value">{money(monthAll)}</div>
                <div className="tile-sub">
                  {monthRuns.length} {runsWord(monthRuns.length)}
                </div>
              </div>
              <div className="tile">
                <div className="tile-label">За месяц по сервисам</div>
                <div className="tile-sub" style={{ marginTop: 4 }}>
                  {monthByProvider.length
                    ? monthByProvider.map(([p, v]) => (
                        <span className="chip" key={p}>
                          {PROVIDER_NAMES[p] ?? p} {money(v)}
                        </span>
                      ))
                    : "—"}
                </div>
              </div>
            </div>
            <div className="balance-grid">
              {data.balances.map((b) => (
                <BalanceCard key={b.id} b={b} runs={runs} manual={manual} onManual={(m) => setData((d) => (d ? { ...d, manual: m } : d))} />
              ))}
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              <button className="balance-edit" onClick={() => setShowHow((v) => !v)}>
                {showHow ? "Скрыть, как это считается" : "Как это считается"}
              </button>
            </p>
            {showHow && (
              <ul className="hint how-list">
                <li>OpenRouter (и Claude через него) и ElevenLabs отдают остаток по API — это строка «По данным провайдера».</li>
                <li>Brave и Google остаток не отдают: введите число из их консоли, дальше остаток = введённое − расход по журналу Gudini с момента ввода. После пополнения введите новое число.</li>
                <li>«По журналу Gudini» — собственный учёт: каждый монтаж и платное действие на сайте. Он видит только те прогоны, чьи леджеры сохранились.</li>
                <li>Google Veo: $0.08 за секунду видео (720p, без звука). Точное списание и остаток кредитов — в биллинге Google Cloud, отчёты там отстают на сутки.</li>
              </ul>
            )}
          </>
        )}
      </div>

      <div className="card">
        <div className="balances-head">
          <h2 style={{ margin: 0 }}>📒 Журнал расходов</h2>
          <span className="spacer" />
          {data && zeroCount > 0 && (
            <button className="balance-edit" onClick={() => setShowZero((v) => !v)}>
              {showZero ? "скрыть нулевые" : `показать нулевые (${zeroCount})`}
            </button>
          )}
        </div>
        {data && !recent.length && <p className="hint">Пока пусто: журнал заполняется после каждого монтажа и платного действия на сайте.</p>}
        {recent.length > 0 && (
          <div className="runs">
            {recent.map((r, i) => {
              const day = dayKey(r.at);
              const newDay = i === 0 || dayKey(recent[i - 1].at) !== day;
              const chips = Object.entries(r.byProvider).filter(([, v]) => v > 0);
              return (
                <div key={r.runId}>
                  {newDay && <div className="run-day">{day}</div>}
                  <div className={`run-row${r.total < 0.005 ? " run-row-zero" : ""}`}>
                    <span className="hint">{new Date(r.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="run-topic">
                      {r.projectId ? <Link href={`/project/${r.projectId}`}>{r.topic ?? r.projectId}</Link> : (r.topic ?? "—")}
                    </span>
                    <span>
                      {r.label} <span className={`badge ${STATUS_LABEL[r.status].cls}`}>{STATUS_LABEL[r.status].text}</span>
                    </span>
                    <span className="run-total">{money(r.total)}</span>
                    <span>
                      {chips.length
                        ? chips.map(([p, v]) => (
                            <span className="chip" key={p}>
                              {PROVIDER_NAMES[p] ?? p} {money(v)}
                            </span>
                          ))
                        : r.total >= 0.005 && <span className="chip">без разбивки</span>}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
