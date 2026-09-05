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

const LEVEL_TITLE: Record<Balance["level"], string> = {
  ok: "хватает",
  low: "осталось мало",
  empty: "закончился",
  unknown: "остаток API не отдаёт",
  missing: "ключ не задан",
  error: "ошибка",
};

/** Остатки по внешним API — одной таблицей наверху: кто, за что отвечает, сколько осталось. */
function BalancesBar() {
  const [data, setData] = useState<{ balances: Balance[]; checkedAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState("");

  async function load(refresh = false) {
    setLoading(true);
    setFailed("");
    try {
      const res = await fetch(`/api/balances${refresh ? "?refresh=1" : ""}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `ответ ${res.status}`);
      setData(j);
    } catch (e: any) {
      setFailed(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const problems = data?.balances.filter((b) => b.level === "low" || b.level === "empty" || b.level === "error").length ?? 0;

  return (
    <div className="card balances">
      <div className="balances-head">
        <h2 style={{ margin: 0 }}>💳 Балансы API</h2>
        {data && (
          <span className={`badge ${problems ? "warn" : "success"}`}>
            {problems ? `${problems} требует внимания` : "всё в порядке"}
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
            <a key={b.id} className={`balance-row level-${b.level}`} href={b.consoleUrl} target="_blank" rel="noreferrer" title={LEVEL_TITLE[b.level]}>
              <span className="balance-dot" />
              <span className="balance-who">
                <span className="balance-name">{b.name}</span>
                <span className="balance-role">{b.role}</span>
              </span>
              <span className="balance-value">{b.value}</span>
              <span className="balance-note">{b.note}</span>
              <span className="balance-link">консоль ↗</span>
            </a>
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
      <BalancesBar />
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
          {statusBadge(p)}
          <button className="btn btn-danger btn-sm" onClick={() => remove(p.id)}>
            ✕
          </button>
        </div>
      ))}
    </main>
  );
}
