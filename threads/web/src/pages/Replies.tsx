import { useEffect, useState } from "react";
import { post, put } from "../api";
import { useAction, useFetch, fmtDate } from "../hooks";
import { Badge, Button, Card, Empty, ErrorBox, Label, Notice, Status } from "../ui";

type Interaction = { id: string; type: string; status: string; target_username: string; target_text: string; target_permalink: string | null; target_published_at: string | null; our_text: string | null; decision: string | null; reason: string | null; decision_json: { confidence?: number; sentiment?: string; toxicityScore?: number; scores?: { total: number }; angle?: string } | null; permalink: string | null; error: string | null; created_at: string; sent_at: string | null };
type Detail = { interaction: Interaction; chain: Array<{ username: string; text: string; is_ours: boolean }>; publication: { published_text: string; permalink: string | null } | null; discovered: { text: string; scores_json: unknown } | null };

export default function Replies({ id, navigate }: { id: string | null; navigate: (p: string) => void }) {
  if (id) return <ReplyDetail id={id} navigate={navigate} />;
  return <ReplyList navigate={navigate} />;
}

function ReplyList({ navigate }: { navigate: (p: string) => void }) {
  const [tab, setTab] = useState<"own" | "public">("own");
  const [status, setStatus] = useState("DRAFT,NEEDS_REVIEW,PENDING,APPROVED");
  const { data, error, reload } = useFetch<{ interactions: Interaction[] }>(`/replies?type=${tab}&limit=100${status ? `&status=${status}` : ""}`, { intervalMs: 15_000 });
  const act = useAction();
  return (
    <Card
      title={tab === "own" ? "Комментарии под нашими постами и упоминания" : "Ответы на чужие посты"}
      actions={
        <>
          <Button size="sm" onClick={() => void act.run("Проверить комментарии", () => post("/replies/poll"), reload)}>Проверить сейчас</Button>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 200 }}>
            <option value="DRAFT,NEEDS_REVIEW,PENDING,APPROVED">ждут решения</option>
            <option value="">все</option>
            {["SENT", "SKIPPED", "FAILED", "NEEDS_REVIEW", "DRAFT"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </>
      }
    >
      <div className="tabs">
        <button className={`btn btn-sm ${tab === "own" ? "on" : ""}`} onClick={() => setTab("own")}>Наши посты</button>
        <button className={`btn btn-sm ${tab === "public" ? "on" : ""}`} onClick={() => setTab("public")}>Публичные</button>
      </div>
      <ErrorBox text={error} />
      <ErrorBox text={act.error} />
      <Notice text={act.notice} />
      {data && data.interactions.length === 0 && <Empty title="Ничего не ждёт" text="Новые комментарии появятся после ближайшей проверки." />}
      {data?.interactions.map((r) => (
        <div key={r.id} className="item" style={{ cursor: "pointer" }} onClick={() => navigate(`replies/${r.id}`)}>
          <div className="item-head">
            <div><span className="item-title">@{r.target_username}</span> <Status value={r.status} /> <Label value={r.type} /> {r.decision && <Label value={r.decision} tone={r.decision === "SKIP" ? "neutral" : "accent"} />}
              <div className="item-meta"><span>{fmtDate(r.target_published_at ?? r.created_at)}</span>{r.decision_json?.confidence !== undefined && <span>уверенность {r.decision_json.confidence}</span>}{r.decision_json?.scores && <span>балл {r.decision_json.scores.total}</span>}</div>
            </div>
          </div>
          <div className="quote small clamp">{r.target_text}</div>
          {r.our_text && <div className="ours" style={{ marginTop: 6, fontSize: 14 }}>{r.our_text}</div>}
          {r.reason && <div className="small dim" style={{ marginTop: 4 }}>{r.reason}</div>}
        </div>
      ))}
    </Card>
  );
}

