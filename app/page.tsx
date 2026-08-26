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

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [topic, setTopic] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then(setProjects)
      .catch(() => setProjects([]));
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
