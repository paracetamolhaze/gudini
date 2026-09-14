import { post } from "../api";
import { useAction, useFetch, fmtDate, fmtUsd } from "../hooks";
import { Badge, Button, Card, ErrorBox, Notice, Stat } from "../ui";
import type { OverviewData } from "../App";
import { LogList, type LogRow } from "./Logs";

export default function Overview({ data: o, error, navigate, reload }: { data: OverviewData | null; error: string; navigate: (p: string) => void; reload: () => void }) {
  const logs = useFetch<{ logs: LogRow[] }>("/logs?limit=6", { intervalMs: 15_000 });
  const act = useAction();
  if (error && !o) return <ErrorBox text={error} />;
  if (!o) return <div className="muted">Загрузка…</div>;

  const missing: Array<{ text: string; page: string }> = [];
  if (!o.health.threads.ok) missing.push({ text: "Нет токена Threads — впишите THREADS_ACCESS_TOKEN в threads/.env", page: "settings" });
  if (!o.readiness.llmKey) missing.push({ text: "Нет ключа ИИ — впишите OPENROUTER_API_KEY в threads/.env", page: "settings" });
  if ((o.sources?.enabled ?? 0) === 0) missing.push({ text: "Нет источников — добавьте блогера или RSS", page: "sources" });

  const status = o.killSwitch
    ? "Остановлено кнопкой. Ничего не публикуется."
    : o.mode === "OFF"
      ? "Выключено."
      : o.mode === "DRAFT"
        ? "Собирает источники и пишет черновики. Сама не публикует."
        : o.mode === "REVIEW"
          ? "Черновики и ответы ждут вашего одобрения."
          : "Публикует сама по порогам риска.";

  return (
    <>
      <Card>
        <div className="row" style={{ marginBottom: missing.length ? 10 : 0 }}>
          <span style={{ fontSize: 16 }}>{status}</span>
          {o.dryRun && !o.killSwitch && o.mode !== "OFF" && <Badge tone="warn">пробный режим: в Threads ничего не уходит</Badge>}
        </div>
        {missing.map((m) => (
          <div key={m.text} className="check check-bad">
            <span className="check-mark">✗</span>
            <span>
              {m.text} <a href="#" onClick={(e) => { e.preventDefault(); navigate(m.page); }}>открыть</a>
            </span>
          </div>
        ))}
        {missing.length === 0 && <div className="check check-ok"><span className="check-mark">✓</span><span>Всё настроено.</span></div>}
        <div className="row" style={{ marginTop: 10 }}>
          <Button size="sm" onClick={() => void act.run("Проверить источники", () => post("/sources/poll"), () => { reload(); void logs.reload(); })}>Проверить источники сейчас</Button>
        </div>
        <ErrorBox text={act.error} />
        <Notice text={act.notice} />
      </Card>

      <div className="grid grid-3">
        <div className="stat" style={{ cursor: "pointer" }} onClick={() => navigate("drafts")}>
          <div className="stat-value">{o.today.drafts_waiting}</div>
          <div className="stat-label">черновиков ждут решения</div>
        </div>
        <div className="stat" style={{ cursor: "pointer" }} onClick={() => navigate("replies")}>
          <div className="stat-value">{o.today.needs_review}</div>
          <div className="stat-label">ответов ждут решения</div>
        </div>
        <Stat label="постов за сутки" value={o.today.posts} sub={o.lastPostAt ? `последний ${fmtDate(o.lastPostAt)}` : undefined} />
      </div>

      <Card title="Последние действия" actions={<Button size="sm" tone="ghost" onClick={() => navigate("logs")}>Весь журнал</Button>}>
        <LogList logs={logs.data?.logs ?? []} navigate={navigate} compact />
      </Card>

      <details className="tech">
        <summary>Технические детали</summary>
        <div className="grid grid-2" style={{ marginTop: 10 }}>
          <Card title="Состояние">
            <div className="stack small">
              <div className="row row-between"><span>База данных</span><Badge tone={o.health.db.ok ? "success" : "error"}>{o.health.db.ok ? "ок" : o.health.db.message}</Badge></div>
              <div className="row row-between"><span>Очереди (Redis)</span><Badge tone={o.health.redis.ok ? "success" : "error"}>{o.health.redis.ok ? "ок" : o.health.redis.message}</Badge></div>
              <div className="row row-between"><span>Threads API</span><Badge tone={o.health.threads.ok ? "success" : "error"}>{o.health.threads.ok ? o.health.threads.message : "нет токена"}</Badge></div>
              <div className="row row-between"><span>Провайдер ИИ</span><Badge>{o.health.llmProvider}</Badge></div>
              <div className="row row-between"><span>Расход ИИ сегодня</span><span className="muted">{fmtUsd(o.today.cost_today)}</span></div>
              <div className="row row-between"><span>Последняя проверка источников</span><span className="muted">{fmtDate(o.readiness.lastSourceCheckAt)}</span></div>
              <div className="row row-between"><span>Кандидатов за сутки</span><span className="muted">{o.today.candidates_found} (отклонено {o.today.candidates_rejected})</span></div>
            </div>
          </Card>
          <Card title="Очереди">
            <table className="table small">
              <thead><tr><th></th><th>ждут</th><th>в работе</th><th>ошибки</th></tr></thead>
              <tbody>
                {Object.entries(o.queues ?? {}).map(([name, c]) => (
                  <tr key={name}><td>{QUEUE_LABEL[name] ?? name}</td><td>{c.waiting + c.delayed}</td><td>{c.active}</td><td>{c.failed}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </details>
    </>
  );
}

const QUEUE_LABEL: Record<string, string> = {
  source: "источники",
  analysis: "анализ",
  content: "написание",
  media: "картинки",
  publisher: "публикация",
  replies: "ответы",
  engagement: "чужие посты",
  analytics: "аналитика",
};
