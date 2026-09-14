import { useFetch, fmtDate, fmtNum } from "../hooks";
import { Badge, Card, Empty, ErrorBox, Label } from "../ui";

type Pub = { id: string; permalink: string | null; threads_post_id: string; published_text: string; published_at: string; dry_run: boolean; topic: string | null; category: string | null; views: number | null; likes: number | null; replies: number | null; reposts: number | null; quotes: number | null; captured_at: string | null; meta_json: { type?: string; parts?: number } | null };

export default function Published() {
  const { data, error } = useFetch<{ publications: Pub[] }>("/published?limit=100", { intervalMs: 30_000 });
  return (
    <Card title="Опубликовано">
      <ErrorBox text={error} />
      {data && data.publications.length === 0 && <Empty title="Публикаций пока нет" />}
      {data && data.publications.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Когда</th><th>Пост</th><th>Просмотры</th><th>Лайки</th><th>Ответы</th><th>Репосты</th><th>Цитаты</th><th>ER</th></tr></thead>
            <tbody>
              {data.publications.map((p) => {
                const inter = (p.likes ?? 0) + (p.replies ?? 0) + (p.reposts ?? 0) + (p.quotes ?? 0);
                const er = p.views ? inter / p.views : null;
                return (
                  <tr key={p.id}>
                    <td className="small">{fmtDate(p.published_at)}{p.dry_run && <div><Badge tone="warn">DRY_RUN</Badge></div>}</td>
                    <td>
                      <div className="row small"><Badge>{p.category ?? "—"}</Badge><Label value={p.meta_json?.type ?? null} />{p.meta_json?.parts && p.meta_json.parts > 1 && <Badge>тред {p.meta_json.parts}</Badge>}{p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer">открыть</a>}</div>
                      <div className="clamp">{p.published_text}</div>
                    </td>
                    <td>{fmtNum(p.views)}</td><td>{fmtNum(p.likes)}</td><td>{fmtNum(p.replies)}</td><td>{fmtNum(p.reposts)}</td><td>{fmtNum(p.quotes)}</td>
                    <td>{er === null ? "—" : `${(er * 100).toFixed(1)}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
