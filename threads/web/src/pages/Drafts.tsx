import { useEffect, useState } from "react";
import { API, post, put } from "../api";
import { useAction, useFetch, fmtDate } from "../hooks";
import { Badge, Button, Card, Empty, ErrorBox, Notice, Score, Status } from "../ui";
import { FactList, type Candidate } from "./Candidates";

type Draft = {
  id: string;
  candidate_id: string | null;
  type: string;
  text: string;
  status: string;
  review_reason: string | null;
  scheduled_at: string | null;
  priority: string;
  confidence: number | null;
  risk_score: number | null;
  prompt_version: string | null;
  model: string | null;
  validation_json: { violations?: Array<{ code: string; message: string; severity: string }> } | null;
  variants_json: Array<{ type: string; text: string; confidence: number; score: number; violations: Array<{ message: string }> }> | null;
  image_asset_id: string | null;
  expires_at: string | null;
  error: string | null;
  created_at: string;
  candidate?: { topic: string | null; category: string | null; total_score: number | null } | null;
  asset?: { id: string; status: string } | null;
};

type Asset = { id: string; status: string; original_url: string; local_path: string | null; final_path: string | null; qa_json: { issues: string[] } | null; error: string | null; translation_json: Array<{ from: string; to: string }> | null };

type Detail = { draft: Draft; candidate: Candidate | null; sourcePost: { author_username: string; text: string; permalink: string | null; media_json: Array<{ type: string; url: string }> } | null; assets: Asset[]; publication: { permalink: string | null; threads_post_id: string; dry_run: boolean } | null; attempts: Array<{ status: string; error: string | null; created_at: string }> };

const STATUSES = ["", "DRAFT", "NEEDS_REVIEW", "APPROVED", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED", "REJECTED", "EXPIRED"];

export default function Drafts({ id, navigate }: { id: string | null; navigate: (p: string) => void }) {
  if (id) return <DraftDetail id={id} navigate={navigate} />;
  return <DraftList navigate={navigate} />;
}

function DraftList({ navigate }: { navigate: (p: string) => void }) {
  const [status, setStatus] = useState("DRAFT,NEEDS_REVIEW");
  const { data, error } = useFetch<{ drafts: Draft[] }>(`/drafts?limit=80${status ? `&status=${status}` : ""}`, { intervalMs: 15_000 });
  return (
    <Card
      title="Черновики"
      actions={
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 220 }}>
          <option value="DRAFT,NEEDS_REVIEW">ждут решения</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s || "все"}</option>)}
        </select>
      }
    >
      <ErrorBox text={error} />
      {data && data.drafts.length === 0 && <Empty title="Черновиков нет" text="Как только анализатор одобрит кандидата, writer положит сюда пост." />}
      {data?.drafts.map((d) => (
        <div key={d.id} className="item" style={{ cursor: "pointer" }} onClick={() => navigate(`drafts/${d.id}`)}>
          <div className="item-head">
            <div>
              <span className="item-title">{d.candidate?.topic ?? d.text.slice(0, 60)}</span> <Status value={d.status} /> <Badge>{d.type}</Badge> <Badge>{d.priority}</Badge> {d.asset && <Badge tone={d.asset.status === "QA_PASSED" ? "success" : "warn"}>картинка: {d.asset.status}</Badge>}
              <div className="item-meta"><span>{fmtDate(d.created_at)}</span><span>уверенность {d.confidence ?? "—"}</span><span>риск {d.risk_score ?? "—"}</span>{d.scheduled_at && <span>слот {fmtDate(d.scheduled_at)}</span>}</div>
            </div>
          </div>
          <div className="clamp muted">{d.text}</div>
          {d.review_reason && <div className="small" style={{ color: "var(--warn)", marginTop: 4 }}>{d.review_reason}</div>}
        </div>
      ))}
    </Card>
  );
}

