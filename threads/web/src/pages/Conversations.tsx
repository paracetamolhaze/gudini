import { useState } from "react";
import { post } from "../api";
import { useAction, useFetch, fmtDate } from "../hooks";
import { Button, Card, Empty, ErrorBox, Notice, Status } from "../ui";
import { Icon, PlatformChip, type PlatformFilter, type PlatformId } from "../kit";

type Reply = { id: string; platform: PlatformId; delivery: "api" | "manual" | "quote"; target_username: string; target_text: string; target_permalink: string | null; our_text: string | null; status: string; reason: string | null; sent_at: string | null; created_at: string; permalink: string | null; parent_text?: string | null; manual_url: string | null };

const INTRO = {
  own: "Ответы на комментарии под вашими постами — от вашего лица, на языке собеседника. Спам и пустые реплики пропускаются.",
  public: "Чужие обсуждения крипты, куда есть что добавить по существу. В Threads ответ уходит сам. X запрещает ботам отвечать незнакомым авторам, поэтому там текст готовится, а отправляете его вы — одной кнопкой.",
};

export default function Conversations({ kind, navigate, platform, xMode }: { kind: "own" | "public"; navigate: (p: string) => void; platform: PlatformFilter; xMode?: string }) {
  const [filter, setFilter] = useState("");
  const result = useFetch<{ interactions: Reply[] }>(`/replies?type=${kind}&limit=100${filter ? `&status=${filter}` : ""}${platform ? `&platform=${platform}` : ""}`, { intervalMs: 10000 });
  const act = useAction();
  return (
    <>
      <p className="page-intro">{INTRO[kind]}{kind === "public" && xMode === "quote" ? " Сейчас для X включён режим цитат: комментарий выходит цитатой поста." : ""}</p>
      <div className="list-head">
        <div className="tabs">
          {[["", "Все"], ["DRAFT,NEEDS_REVIEW", "Ждут вас"], ["SENT", "Отправлены"], ["PENDING,APPROVED,SENDING", "Готовятся"], ["SKIPPED,FAILED", "Пропущены и ошибки"]].map(([v, label]) => (
            <button key={v} className={`btn ${filter === v ? "on" : "btn-ghost"}`} onClick={() => setFilter(v!)}>{label}</button>
          ))}
        </div>
        <Button busy={act.busy !== null} onClick={() => void act.run(kind === "own" ? "Проверяю комментарии" : "Ищу обсуждения", () => post(kind === "own" ? "/replies/poll" : "/discovery/run"), result.reload)}><Icon name="refresh" size={14} /> Проверить сейчас</Button>
      </div>
      <Notice text={act.notice} />
      <ErrorBox text={act.error || result.error} />
      {result.loading && !result.data && <p className="muted">Загружаю разговоры…</p>}
      {result.data?.interactions.length === 0 && <Empty title={kind === "own" ? "Пока нет комментариев" : "Пока нет найденных обсуждений"} text="Когда площадки подключены и автоматика включена, новые разговоры появятся здесь." />}
      {result.data?.interactions.map((r) => (
        <Card key={r.id}>
          <div className="row row-between">
            <div className="row">
              <PlatformChip id={r.platform} state="idle" />
              <strong>@{r.target_username}</strong>
              {r.target_permalink && <a className="small" href={r.target_permalink} target="_blank" rel="noreferrer">пост ↗</a>}
            </div>
            <Status value={r.status} />
          </div>
          {r.parent_text && (
            <details className="conversation-parent">
              <summary>Ваш пост</summary>
              <p>{r.parent_text}</p>
            </details>
          )}
          <blockquote className="conversation-quote">{r.target_text}</blockquote>
          {r.our_text && (
            <div className="conversation-answer">
              <span className="small dim">{r.status === "SENT" ? "Ваш ответ" : r.delivery === "quote" ? "Подготовленная цитата" : "Подготовленный ответ"}</span>
              <p>{r.our_text}</p>
            </div>
          )}
          <div className="row row-between">
            <span className="small muted">{r.reason || fmtDate(r.sent_at ?? r.created_at)}</span>
            <div className="row">
              {r.manual_url && (
                <>
                  <a className="btn btn-sm btn-primary" href={r.manual_url} target="_blank" rel="noreferrer"><Icon name="external" size={14} /> Открыть в X</a>
                  <button className="btn btn-sm" disabled={act.busy !== null} onClick={() => void act.run("Отмечено", () => post(`/replies/${r.id}/mark-sent`, {}), result.reload)}>Я отправил</button>
                </>
              )}
              {!r.manual_url && ["DRAFT", "NEEDS_REVIEW"].includes(r.status) && r.our_text && (
                <button className="btn btn-sm btn-primary" disabled={act.busy !== null} onClick={() => void act.run("Отправляю", () => post(`/replies/${r.id}/send`), result.reload)}>Отправить</button>
              )}
              {["DRAFT", "NEEDS_REVIEW", "PENDING", "FAILED"].includes(r.status) && (
                <button className="btn btn-sm btn-ghost" disabled={act.busy !== null} onClick={() => void act.run("Пропущено", () => post(`/replies/${r.id}/skip`, {}), result.reload)}>Пропустить</button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => navigate(`replies/${r.id}`)}>Подробнее</button>
            </div>
          </div>
          {r.permalink && <a className="small" href={r.permalink} target="_blank" rel="noreferrer">Открыть ответ ↗</a>}
        </Card>
      ))}
    </>
  );
}
