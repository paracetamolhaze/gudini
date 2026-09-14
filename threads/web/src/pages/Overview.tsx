import { useFetch, fmtDate, fmtUsd } from "../hooks";
import { Badge, Card, ErrorBox, Stat, Button } from "../ui";
import type { OverviewData } from "../App";
import { LogList, type LogRow } from "./Logs";

export default function Overview({ data: o, error, navigate, reload }: { data: OverviewData | null; error: string; navigate: (p: string) => void; reload: () => void }) {
  const logs = useFetch<{ logs: LogRow[] }>("/logs?limit=12", { intervalMs: 15_000 });
  if (error && !o) return <ErrorBox text={error} />;
  if (!o) return <div className="muted">Загрузка…</div>;
  const ok = (v: boolean) => (v ? "success" : "error");
  const flagsOn = Object.entries(o.flags).filter(([, v]) => v).map(([k]) => k);
  return (
    <>
      <Card title="Автопилот" actions={<Button size="sm" onClick={reload}>Обновить</Button>}>
        <div className="grid grid-stats">
          <Stat label="Режим" value={o.mode} tone={o.killSwitch ? "error" : o.mode === "AUTO" ? "success" : "accent"} sub={o.killSwitch ? "остановлен kill switch" : o.dryRun ? "DRY_RUN — ничего не отправляется" : "боевой режим"} />
          <Stat label="Постов за 24 ч" value={o.today.posts} sub={o.lastPostAt ? `последний ${fmtDate(o.lastPostAt)}` : "ещё не публиковали"} />
          <Stat label="Ответов за 24 ч" value={o.today.own_replies} />
          <Stat label="Публичных ответов" value={o.today.public_replies} />
          <Stat label="Кандидатов найдено" value={o.today.candidates_found} sub={`отклонено ${o.today.candidates_rejected}`} />
          <Stat label="Черновики ждут" value={o.today.drafts_waiting} tone={o.today.drafts_waiting ? "warn" : undefined} />
          <Stat label="Запланировано" value={o.today.scheduled} />
          <Stat label="Ответы на проверку" value={o.today.needs_review} tone={o.today.needs_review ? "warn" : undefined} />
          <Stat label="Расход ИИ сегодня" value={fmtUsd(o.today.cost_today)} sub="оценка по тарифам" />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="muted small">Флаги:</span>
          {flagsOn.length ? flagsOn.map((f) => <Badge key={f} tone="success">{f}</Badge>) : <Badge>все автоматические функции выключены</Badge>}
          <Button size="sm" tone="ghost" onClick={() => navigate("settings")}>Настройки</Button>
        </div>
      </Card>
      <div className="grid grid-2">
        <Card title="Здоровье">
          <div className="stack">
            <div className="row row-between"><span>PostgreSQL</span><Badge tone={ok(o.health.db.ok)}>{o.health.db.message}</Badge></div>
            <div className="row row-between"><span>Redis</span><Badge tone={ok(o.health.redis.ok)}>{o.health.redis.message}</Badge></div>
            <div className="row row-between"><span>Threads API</span><Badge tone={ok(o.health.threads.ok)}>{o.health.threads.message}</Badge></div>
            <div className="row row-between"><span>LLM</span><Badge>{o.health.llmProvider}</Badge></div>
            {o.account?.tokenExpiresAt && <div className="row row-between"><span>Токен истекает</span><span className="muted">{fmtDate(o.account.tokenExpiresAt)}</span></div>}
            <div className="row row-between"><span>Источники</span><span className="muted">{o.sources ? `${o.sources.enabled}/${o.sources.total} включены, ошибок ${o.sources.errors}` : "—"}</span></div>
          </div>
        </Card>
        <Card title="Очереди">
          <table className="table">
            <thead><tr><th>Очередь</th><th>Ждут</th><th>В работе</th><th>Отложены</th><th>Ошибки</th></tr></thead>
            <tbody>
              {Object.entries(o.queues ?? {}).map(([name, c]) => (
                <tr key={name}><td>{name}</td><td>{c.waiting}</td><td>{c.active}</td><td>{c.delayed}</td><td className={c.failed ? "muted" : ""}>{c.failed}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <Card title="Последние действия" actions={<Button size="sm" tone="ghost" onClick={() => navigate("logs")}>Все логи</Button>}>
        <LogList logs={logs.data?.logs ?? []} navigate={navigate} />
      </Card>
    </>
  );
}