function ReplyDetail({ id, navigate }: { id: string; navigate: (p: string) => void }) {
  const { data, error, reload } = useFetch<Detail>(`/replies/${id}`, { intervalMs: 10_000 });
  const act = useAction();
  const [text, setText] = useState("");
  useEffect(() => {
    if (data) setText(data.interaction.our_text ?? "");
  }, [data?.interaction.id, data?.interaction.our_text]);
  if (error && !data) return <ErrorBox text={error} />;
  if (!data) return <div className="muted">Загрузка…</div>;
  const r = data.interaction;
  const editable = !["SENDING", "SENT"].includes(r.status);
  const run = (label: string, fn: () => Promise<unknown>) => void act.run(label, fn, reload);
  return (
    <>
      <div className="row row-between" style={{ marginBottom: 10 }}>
        <div className="row"><Button size="sm" tone="ghost" onClick={() => navigate("replies")}>← к списку</Button><Status value={r.status} /><Label value={r.type} />{r.decision && <Label value={r.decision} tone="accent" />}</div>
        <div className="row">
          {editable && <Button tone="primary" disabled={text === (r.our_text ?? "")} onClick={() => run("Сохранить", () => put(`/replies/${id}`, { text }))}>Сохранить</Button>}
          {editable && <Button tone="primary" busy={act.busy !== null} disabled={!text.trim()} onClick={() => run("Отправить", async () => { if (text !== r.our_text) await put(`/replies/${id}`, { text }); return post(`/replies/${id}/send`); })}>Отправить</Button>}
          {editable && <Button onClick={() => run("Перегенерировать", () => post(`/replies/${id}/regenerate`))}>Написать заново</Button>}
          {editable && <Button tone="danger" onClick={() => run("Пропустить", () => post(`/replies/${id}/skip`))}>Пропустить</Button>}
        </div>
      </div>
      <ErrorBox text={act.error} />
      <Notice text={act.notice} />
      {r.error && <div className="error-box">{r.error}</div>}
      {r.permalink && <div className="notice-box">Отправлено: <a href={r.permalink} target="_blank" rel="noreferrer">{r.permalink}</a></div>}
      <div className="split">
        <Card title={data.publication ? "Наш пост" : data.discovered ? "Чужой пост" : "Контекст"}>
          {data.publication && <div className="ours" style={{ fontSize: 14 }}>{data.publication.published_text}</div>}
          {data.publication?.permalink && <div className="small"><a href={data.publication.permalink} target="_blank" rel="noreferrer">открыть в Threads</a></div>}
          {data.chain.length > 0 && (
            <div className="chain" style={{ marginTop: 10 }}>
              {data.chain.map((m, i) => <div key={i} className={`msg ${m.is_ours ? "ours" : ""}`}><span className="who">{m.is_ours ? "мы" : `@${m.username}`}</span>{m.text}</div>)}
            </div>
          )}
          <div className="quote" style={{ marginTop: 10 }}><span className="dim small">@{r.target_username} · {fmtDate(r.target_published_at)}</span><br />{r.target_text}</div>
          {r.target_permalink && <div className="small"><a href={r.target_permalink} target="_blank" rel="noreferrer">открыть комментарий</a></div>}
        </Card>
        <Card title="Предложенный ответ">
          {editable ? <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 140 }} /> : <div className="ours">{r.our_text}</div>}
          <div className="small" style={{ marginTop: 8 }}>
            <div><span className="dim">Почему: </span>{r.reason ?? "—"}</div>
            {r.decision_json?.sentiment && <div><span className="dim">Тон: </span>{r.decision_json.sentiment}, токсичность {r.decision_json.toxicityScore}</div>}
            {r.decision_json?.confidence !== undefined && <div><span className="dim">Уверенность решения: </span>{r.decision_json.confidence}</div>}
            {r.decision_json?.angle && <div><span className="dim">Что добавляем: </span>{r.decision_json.angle}</div>}
          </div>
        </Card>
      </div>
    </>
  );
}