function DraftDetail({ id, navigate }: { id: string; navigate: (p: string) => void }) {
  const { data, error, reload } = useFetch<Detail>(`/drafts/${id}`, { intervalMs: 10_000 });
  const act = useAction();
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  useEffect(() => {
    if (data?.draft) setText(data.draft.text);
  }, [data?.draft.text, data?.draft]);
  if (error && !data) return <ErrorBox text={error} />;
  if (!data) return <div className="muted">Загрузка…</div>;
  const { draft: d, candidate: c, sourcePost: sp } = data;
  const facts = c?.facts_json?.facts ?? [];
  const a = c?.analysis_json?.analysis;
  const asset = data.assets.find((x) => x.id === d.image_asset_id) ?? data.assets[0] ?? null;
  const editable = !["PUBLISHING", "PUBLISHED"].includes(d.status);
  const dirty = text !== d.text;
  const run = (label: string, fn: () => Promise<unknown>) => void act.run(label, fn, reload);
  return (
    <>
      <div className="row row-between" style={{ marginBottom: 10 }}>
        <div className="row">
          <Button size="sm" tone="ghost" onClick={() => navigate("drafts")}>← к списку</Button>
          <Status value={d.status} /> <Badge>{d.type}</Badge> <Badge>{d.priority}</Badge> {c && <Badge>{c.category}</Badge>}
          <span className="dim small">{d.prompt_version} · {d.model}</span>
        </div>
        <div className="row">
          {editable && <Button tone="primary" disabled={!dirty} busy={act.busy === "Сохранить"} onClick={() => run("Сохранить", () => put(`/drafts/${id}`, { text }))}>Сохранить правку</Button>}
          {editable && <Button onClick={() => run("Одобрить", () => post(`/drafts/${id}/approve`))}>Approve</Button>}
          {editable && <Button onClick={() => run("Перегенерировать", () => post(`/drafts/${id}/regenerate`))}>Regenerate</Button>}
          {editable && <Button tone="primary" onClick={() => { if (confirm("Опубликовать в Threads прямо сейчас?")) run("Опубликовать", () => post(`/drafts/${id}/publish-now`)); }}>Publish now</Button>}
          {editable && <Button tone="danger" onClick={() => run("Отклонить", () => post(`/drafts/${id}/reject`))}>Reject</Button>}
        </div>
      </div>
      <ErrorBox text={act.error} />
      <Notice text={act.notice} />
      {d.review_reason && <div className="warn-box">Требует внимания: {d.review_reason}</div>}
      {d.error && <div className="error-box">{d.error}</div>}
      {data.publication && <div className="notice-box">Опубликовано{data.publication.dry_run ? " (DRY_RUN)" : ""}: {data.publication.permalink ? <a href={data.publication.permalink} target="_blank" rel="noreferrer">{data.publication.permalink}</a> : data.publication.threads_post_id}</div>}
      <div className="split">
        <Card title={`Оригинал · @${sp?.author_username ?? "—"}`}>
          {sp?.permalink && <div className="small"><a href={sp.permalink} target="_blank" rel="noreferrer">открыть в Threads</a></div>}
          <div className="quote">{sp?.text}</div>
          {c?.analysis_json?.sourcePosts.filter((s) => s.text !== sp?.text).map((s, i) => (
            <div key={i} className="quote small" style={{ marginTop: 6 }}><span className="dim">@{s.author}</span><br />{s.text.slice(0, 600)}</div>
          ))}
          {asset?.local_path ? <img src={`${API}/media/${asset.id}/original`} className="thumb" style={{ marginTop: 8 }} alt="original" /> : sp?.media_json?.filter((m) => m.type === "image").slice(0, 1).map((m) => <img key={m.url} src={m.url} className="thumb" style={{ marginTop: 8 }} alt="" referrerPolicy="no-referrer" />)}
          {a && (
            <div className="small" style={{ marginTop: 8 }}>
              <div><span className="dim">Событие: </span>{a.eventKey}</div>
              <div><span className="dim">Суть: </span>{a.summary}</div>
              <div><span className="dim">Угол: </span>{a.suggestedAngle}</div>
            </div>
          )}
        </Card>
        <Card title="Наш пост">
          {editable ? <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 220, fontSize: 15 }} /> : <div className="ours">{d.text}</div>}
          <div className="row small" style={{ marginTop: 6 }}><span className="dim">{text.length} символов</span>{text.length > 500 && <Badge tone="accent">уйдёт тредом</Badge>}</div>
          <div className="stack" style={{ gap: 3, marginTop: 10 }}>
            <Score label="Уверенность" value={d.confidence} />
            <Score label="Риск" value={d.risk_score} />
            <Score label="Балл кандидата" value={c?.total_score} />
          </div>
          {d.validation_json?.violations?.length ? (
            <div className="small" style={{ marginTop: 8 }}>
              <div className="dim">Валидация:</div>
              {d.validation_json.violations.map((v, i) => <div key={i} style={{ color: v.severity === "block" ? "var(--error)" : "var(--warn)" }}>{v.code}: {v.message}</div>)}
            </div>
          ) : <div className="small" style={{ color: "var(--success)", marginTop: 8 }}>Валидация чисел и фраз пройдена</div>}
          <div className="row" style={{ marginTop: 10 }}>
            <Button size="sm" onClick={() => run("LIKE", () => post(`/drafts/${id}/feedback`, { rating: "LIKE" }))}>👍 Like</Button>
            <Button size="sm" onClick={() => run("DISLIKE", () => post(`/drafts/${id}/feedback`, { rating: "DISLIKE" }))}>👎 Dislike</Button>
            {editable && (
              <>
                <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} style={{ width: 210 }} />
                <Button size="sm" disabled={!when} onClick={() => run("Запланировать", () => post(`/drafts/${id}/schedule`, { scheduledAt: new Date(when).toISOString() }))}>Schedule</Button>
              </>
            )}
          </div>
          {asset && (
            <div style={{ marginTop: 12 }}>
              <div className="row small"><span className="dim">Картинка:</span><Status value={asset.status} />
                {asset.status !== "QA_PASSED" && asset.final_path && <Button size="sm" onClick={() => run("Одобрить картинку", () => post(`/media/${asset.id}/approve`))}>Одобрить</Button>}
                <Button size="sm" onClick={() => run("Повторить перевод", () => post(`/media/${asset.id}/retry`))}>Повторить</Button>
                <Button size="sm" tone="danger" onClick={() => run("Убрать картинку", () => post(`/drafts/${id}/image/remove`))}>Убрать</Button>
              </div>
              {asset.final_path && <img src={`${API}/media/${asset.id}/final`} className="thumb" style={{ marginTop: 6 }} alt="final" />}
              {asset.qa_json?.issues?.length ? <div className="small" style={{ color: "var(--warn)" }}>QA: {asset.qa_json.issues.join("; ")}</div> : null}
              {asset.error && !asset.qa_json?.issues?.length && <div className="small" style={{ color: "var(--error)" }}>{asset.error}</div>}
            </div>
          )}
          {!asset && sp?.media_json?.some((m) => m.type === "image") && editable && (
            <div style={{ marginTop: 10 }}><Button size="sm" onClick={() => run("Перевести картинку", () => post(`/drafts/${id}/image/translate`))}>Перевести картинку источника</Button></div>
          )}
        </Card>
      </div>
      <div className="split">
        <Card title="Факты">
          <FactList facts={facts} />
        </Card>
        <Card title="Варианты и попытки">
          {d.variants_json?.map((v, i) => (
            <details key={i} style={{ marginBottom: 6 }}>
              <summary>{v.type} · уверенность {v.confidence} · балл {Math.round(v.score)}{v.violations.length ? ` · ${v.violations.length} замечаний` : ""}</summary>
              <div className="quote small">{v.text}</div>
            </details>
          ))}
          {data.attempts.length > 0 && (
            <div className="small" style={{ marginTop: 8 }}>
              <div className="dim">Попытки публикации:</div>
              {data.attempts.map((x, i) => <div key={i}><Status value={x.status} /> <span className="dim">{fmtDate(x.created_at)}</span> {x.error}</div>)}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
