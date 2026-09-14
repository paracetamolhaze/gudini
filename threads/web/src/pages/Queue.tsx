import { useFetch, fmtDate } from "../hooks";
import { Badge, Card, Empty, ErrorBox, Status } from "../ui";

type Row = { id: string; text: string; status: string; priority: string; scheduled_at: string | null; error: string | null; slot: { kind: string; at?: string; reason?: string } };
type Data = { lastPublishedAt: string | null; postsToday: number; limits: { maxPostsPerDay: number; minimumMinutesBetweenPosts: number; preferredHours: number[]; timezone: string }; queue: Row[] };

export default function Queue({ navigate }: { navigate: (p: string) => void }) {
  const { data, error } = useFetch<Data>("/queue", { intervalMs: 15_000 });
  return (
    <Card title="Очередь публикации">
      <ErrorBox text={error} />
      {data && (
        <div className="row small muted" style={{ marginBottom: 10 }}>
          <span>сегодня {data.postsToday}/{data.limits.maxPostsPerDay}</span>
          <span>минимум {data.limits.minimumMinutesBetweenPosts} мин между постами</span>
          <span>часы {data.limits.preferredHours.join(", ")} ({data.limits.timezone})</span>
          <span>последний пост {fmtDate(data.lastPublishedAt)}</span>
        </div>
      )}
      {data && data.queue.length === 0 && <Empty title="Очередь пуста" text="Одобренные черновики появятся здесь со своим слотом." />}
      {data && data.queue.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Статус</th><th>Приоритет</th><th>Текст</th><th>Слот</th></tr></thead>
            <tbody>
              {data.queue.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => navigate(`drafts/${r.id}`)}>
                  <td><Status value={r.status} />{r.error && <div className="small" style={{ color: "var(--error)" }}>{r.error}</div>}</td>
                  <td><Badge>{r.priority}</Badge></td>
                  <td className="clamp">{r.text}</td>
                  <td className="small">{r.status === "SCHEDULED" && r.scheduled_at ? fmtDate(r.scheduled_at) : r.slot.kind === "now" ? "ближайший тик" : r.slot.kind === "at" ? `${fmtDate(r.slot.at)} · ${r.slot.reason}` : r.slot.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
