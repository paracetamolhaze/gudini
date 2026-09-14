import { post } from "../api";
import { useAction, useFetch, fmtDate, fmtNum, fmtPct, fmtUsd } from "../hooks";
import { Badge, Button, Card, Empty, ErrorBox, Notice, Stat } from "../ui";

type Perf = { key: string; posts: number; views: number; engagementRate: number | null; repliesPerView: number | null; likesPerView: number | null };
type Report = { days: number; report: { totals: { posts: number; views: number; engagementRate: number | null; replies: number; likes: number }; byCategory: Perf[]; byType: Perf[]; byHour: Perf[]; byWeekday: Perf[]; bySource: Perf[]; byLength: Perf[]; byHookKind: Perf[] }; snapshots: { n: number; last: string | null } };
type Costs = { today: { cost: number; calls: number }; last7d: { cost: number; calls: number }; last30d: { cost: number; calls: number; inputTokens: number; outputTokens: number }; costPerPublishedPost: number | null; costPerReply: number | null; byOperation: Array<{ operation: string; model: string; cost: number | null; calls: number }> };
type Rec = { id: string; kind: string; title: string; body: string; status: string; created_at: string };

function PerfTable({ title, rows }: { title: string; rows: Perf[] }) {
  return (
    <Card title={title}>
      {rows.length === 0 ? <div className="muted small">нет данных</div> : (
        <table className="table">
          <thead><tr><th></th><th>Постов</th><th>Просм.</th><th>ER</th><th>Ответов/просм.</th><th>Лайков/просм.</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.key}><td>{r.key}</td><td>{r.posts}</td><td>{fmtNum(r.views)}</td><td>{fmtPct(r.engagementRate)}</td><td>{fmtPct(r.repliesPerView)}</td><td>{fmtPct(r.likesPerView)}</td></tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}

export default function Analytics() {
  const a = useFetch<Report>("/analytics?days=30");
  const c = useFetch<Costs>("/costs", { intervalMs: 30_000 });
  const r = useFetch<{ recommendations: Rec[] }>("/recommendations");
  const act = useAction();
  return (
    <>
      <Card title="Расход ИИ" actions={<Button size="sm" onClick={() => void act.run("Обновить метрики", () => post("/analytics/refresh"), () => { void a.reload(); void r.reload(); })}>Собрать метрики</Button>}>
        <ErrorBox text={c.error} /><ErrorBox text={act.error} /><Notice text={act.notice} />
        {c.data && (
          <div className="grid grid-stats">
            <Stat label="Сегодня" value={fmtUsd(c.data.today.cost)} sub={`${c.data.today.calls} вызовов`} />
            <Stat label="7 дней" value={fmtUsd(c.data.last7d.cost)} sub={`${c.data.last7d.calls} вызовов`} />
            <Stat label="30 дней" value={fmtUsd(c.data.last30d.cost)} sub={`${fmtNum(c.data.last30d.inputTokens)} in / ${fmtNum(c.data.last30d.outputTokens)} out токенов`} />
            <Stat label="На пост" value={fmtUsd(c.data.costPerPublishedPost)} />
            <Stat label="На ответ" value={fmtUsd(c.data.costPerReply)} />
          </div>
        )}
        {c.data?.byOperation.length ? (
          <details style={{ marginTop: 8 }}><summary>по операциям и моделям</summary>
            <table className="table"><thead><tr><th>Операция</th><th>Модель</th><th>Вызовов</th><th>Стоимость</th></tr></thead>
              <tbody>{c.data.byOperation.map((o, i) => <tr key={i}><td>{o.operation}</td><td className="mono">{o.model}</td><td>{o.calls}</td><td>{fmtUsd(o.cost)}</td></tr>)}</tbody></table>
          </details>
        ) : null}
      </Card>
      <Card title={`Публикации за ${a.data?.days ?? 30} дней`}>
        <ErrorBox text={a.error} />
        {a.data && (
          <>
            <div className="grid grid-stats">
              <Stat label="Постов" value={a.data.report.totals.posts} />
              <Stat label="Просмотров" value={fmtNum(a.data.report.totals.views)} />
              <Stat label="Engagement rate" value={fmtPct(a.data.report.totals.engagementRate)} />
              <Stat label="Ответов" value={a.data.report.totals.replies} />
              <Stat label="Лайков" value={a.data.report.totals.likes} />
            </div>
            <div className="dim small" style={{ marginTop: 6 }}>снимков метрик: {a.data.snapshots.n}, последний {fmtDate(a.data.snapshots.last)} (нужно threads_manage_insights)</div>
          </>
        )}
      </Card>
      {a.data && (
        <div className="grid grid-2">
          <PerfTable title="По категории" rows={a.data.report.byCategory} />
          <PerfTable title="По формату" rows={a.data.report.byType} />
          <PerfTable title="По часу" rows={a.data.report.byHour} />
          <PerfTable title="По дню недели" rows={a.data.report.byWeekday} />
          <PerfTable title="По источнику" rows={a.data.report.bySource} />
          <PerfTable title="По длине" rows={a.data.report.byLength} />
          <PerfTable title="По хуку" rows={a.data.report.byHookKind} />
        </div>
      )}
      <Card title="Рекомендации">
        <ErrorBox text={r.error} />
        {r.data && r.data.recommendations.length === 0 && <Empty title="Рекомендаций пока нет" text="Появятся, когда наберётся статистика по публикациям." />}
        {r.data?.recommendations.map((x) => (
          <div key={x.id} className="item">
            <div className="item-head">
              <div><span className="item-title">{x.title}</span> <Badge>{x.kind}</Badge> <Badge tone={x.status === "ACCEPTED" ? "success" : x.status === "REJECTED" ? "error" : "warn"}>{x.status}</Badge><div className="item-meta"><span>{fmtDate(x.created_at)}</span></div></div>
              {x.status === "PROPOSED" && <div className="row"><Button size="sm" onClick={() => void act.run("Принять", () => post(`/recommendations/${x.id}/accept`), r.reload)}>Принять</Button><Button size="sm" onClick={() => void act.run("Отклонить", () => post(`/recommendations/${x.id}/reject`), r.reload)}>Отклонить</Button></div>}
            </div>
            <div className="small">{x.body}</div>
          </div>
        ))}
      </Card>
    </>
  );
}
