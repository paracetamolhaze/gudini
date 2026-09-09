"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { money, SpendRun } from "@/lib/spendMath";
import { Button, EmptyState, ErrorState, Field, StatusBadge, type StatusTone } from "./components/ui";

type Project = {
  id: string;
  topic: string;
  createdAt: string;
  script: string | null;
  rawVideo: string | null;
  processedVideo: string | null;
  cover?: string | null;
  coverStatus?: "ok" | "failed" | "headline_failed";
  processing: { state: string; step: string; progress: number; error?: string };
  publications: { platform: string; status: string; message?: string }[];
  outputs?: Partial<Record<"cards" | "ai_film", { file: string; at: string }>>;
};

/**
 * Статус проекта по тому, что реально сделано. Публикация в демо-режиме, пропуск и
 * ошибка — разные состояния, а не одно «Опубликовано».
 */
function projectStatus(p: Project): { text: string; tone: StatusTone; busy?: boolean; ready: boolean } {
  const pubs = p.publications ?? [];
  const hasVideo = Boolean(p.processedVideo || p.outputs?.cards || p.outputs?.ai_film);
  // сначала то, что происходит или требует внимания прямо сейчас
  if (p.processing?.state === "running") return { text: "Монтируется", tone: "accent", busy: true, ready: false };
  if (p.processing?.state === "error") return { text: "Ошибка монтажа", tone: "error", ready: hasVideo };
  const isDraft = (x: { message?: string }) => /черновик|private/i.test(x.message ?? "");
  if (pubs.some((x) => x.status === "published" && !isDraft(x))) return { text: "Опубликовано", tone: "success", ready: true };
  if (pubs.some((x) => x.status === "published")) return { text: "Черновик на платформе", tone: "accent", ready: true };
  if (pubs.some((x) => x.status === "error")) return { text: "Ошибка публикации", tone: "error", ready: hasVideo };
  if (pubs.some((x) => x.status === "demo")) return { text: "Демо-публикация", tone: "neutral", ready: hasVideo };
  if (pubs.length && pubs.every((x) => x.status === "skipped")) return { text: "Публикация пропущена", tone: "neutral", ready: hasVideo };
  if (hasVideo && !p.cover) return { text: "Нет обложки", tone: "warn", ready: true };
  if (hasVideo) return { text: "Видео готово", tone: "success", ready: true };
  if (p.rawVideo) return { text: "Запись загружена", tone: "neutral", ready: false };
  if (p.script) return { text: "Сценарий готов", tone: "neutral", ready: false };
  return { text: "Новый", tone: "neutral", ready: false };
}

function Thumb({ p }: { p: Project }) {
  const hasVideo = Boolean(p.processedVideo || p.outputs?.cards || p.outputs?.ai_film);
  if (p.cover) return <div className="thumb"><img src={`/api/projects/${p.id}/video?which=cover`} alt="" /></div>;
  if (hasVideo) return <div className="thumb"><video src={`/api/projects/${p.id}/video?which=processed#t=0.5`} muted playsInline preload="metadata" /></div>;
  if (p.rawVideo) return <div className="thumb"><video src={`/api/projects/${p.id}/video?which=raw#t=0.5`} muted playsInline preload="metadata" /></div>;
  return <div className="thumb small">Нет видео</div>;
}

function RowMenu({ onDelete }: { onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <Button variant="ghost" size="sm" aria-label="Действия с проектом" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        ⋯
      </Button>
      {open && (
        <div className="menu-list" role="menu">
          <button className="menu-item danger" role="menuitem" onClick={() => { setOpen(false); onDelete(); }}>
            Удалить проект
          </button>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [spend, setSpend] = useState<SpendRun[]>([]);
  const [topic, setTopic] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  // ошибка загрузки списка — отдельное состояние, а не пустой список
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/projects");
      const j = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(j)) throw new Error(j?.error ?? `ответ ${res.status}`);
      setProjects(j);
    } catch (e: any) {
      setLoadError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // журнал расходов — для «≈ $» у каждого проекта; провайдеры здесь не опрашиваются
    fetch("/api/spend")
      .then((r) => r.json())
      .then((j) => setSpend(j.spend ?? []))
      .catch(() => {});
  }, [load]);

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
      if (!res.ok) throw new Error(project.error ?? "Не удалось создать проект");
      router.push(`/project/${project.id}`);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setCreating(false);
    }
  }

  async function remove(p: Project) {
    if (!confirm(`Удалить проект «${p.topic}» вместе с видео? Отменить это будет нельзя.`)) return;
    const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Не удалось удалить проект");
      return;
    }
    setProjects((prev) => (prev ? prev.filter((x) => x.id !== p.id) : prev));
  }

  return (
    <main>
      <div className="page-head">
        <h1 className="page-title">Проекты</h1>
      </div>

      <div className="card">
        <div className="create-block">
          <Field label="Тема видео">
            <input
              type="text"
              placeholder="Например: 5 ошибок начинающих стримеров"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              disabled={creating}
            />
          </Field>
          <Button onClick={create} busy={creating} disabled={!topic.trim()}>
            {creating ? "Пишем сценарий…" : "Создать сценарий"}
          </Button>
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>

      <section className="section" aria-label="Список проектов">
        {loading && projects === null && (
          <div className="project-list" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div className="skeleton" key={i} style={{ height: 152 }} />
            ))}
          </div>
        )}
        {!loading && loadError && (
          <ErrorState title="Не удалось загрузить проекты" text={loadError} onRetry={() => void load()} />
        )}
        {projects && projects.length === 0 && !loadError && (
          <EmptyState title="Проектов пока нет" text="Введите тему выше, и первый сценарий появится через несколько секунд." />
        )}
        {projects && projects.length > 0 && (
          <div className="project-list">
            {projects.map((p) => {
              const st = projectStatus(p);
              const cost = spend.filter((r) => r.projectId === p.id).reduce((sum, r) => sum + r.total, 0);
              return (
                <div className="project-row" key={p.id}>
                  <Link href={`/project/${p.id}`} aria-hidden tabIndex={-1}>
                    <Thumb p={p} />
                  </Link>
                  <div className="project-main">
                    <Link href={`/project/${p.id}`} className="project-name">
                      {p.topic}
                    </Link>
                    <div className="project-meta">
                      <span>{new Date(p.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</span>
                      {cost > 0 && <span title="потрачено на этот проект по журналу">≈ {money(cost)}</span>}
                      <StatusBadge tone={st.tone} busy={st.busy}>
                        {st.text}
                      </StatusBadge>
                    </div>
                  </div>
                  <div className="project-actions">
                    <Link href={`/project/${p.id}`} className="btn btn-secondary btn-sm">
                      {st.ready ? "Открыть" : "Продолжить"}
                    </Link>
                    <RowMenu onDelete={() => void remove(p)} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
