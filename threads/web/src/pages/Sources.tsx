import { useState } from "react";
import { del, patch, post } from "../api";
import { useAction, useFetch, fmtDate } from "../hooks";
import { Badge, Button, Card, Empty, ErrorBox, Field, Label, Notice, Status, Toggle } from "../ui";

type Source = {
  id: string;
  type: string;
  username: string | null;
  name: string;
  url: string | null;
  language: string;
  priority: number;
  enabled: boolean;
  trust_score: number;
  translate_images: boolean;
  minimum_score: number | null;
  keywords: string[];
  poll_minutes: number;
  last_checked_at: string | null;
  last_post_at: string | null;
  last_error: string | null;
  last_status: string | null;
};

type SourcePost = { id: string; author_username: string; text: string; permalink: string | null; published_at: string | null; status: string; media_json: unknown[] };

export default function Sources() {
  const { data, error, reload } = useFetch<{ sources: Source[] }>("/sources", { intervalMs: 20_000 });
  const act = useAction();
  const [form, setForm] = useState({ type: "THREADS_PROFILE", username: "", url: "", name: "", priority: 2, language: "en", translate_images: false, minimum_score: "", keywords: "" });
  const [open, setOpen] = useState<string | null>(null);
  const posts = useFetch<{ posts: SourcePost[] }>(open ? `/sources/${open}/posts?limit=20` : null);

  async function add() {
    await act.run("Добавить источник", async () => {
      await post("/sources", {
        type: form.type,
        username: form.type === "THREADS_PROFILE" ? form.username : undefined,
        url: form.type === "THREADS_PROFILE" ? undefined : form.url,
        name: form.name || undefined,
        priority: Number(form.priority),
        language: form.language,
        translate_images: form.translate_images,
        minimum_score: form.minimum_score ? Number(form.minimum_score) : null,
        keywords: form.keywords.split(",").map((k) => k.trim()).filter(Boolean),
      });
      setForm({ ...form, username: "", url: "", name: "", keywords: "" });
    }, reload);
  }

  return (
    <>
      <Card title="Добавить источник">
        <div className="form-grid">
          <Field label="Тип">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="THREADS_PROFILE">Профиль Threads (@username)</option>
              <option value="THREADS_SEARCH">Поиск Threads по запросу</option>
              <option value="RSS">RSS / Atom лента</option>
            </select>
          </Field>
          {form.type === "THREADS_PROFILE" ? (
            <Field label="Username" note="публичный профиль с 100+ подписчиками; нужен threads_profile_discovery или threads_keyword_search"><input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="@crypto_blogger" /></Field>
          ) : (
            <Field label={form.type === "RSS" ? "URL ленты" : "Поисковый запрос"}><input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder={form.type === "RSS" ? "https://cointelegraph.com/rss" : "bitcoin ETF"} /></Field>
          )}
          <Field label="Название (необязательно)"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Приоритет" note="0 — breaking, 3 — evergreen">
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}>
              <option value={0}>P0</option><option value={1}>P1</option><option value={2}>P2</option><option value={3}>P3</option>
            </select>
          </Field>
          <Field label="Язык"><input value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} /></Field>
          <Field label="Минимальный балл (пусто = общий порог)"><input value={form.minimum_score} onChange={(e) => setForm({ ...form, minimum_score: e.target.value })} placeholder="65" /></Field>
          <Field label="Ключевые слова для fallback-поиска" note="через запятую; используются, если profile_posts недоступен"><input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="bitcoin, etf, eth" /></Field>
          <Field label=" "><Toggle checked={form.translate_images} onChange={(v) => setForm({ ...form, translate_images: v })} label="Переводить картинки" /></Field>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <Button tone="primary" busy={act.busy === "Добавить источник"} onClick={() => void add()}>Добавить</Button>
        </div>
        <ErrorBox text={act.error} />
        <Notice text={act.notice} />
      </Card>
      <Card title={`Источники (${data?.sources.length ?? 0})`}>
        <ErrorBox text={error} />
        {data && data.sources.length === 0 && <Empty title="Источников нет" text="Добавьте профиль зарубежного крипто-блогера или RSS-ленту." />}
        {data?.sources.map((s) => (
          <div key={s.id} className="item">
            <div className="item-head">
              <div>
                <span className="item-title">{s.name}</span> <Label value={s.type} /> <Badge title="приоритет">P{s.priority}</Badge> {s.translate_images && <Badge tone="accent">картинки</Badge>} {!s.enabled && <Badge tone="warn">выключен</Badge>}
                <div className="item-meta">
                  <span>{s.url ?? (s.username ? `@${s.username}` : "")}</span>
                  <span>проверка каждые {s.poll_minutes} мин</span>
                  <span>проверен {fmtDate(s.last_checked_at)}</span>
                  <span>последний пост {fmtDate(s.last_post_at)}</span>
                </div>
              </div>
              <div className="row">
                <Status value={s.last_status} />
                <Button size="sm" onClick={() => void act.run("Проверить", () => post(`/sources/${s.id}/check`), reload)}>Проверить сейчас</Button>
                <Button size="sm" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Скрыть посты" : "Последние посты"}</Button>
                <Button size="sm" onClick={() => void act.run(s.enabled ? "Выключить" : "Включить", () => patch(`/sources/${s.id}`, { enabled: !s.enabled }), reload)}>{s.enabled ? "Выключить" : "Включить"}</Button>
                <Button size="sm" tone="danger" onClick={() => { if (confirm(`Удалить источник ${s.name}?`)) void act.run("Удалить", () => del(`/sources/${s.id}`), reload); }}>Удалить</Button>
              </div>
            </div>
            {s.last_status === "PERMISSION_REQUIRED" && <div className="warn-box">API permission required — {s.last_error}</div>}
            {s.last_error && s.last_status !== "PERMISSION_REQUIRED" && <div className="error-box">{s.last_error}</div>}
            {open === s.id && (
              <div style={{ marginTop: 8 }}>
                {posts.error && <ErrorBox text={posts.error} />}
                {posts.data?.posts.length === 0 && <div className="muted small">Постов пока нет.</div>}
                {posts.data?.posts.map((p) => (
                  <div key={p.id} className="quote small" style={{ marginBottom: 6 }}>
                    <div className="row small"><Status value={p.status} /><span className="dim">@{p.author_username} · {fmtDate(p.published_at)}</span>{p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer">открыть</a>}</div>
                    {p.text.slice(0, 400)}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </Card>
    </>
  );
}
