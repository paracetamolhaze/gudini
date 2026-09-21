import { useEffect, useRef, useState } from "react";
import { post, put } from "../api";
import { useFetch, useAction, fmtDate } from "../hooks";
import { Button, Card, Empty, ErrorBox, Notice, Status } from "../ui";

type Draft = { id: string; text: string; status: string; source_summary: string | null; source_urls_json: string[]; error: string | null; review_reason: string | null; scheduled_at: string | null; created_at: string };
export default function Posts({ id, navigate }: { id: string | null; navigate: (p: string) => void }) {
  const [topic, setTopic] = useState(() => { try { return localStorage.getItem("threads:topic") ?? ""; } catch { return ""; } });
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const items = useFetch<{ drafts: Draft[] }>(id ? null : `/drafts?limit=100${filter ? `&status=${filter}` : ""}`, { intervalMs: 5000 });
  const act = useAction();
  useEffect(() => { try { localStorage.setItem("threads:topic", topic); } catch {} }, [topic]);
  if (id) return <PostEditor key={id} id={id} navigate={navigate} />;
  async function create() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try { const r = await post<{ id: string }>("/drafts", { topic }); setTopic(""); navigate(`posts/${r.id}`); }
    catch (e) { setError((e as Error).message); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <>
    <Card><form onSubmit={e => { e.preventDefault(); void create(); }}>
      <label className="compose-label" htmlFor="topic">О чём написать?</label>
      <textarea id="topic" rows={4} maxLength={1500} minLength={5} required value={topic} onChange={e => setTopic(e.target.value)} placeholder="Например: почему рост активности в сети не всегда повышает цену токена" disabled={busy} />
      <div className="compose-actions"><Button type="submit" tone="primary" busy={busy}>Написать пост</Button><span className="muted small">Готовый текст можно поправить перед публикацией</span></div>
      <ErrorBox text={error} />
    </form></Card>
    <div className="row row-between section-head"><h2>Ваши посты</h2><Button busy={act.busy !== null} onClick={() => void act.run("Поиск тем запущен", () => post("/sources/poll"), items.reload)}>Найти темы про крипту</Button></div>
    <Notice text={act.notice} /><ErrorBox text={act.error} />
    <div className="tabs">{[["", "Все"], ["GENERATING,DRAFT,NEEDS_REVIEW,FAILED", "Черновики"], ["APPROVED,SCHEDULED,PUBLISHING", "Запланированы"], ["PUBLISHED", "Опубликованы"]].map(([value, label]) => <button key={value} className={`btn ${filter === value ? "on" : "btn-ghost"}`} onClick={() => setFilter(value!)}>{label}</button>)}</div>
    <ErrorBox text={items.error} />
    {items.loading && !items.data && <p className="muted">Загружаю посты…</p>}
    {items.data?.drafts.length === 0 && <Empty title="Здесь появятся ваши посты" text="Введите тему выше или найдите идеи из криптоновостей." />}
    <div className="post-list">{items.data?.drafts.map(d => <button className="post-row" key={d.id} onClick={() => navigate(`posts/${d.id}`)}><div className="row row-between"><Status value={d.status} /><span className="small dim">{fmtDate(d.scheduled_at ?? d.created_at)}</span></div><p>{d.text || d.source_summary}</p>{d.error && <span className="error-text">{d.error}</span>}</button>)}</div>
  </>;
}

function PostEditor({ id, navigate }: { id: string; navigate: (p: string) => void }) {
  const info = useFetch<{ draft: Draft; publication: { permalink: string | null; dry_run: boolean } | null }>(`/drafts/${id}`, { intervalMs: 4000 });
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [when, setWhen] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const act = useAction();
  const d = info.data?.draft;
  useEffect(() => { if (d && !dirty) setText(d.text); }, [d?.text, dirty]);
  const editable = d && ["DRAFT", "NEEDS_REVIEW", "FAILED"].includes(d.status);
  async function savedAction(action: string) {
    if (dirty) { await put(`/drafts/${id}`, { text }); setDirty(false); }
    if (action === "schedule") { if (!when || new Date(when) <= new Date()) throw new Error("Выберите время в будущем"); await post(`/drafts/${id}/schedule`, { scheduledAt: new Date(when).toISOString() }); }
    else if (action !== "save") await post(`/drafts/${id}/${action}`);
  }
  async function regenerate() {
    const result = await post<{ draftId?: string }>(`/drafts/${id}/regenerate`);
    if (!result.draftId) navigate("posts");
  }
  return <>
    <Button tone="ghost" onClick={() => navigate("posts")}>← Все посты</Button>
    <ErrorBox text={info.error} />
    {d && <Card><div className="row row-between"><h2>{d.source_summary?.slice(0, 100) || "Ваш пост"}</h2><Status value={d.status} /></div>
      {d.status === "GENERATING" ? <p className="generation-note" role="status">Пишу пост. Можно закрыть эту страницу — результат сохранится здесь.</p> : <><label className="sr-only" htmlFor="post-text">Текст поста</label><textarea id="post-text" className="post-editor" value={text} maxLength={500} readOnly={!editable} onChange={e => { setText(e.target.value); setDirty(true); }} /><div className="small dim">{text.length} / 500</div></>}
      <ErrorBox text={d.error ?? ""} />{d.review_reason && <p className="muted">{d.review_reason}</p>}
      {d.source_urls_json?.length > 0 && <details className="conversation-parent"><summary>Источники поста</summary>{d.source_urls_json.filter(url => /^https?:\/\//i.test(url)).map(url => <p key={url}><a href={url} target="_blank" rel="noreferrer">{new URL(url).hostname} ↗</a></p>)}</details>}
      <ErrorBox text={act.error} /><Notice text={act.notice} />
      {editable && <div className="compose-actions"><Button tone="primary" busy={act.busy !== null} disabled={!text.trim()} onClick={() => void act.run("Публикация запущена", () => savedAction("publish-now"), info.reload)}>Опубликовать</Button><Button disabled={!text.trim() || act.busy !== null} onClick={() => setScheduling(!scheduling)}>Запланировать</Button><Button disabled={!dirty || act.busy !== null} onClick={() => void act.run("Сохранено", () => savedAction("save"), info.reload)}>Сохранить</Button><Button disabled={dirty || act.busy !== null} onClick={() => void act.run("Пишу заново", regenerate, info.reload)}>Написать заново</Button></div>}
      {editable && scheduling && <div className="compose-actions"><label>Дата и время <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></label><Button busy={act.busy !== null} onClick={() => void act.run("Запланировано", () => savedAction("schedule"), info.reload)}>Назначить время</Button></div>}
      {d.scheduled_at && <p className="muted">Публикация: {fmtDate(d.scheduled_at)}</p>}
      {info.data?.publication?.dry_run && <p>Пробная публикация: в Threads не отправлялась.</p>}
      {info.data?.publication?.permalink && <a href={info.data.publication.permalink} target="_blank" rel="noreferrer">Открыть в Threads ↗</a>}
    </Card>}
  </>;
}
