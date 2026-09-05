"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Project = {
  id: string;
  topic: string;
  createdAt: string;
  script: string | null;
  rawVideo: string | null;
  processedVideo: string | null;
  processing: { state: string; step: string; progress: number };
  publications: { platform: string; status: string }[];
};

function statusBadge(p: Project) {
  if (p.publications.some((x) => x.status === "published")) return <span className="badge success">Опубликовано</span>;
  if (p.publications.length) return <span className="badge accent">Демо-публикация</span>;
  if (p.processedVideo) return <span className="badge success">Смонтировано</span>;
  if (p.processing.state === "running") return <span className="badge warn">Монтаж…</span>;
  if (p.rawVideo) return <span className="badge warn">Видео загружено</span>;
  if (p.script) return <span className="badge">Сценарий готов</span>;
  return <span className="badge">Новый</span>;
}

type Balance = {
  id: string;
  name: string;
  role: string;
  level: "ok" | "low" | "empty" | "unknown" | "missing" | "error";
  value: string;
  note: string;
  consoleUrl: string;
};
type SpendRun = {
  runId: string;
  projectId: string | null;
  topic?: string;
  at: string;
  status: "done" | "failed" | "site";
  label: string;
  total: number;
  byProvider: Record<string, number>;
};
type ManualBalances = Record<string, { balance: number; at: string }>;
type BalancesPayload = { balances: Balance[]; checkedAt: string; spend: SpendRun[]; manual: ManualBalances };

const LEVEL_TITLE: Record<Balance["level"], string> = {
  ok: "хватает",
  low: "осталось мало",
  empty: "закончился",
  unknown: "остаток API не отдаёт",
  missing: "ключ не задан",
  error: "ошибка",
};

/** Провайдеры, у которых остаток по API недоступен: он вводится из консоли и дальше считается по журналу. */
const MANUAL_PROVIDERS = new Set(["anthropic", "brave"]);

const money = (v: number) => `$${v.toFixed(2)}`;
const fmtWhen = (iso: string) => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const startOfMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** Расход по журналу с момента since: по одному провайдеру или всего. */
function spentSince(runs: SpendRun[], provider: string | null, since: number): number {
  let sum = 0;
  for (const r of runs) if (Date.parse(r.at) >= since) sum += provider ? (r.byProvider[provider] ?? 0) : r.total;
  return sum;
}

