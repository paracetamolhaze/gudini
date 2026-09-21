import { useState } from "react";
import { useFetch, fmtDate } from "../hooks";
import { Card, Empty, ErrorBox, Status } from "../ui";
type Reply = { id: string; target_username: string; target_text: string; our_text: string | null; status: string; reason: string | null; sent_at: string | null; created_at: string; permalink: string | null; parent_text?: string | null };
export default function Conversations({ kind, navigate }: { kind: "own" | "public"; navigate: (p: string) => void }) {
  const [filter, setFilter] = useState("");
  const result = useFetch<{ interactions: Reply[] }>(`/replies?type=${kind}&limit=100${filter ? `&status=${filter}` : ""}`, { intervalMs: 10000 });
  return <><p className="page-intro">{kind === "own" ? "Гудини отвечает на содержательные вопросы под вашими постами. Учитывает контекст разговора и пропускает спам." : "Гудини находит обсуждения крипты и добавляет полезное мнение. До 6 комментариев в сутки, с паузами и без повторов одному автору."}</p>
    <div className="tabs">{[["", "Все"], ["SENT", "Отправлены"], ["PENDING,APPROVED,SENDING,DRAFT,NEEDS_REVIEW", "Готовятся"], ["SKIPPED,FAILED", "Пропущены и ошибки"]].map(([v, label]) => <button key={v} className={`btn ${filter === v ? "on" : "btn-ghost"}`} onClick={() => setFilter(v!)}>{label}</button>)}</div>
    <ErrorBox text={result.error} />
    {result.loading && !result.data && <p className="muted">Загружаю разговоры…</p>}
    {result.data?.interactions.length === 0 && <Empty title={kind === "own" ? "Пока нет ответов" : "Пока нет комментариев"} text="Когда аккаунт подключён и автоматика включена, новые разговоры появятся здесь. Отвечать на каждую реплику не нужно." />}
    {result.data?.interactions.map(r => <Card key={r.id}><div className="row row-between"><strong>@{r.target_username}</strong><Status value={r.status} /></div>{r.parent_text && <details className="conversation-parent"><summary>Ваш пост</summary><p>{r.parent_text}</p></details>}<blockquote className="conversation-quote">{r.target_text}</blockquote>{r.our_text && <div className="conversation-answer"><span className="small dim">{r.status === "SENT" ? "Ответ Гудини" : "Подготовленный ответ"}</span><p>{r.our_text}</p></div>}<div className="row row-between"><span className="small muted">{r.reason || fmtDate(r.sent_at ?? r.created_at)}</span><button className="btn btn-ghost btn-sm" onClick={() => navigate(`replies/${r.id}`)}>Подробнее</button></div>{r.permalink && <a href={r.permalink} target="_blank" rel="noreferrer">Открыть в Threads ↗</a>}</Card>)}
  </>;
}
