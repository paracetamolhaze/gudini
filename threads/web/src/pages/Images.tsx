import { API, post } from "../api";
import { useAction, useFetch, fmtDate } from "../hooks";
import { Button, Card, Empty, ErrorBox, Notice, Status } from "../ui";

type Asset = { id: string; draft_id: string | null; status: string; original_url: string; local_path: string | null; final_path: string | null; qa_json: { issues: string[] } | null; error: string | null; attempts: number; created_at: string; translation_json: Array<{ from: string; to: string }> | null };

export default function Images({ navigate }: { navigate: (p: string) => void }) {
  const { data, error, reload } = useFetch<{ assets: Asset[] }>("/media", { intervalMs: 20_000 });
  const act = useAction();
  return (
    <Card title="Картинки">
      <ErrorBox text={error} />
      <ErrorBox text={act.error} />
      <Notice text={act.notice} />
      {data && data.assets.length === 0 && <Empty title="Переводов картинок пока нет" text="Включите IMAGE_TRANSLATION_ENABLED и «Переводить картинки» у источника." />}
      {data?.assets.map((a) => (
        <div key={a.id} className="item">
          <div className="item-head">
            <div><Status value={a.status} /> <span className="dim small">{fmtDate(a.created_at)} · попыток {a.attempts}</span></div>
            <div className="row">
              {a.draft_id && <Button size="sm" onClick={() => navigate(`drafts/${a.draft_id}`)}>Черновик</Button>}
              {a.final_path && a.status !== "QA_PASSED" && <Button size="sm" onClick={() => void act.run("Одобрить", () => post(`/media/${a.id}/approve`), reload)}>Одобрить</Button>}
              {a.draft_id && <Button size="sm" onClick={() => void act.run("Повторить", () => post(`/media/${a.id}/retry`), reload)}>Повторить</Button>}
            </div>
          </div>
          <div className="split">
            <div>{a.local_path ? <img src={`${API}/media/${a.id}/original`} className="thumb" alt="before" /> : <a href={a.original_url} target="_blank" rel="noreferrer" className="small">оригинал</a>}</div>
            <div>{a.final_path ? <img src={`${API}/media/${a.id}/final`} className="thumb" alt="after" /> : <div className="muted small">итоговой картинки нет</div>}</div>
          </div>
          {a.translation_json?.length ? <details style={{ marginTop: 6 }}><summary>перевод блоков</summary>{a.translation_json.map((t, i) => <div key={i} className="small">{t.from} → <b>{t.to}</b></div>)}</details> : null}
          {a.qa_json?.issues?.length ? <div className="small" style={{ color: "var(--warn)", marginTop: 4 }}>QA: {a.qa_json.issues.join("; ")}</div> : null}
          {a.error && !a.qa_json?.issues?.length && <div className="small" style={{ color: "var(--error)" }}>{a.error}</div>}
        </div>
      ))}
    </Card>
  );
}