function BalanceRow({ b, runs, manual, onManual }: { b: Balance; runs: SpendRun[]; manual: ManualBalances; onManual: (m: ManualBalances) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const today = spentSince(runs, b.id, startOfToday());
  const month = spentSince(runs, b.id, startOfMonth());
  const ours = `по журналу: сегодня ${money(today)} · за месяц ${money(month)}`;
  const m = manual[b.id];
  let level = b.level;
  let value = b.value;
  let note = `${b.note} · ${ours}`;
  if (m) {
    // остаток = введённое из консоли − всё, что журнал видел после ввода
    const since = spentSince(runs, b.id, Date.parse(m.at));
    const remaining = m.balance - since;
    value = `≈ ${money(Math.max(0, remaining))} осталось`;
    level = remaining <= 0 ? "empty" : remaining < Math.max(1, m.balance * 0.15) ? "low" : "ok";
    note = `введено ${money(m.balance)} ${fmtWhen(m.at)} · с тех пор ${money(since)} · сегодня ${money(today)} · за месяц ${money(month)}`;
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
        {MANUAL_PROVIDERS.has(b.id) && !editing && (
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

/** Остатки по внешним API — одной таблицей наверху: кто, за что отвечает, сколько осталось. */
function BalancesBar({ onSpend }: { onSpend?: (runs: SpendRun[]) => void }) {
  const [data, setData] = useState<BalancesPayload | null>(null);
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
      onSpend?.(j.spend ?? []);
    } catch (e: any) {
      setFailed(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runs = data?.spend ?? [];
  const manual = data?.manual ?? {};
  const problems = data
    ? data.balances.filter((b) => {
        const m = manual[b.id];
        if (m) {
          const remaining = m.balance - spentSince(runs, b.id, Date.parse(m.at));
          return remaining < Math.max(1, m.balance * 0.15);
        }
        return b.level === "low" || b.level === "empty" || b.level === "error";
      }).length
    : 0;
  const todayAll = spentSince(runs, null, startOfToday());
  const monthAll = spentSince(runs, null, startOfMonth());
  const monthRuns = runs.filter((r) => Date.parse(r.at) >= startOfMonth()).length;

  return (
    <div className="card balances">
      <div className="balances-head">
        <h2 style={{ margin: 0 }}>💳 Балансы API</h2>
        {data && (
          <span className={`badge ${problems ? "warn" : "success"}`}>
            {problems ? `${problems} требует внимания` : "всё в порядке"}
          </span>
        )}
        {data && (
          <span className="hint">
            по журналу: сегодня {money(todayAll)} · за месяц {money(monthAll)} ({monthRuns} {monthRuns === 1 ? "прогон" : monthRuns < 5 ? "прогона" : "прогонов"})
          </span>
        )}
        <span className="spacer" />
        {data && (
          <span className="hint">
            проверено {new Date(data.checkedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => load(true)} disabled={loading}>
          {loading ? <span className="spin" /> : "Обновить"}
        </button>
      </div>
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
  );
}

const PLATFORM_LABELS: { key: string; name: string; icon: string }[] = [
  { key: "youtube", name: "YouTube", icon: "▶️" },
  { key: "tiktok", name: "TikTok", icon: "🎵" },
  { key: "instagram", name: "Reels", icon: "📸" },
];

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [spend, setSpend] = useState<SpendRun[]>([]);
  const [connected, setConnected] = useState<Record<string, boolean> | null>(null);
  const [topic, setTopic] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then(setProjects)
      .catch(() => setProjects([]));
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setConnected(s.connected ?? {}))
      .catch(() => setConnected({}));
  }, []);

  async function create() {
    if (!topic.trim() || creating) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const project = await res.json();
      if (!res.ok) throw new Error(project.error ?? "Ошибка");
      router.push(`/project/${project.id}`);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setCreating(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Удалить проект вместе с видео?")) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    setProjects((prev) => (prev ? prev.filter((p) => p.id !== id) : prev));
  }

  return (
    <main>
      <BalancesBar onSpend={setSpend} />
      <div className="row" style={{ marginBottom: 14 }}>
        <span className="hint">Аккаунты публикации:</span>
        {PLATFORM_LABELS.map(({ key, name, icon }) => (
          <span key={key} className={`badge ${connected?.[key] ? "success" : ""}`}>
            {icon} {name} {connected === null ? "…" : connected[key] ? "✓ подключён" : "не подключён"}
          </span>
        ))}
        <Link className="hint" href="/settings" style={{ textDecoration: "underline" }}>
          настроить →
        </Link>
      </div>
      <div className="card">
        <h2>🎬 Новое видео</h2>
        <p className="hint">
          Напиши тему — ИИ выдаст сценарий на минуту. Прочитай его на камеру, загрузи запись, и Гудини сам
          смонтирует ролик с субтитрами, придумает описание и опубликует в TikTok, YouTube Shorts и Reels.
        </p>
        <label>Тема видео</label>
        <div className="row">
          <div style={{ flex: 1, minWidth: 240 }}>
            <input
              type="text"
              placeholder="Например: 5 ошибок начинающих стримеров"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
          </div>
          <button className="btn" onClick={create} disabled={creating || !topic.trim()}>
            {creating ? (
              <>
                <span className="spin" /> Пишу сценарий…
              </>
            ) : (
              "Создать сценарий ✨"
            )}
          </button>
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>

      <h2 style={{ margin: "26px 0 14px", fontSize: 18 }}>Мои проекты</h2>
      {projects === null && <p className="hint">Загрузка…</p>}
      {projects?.length === 0 && (
        <div className="empty">
          Пока пусто. Введи тему выше — и через пару секунд у тебя будет готовый сценарий 🎩
        </div>
      )}
      {projects?.map((p) => (
        <div className="project-item" key={p.id}>
          <Link href={`/project/${p.id}`} style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{p.topic}</div>
            <div className="hint">{new Date(p.createdAt).toLocaleString("ru-RU")}</div>
          </Link>
          {(() => {
            const cost = spend.filter((r) => r.projectId === p.id).reduce((sum, r) => sum + r.total, 0);
            return cost > 0 ? (
              <span className="hint" title="потрачено на этот проект по журналу">
                ≈ {money(cost)}
              </span>
            ) : null;
          })()}
          {statusBadge(p)}
          <button className="btn btn-danger btn-sm" onClick={() => remove(p.id)}>
            ✕
          </button>
        </div>
      ))}
    </main>
  );
}
