import { useState } from "react";
import { post } from "../api";
import { useAction, useFetch, fmtDate } from "../hooks";
import { Badge, Button, Card, Empty, ErrorBox, Notice, Score, Status } from "../ui";

export type Fact = { claim: string; type: string; certainty: string; status: string; evidence: string | null; isDynamic: boolean; value: number | null; unit: string | null };
export type Candidate = {
  id: string;
  status: string;
  topic: string | null;
  category: string | null;
  priority: string;
  relevance_score: number | null;
  freshness_score: number | null;
  virality_score: number | null;
  trust_score: number | null;
  uniqueness_score: number | null;
  risk_score: number | null;
  total_score: number | null;
  reject_reason: string | null;
  expires_at: string | null;
  created_at: string;
  analysis_json: { analysis: { summary: string; reason: string; suggestedAngle: string; eventKey: string; isBreaking: boolean; contentKind: string; entities: string[] }; scoring: { threshold: number }; sourcePosts: Array<{ author: string; text: string; permalink: string | null }>; model: string } | null;
  facts_json: { facts: Fact[]; summary: { verified: number; unverified: number; contradicted: number; dynamic: number } } | null;
  sourcePost: { author_username: string; text: string; permalink: string | null; media_json: Array<{ type: string; url: string }>; published_at: string | null } | null;
};

const STATUSES = ["", "APPROVED_FOR_GENERATION", "GENERATED", "REJECTED", "PUBLISHED", "EXPIRED", "FAILED", "GENERATING"];

export function FactList({ facts }: { facts: Fact[] }) {
  if (!facts.length) return <div className="muted small">Фактов с проверкой нет.</div>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      {facts.map((f, i) => (
        <div key={i} className="small row" style={{ alignItems: "flex-start" }}>
          <Status value={f.status} />
          <Badge>{f.certainty}</Badge>
          {f.isDynamic && <Badge tone="accent">динамич.</Badge>}
          <span>{f.claim}{f.evidence ? <span className="dim"> — {f.evidence}</span> : null}</span>
        </div>
      ))}
    </div>
  );
}

export default function Candidates({ navigate }: { navigate: (p: string) => void }) {
  const [status, setStatus] = useState("");
  const { data, error, reload } = useFetch<{ candidates: Candidate[] }>(`/candidates?limit=60${status ? `&status=${status}` : ""}`, { intervalMs: 20_000 });
  const act = useAction();
  return (
    <Card
      title="Кандидаты"
      actions={
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 240 }}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || "все статусы"}</option>)}
        </select>
      }
    >
      <ErrorBox text={error} />
      <ErrorBox text={act.error} />
      <Notice text={act.notice} />
      {data && data.candidates.length === 0 && <Empty title="Кандидатов нет" text="Источники ещё не принесли постов или всё отклонено анализатором." />}
      {data?.candidates.map((c) => {
        const a = c.analysis_json?.analysis;
        return (
          <div key={c.id} className="item">
            <div className="item-head">
              <div>
                <span className="item-title">{c.topic ?? "(без темы)"}</span> <Status value={c.status} /> <Badge>{c.category}</Badge> <Badge>{c.priority}</Badge> {a?.isBreaking && <Badge tone="error">breaking</Badge>}
                <div className="item-meta"><span>{fmtDate(c.created_at)}</span><span>истекает {fmtDate(c.expires_at)}</span>{c.analysis_json?.sourcePosts && c.analysis_json.sourcePosts.length > 1 && <span>{c.analysis_json.sourcePosts.length} источника события</span>}</div>
              </div>
              <div className="row">
                <Button size="sm" tone="primary" disabled={c.status === "EXPIRED"} onClick={() => void act.run("Генерация", () => post(`/candidates/${c.id}/generate`), reload)}>Generate</Button>
                <Button size="sm" onClick={() => void act.run("Отклонить", () => post(`/candidates/${c.id}/reject`), reload)}>Reject</Button>
                <Button size="sm" tone="danger" onClick={() => { if (confirm("Отключить источник этого кандидата?")) void act.run("Отключить источник", () => post(`/candidates/${c.id}/ignore-source`), reload); }}>Ignore source</Button>
              </div>
            </div>
            <div className="split">
              <div>
                <div className="dim small">Оригинал @{c.sourcePost?.author_username} {c.sourcePost?.permalink && <a href={c.sourcePost.permalink} target="_blank" rel="noreferrer">открыть</a>}</div>
                <div className="quote small">{c.sourcePost?.text.slice(0, 900)}</div>
                {c.sourcePost?.media_json?.filter((m) => m.type === "image").slice(0, 1).map((m) => <img key={m.url} src={m.url} className="thumb" style={{ marginTop: 6, maxHeight: 220 }} alt="" referrerPolicy="no-referrer" />)}
              </div>
              <div>
                <div className="dim small">Суть по-русски</div>
                <div className="pre">{a?.summary}</div>
                <div className="stack" style={{ gap: 3, marginTop: 8 }}>
                  <Score label="Итог" value={c.total_score} />
                  <Score label="Релевантность" value={c.relevance_score} />
                  <Score label="Свежесть" value={c.freshness_score} />
                  <Score label="Новизна" value={c.uniqueness_score} />
                  <Score label="Ценность" value={c.virality_score} />
                  <Score label="Риск" value={c.risk_score} />
                </div>
                <div className="small" style={{ marginTop: 8 }}>
                  <span className="dim">Решение ИИ: </span>{c.reject_reason ?? a?.reason}
                  {a?.suggestedAngle && <div><span className="dim">Угол: </span>{a.suggestedAngle}</div>}
                </div>
              </div>
            </div>
            {c.facts_json && (
              <details style={{ marginTop: 8 }}>
                <summary>Факты: подтверждено {c.facts_json.summary.verified}, без подтверждения {c.facts_json.summary.unverified}, противоречат {c.facts_json.summary.contradicted}</summary>
                <FactList facts={c.facts_json.facts} />
              </details>
            )}
            {c.status === "GENERATED" || c.status === "PUBLISHED" ? <div className="small" style={{ marginTop: 6 }}><a href="#" onClick={(e) => { e.preventDefault(); navigate("drafts"); }}>к черновикам</a></div> : null}
          </div>
        );
      })}
    </Card>
  );
}
