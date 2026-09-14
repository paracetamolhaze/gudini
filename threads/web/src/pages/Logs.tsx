import { useState } from "react";
import { useFetch, fmtDate } from "../hooks";
import { Button, Card, Empty, ErrorBox } from "../ui";

export type LogRow = {
  id: number;
  at: string;
  event: string;
  level: "info" | "warn" | "error";
  message: string;
  details: unknown;
  candidate_id: string | null;
  draft_id: string | null;
  interaction_id: string | null;
  source_id: string | null;
  publication_id: string | null;
};

export function LogList({ logs, navigate, compact = false }: { logs: LogRow[]; navigate?: (p: string) => void; compact?: boolean }) {
  if (!logs.length) return <Empty title="Пока пусто" text="Здесь появятся действия системы с объяснениями." />;
  return (
    <div>
      {logs.map((l) => {
        const firstLine = l.message.split("\n")[0] ?? l.message;
        return (
          <div key={l.id} className={`log log-${l.level}`}>
            <div className="log-time">
              {fmtDate(l.at)}
              {!compact && (
                <>
                  <br />
                  <span className="dim">{l.event}</span>
                </>
              )}
            </div>
            <div>
              <div className="log-msg">{compact ? firstLine.slice(0, 160) : l.message}</div>
              {!compact && (
                <div className="row small" style={{ marginTop: 4 }}>
                  {l.draft_id && navigate && <a href="#" onClick={(e) => { e.preventDefault(); navigate(`drafts/${l.draft_id}`); }}>черновик</a>}
                  {l.interaction_id && navigate && <a href="#" onClick={(e) => { e.preventDefault(); navigate(`replies/${l.interaction_id}`); }}>ответ</a>}
                  {l.details != null && (
                    <details>
                      <summary>детали</summary>
                      <pre className="json">{JSON.stringify(l.details, null, 2)}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const EVENTS = ["", "SOURCE_CHECKED", "SOURCE_DISCOVERED", "SOURCE_DUPLICATE", "SOURCE_ERROR", "EVENT_CLUSTERED", "CANDIDATE_ANALYZED", "CANDIDATE_REJECTED", "FACT_CHECKED", "FACT_CHECK_FAILED", "POST_GENERATED", "POST_NEEDS_REVIEW", "POST_VALIDATION_FAILED", "POST_APPROVED", "POST_SCHEDULED", "POST_PUBLISHED", "POST_PUBLISH_FAILED", "FRESHNESS_RECHECK", "IMAGE_TRANSLATED", "IMAGE_QA_FAILED", "IMAGE_FAILED", "REPLY_FOUND", "REPLY_SKIPPED", "REPLY_GENERATED", "REPLY_NEEDS_REVIEW", "REPLY_PUBLISHED", "REPLY_FAILED", "ENGAGEMENT_FOUND", "ENGAGEMENT_SKIPPED", "ENGAGEMENT_GENERATED", "ENGAGEMENT_PUBLISHED", "LIMIT_REACHED", "KILL_SWITCH", "MODE_CHANGED", "SETTINGS_CHANGED", "DRY_RUN", "INSIGHTS_CAPTURED", "RECOMMENDATION", "JOB_FAILED"];

export default function Logs() {
  const [event, setEvent] = useState("");
  const [level, setLevel] = useState("");
  const [search, setSearch] = useState("");
  const [before, setBefore] = useState<number | null>(null);
  const qs = new URLSearchParams({ limit: "100" });
  if (event) qs.set("event", event);
  if (level) qs.set("level", level);
  if (search) qs.set("search", search);
  if (before) qs.set("before", String(before));
  const { data, error, loading } = useFetch<{ logs: LogRow[] }>(`/logs?${qs}`, { intervalMs: before ? undefined : 10_000 });
  const logs = data?.logs ?? [];
  return (
    <Card
      title="Журнал действий"
      actions={
        <>
          <select value={event} onChange={(e) => { setEvent(e.target.value); setBefore(null); }} style={{ width: 220 }}>
            {EVENTS.map((e) => <option key={e} value={e}>{e || "все события"}</option>)}
          </select>
          <select value={level} onChange={(e) => { setLevel(e.target.value); setBefore(null); }} style={{ width: 120 }}>
            <option value="">все уровни</option><option value="info">info</option><option value="warn">warn</option><option value="error">error</option>
          </select>
          <input placeholder="поиск по тексту" value={search} onChange={(e) => { setSearch(e.target.value); setBefore(null); }} style={{ width: 200 }} />
        </>
      }
    >
      <ErrorBox text={error} />
      {loading && !data ? <div className="muted">Загрузка…</div> : <LogList logs={logs} />}
      <div className="row" style={{ marginTop: 10 }}>
        {before && <Button size="sm" onClick={() => setBefore(null)}>К началу</Button>}
        {logs.length >= 100 && <Button size="sm" onClick={() => setBefore(logs[logs.length - 1]!.id)}>Старше</Button>}
      </div>
    </Card>
  );
}
