import { post } from "../api";
import { useAction, useFetch, fmtDate, fmtUsd } from "../hooks";
import { Badge, Button, Card, Check, ErrorBox, Notice, Stat, MODE_LABEL } from "../ui";
import type { OverviewData } from "../App";
import { LogList, type LogRow } from "./Logs";

export default function Overview({ data: o, error, navigate, reload }: { data: OverviewData | null; error: string; navigate: (p: string) => void; reload: () => void }) {
  const logs = useFetch<{ logs: LogRow[] }>("/logs?limit=12", { intervalMs: 15_000 });
  const act = useAction();
  if (error && !o) return <ErrorBox text={error} />;
  if (!o) return <div className="muted">Загрузка…</div>;
  const ok = (v: boolean) => (v ? "success" : "error");
  const hasToken = o.health.threads.ok;
  const hasLlm = o.readiness.llmKey;
  const hasSources = (o.sources?.enabled ?? 0) > 0;
  const ready = hasToken && hasLlm && hasSources;

  const whatHappens = (() => {
    if (o.killSwitch) return "Автопилот остановлен кнопкой. Ничего не публикуется и не отвечается, пока вы не возобновите.";
    if (o.mode === "OFF") return "Режим «выключен»: система ничего не делает.";
    const base = o.mode === "DRAFT" ? "Система читает источники, анализирует посты и складывает русские черновики в раздел «Черновики». Сама ничего не публикует." : o.mode === "REVIEW" ? "Черновики и ответы ждут вашего одобрения в разделах «Черновики» и «Ответы». Кнопки «Опубликовать» и «Отправить» — за вами." : "Уверенный контент публикуется сам по включённым флагам; рискованный уходит на проверку.";
    return o.dryRun ? `${base} Включён DRY_RUN: даже нажатие «Опубликовать» только запишет пост в журнал, в Threads ничего не уйдёт.` : base;
  })();

  return (
    <>
      <Card title="Что сейчас происходит" actions={<Button size="sm" onClick={reload}>Обновить</Button>}>
        <p style={{ margin: "0 0 10px" }}>{whatHappens}</p>
        <div className="checks">
          <Check ok={hasToken} label={hasToken ? `Токен Threads есть: @${o.health.threads.username ?? o.account?.username ?? ""}` : "Нет токена Threads"} hint={<>Впишите <code>THREADS_ACCESS_TOKEN</code> в файл <code>threads/.env</code> на сервере и выполните <code>docker compose up -d --no-deps threads-app threads-worker</code>. Без токена система не может читать чужие профили и публиковать.</>} />
          <Check ok={hasLlm} label={hasLlm ? `Ключ ИИ есть (${o.health.llmProvider})` : "Нет ключа ИИ (LLM)"} hint={<>Впишите <code>OPENROUTER_API_KEY</code> (или <code>ANTHROPIC_API_KEY</code> / <code>OPENAI_API_KEY</code> / <code>GEMINI_API_KEY</code>) в <code>threads/.env</code>. Без ключа анализ и написание постов невозможны — в журнале это видно как ошибка 401.</>} />
          <Check ok={hasSources} label={hasSources ? `Источники: ${o.sources?.enabled} включено${o.sources?.errors ? `, с ошибками ${o.sources.errors}` : ""}` : "Нет ни одного источника"} hint={<>Добавьте профиль блогера или RSS-ленту в разделе <a href="#" onClick={(e) => { e.preventDefault(); navigate("sources"); }}>Источники</a>. RSS работает без токена Threads.</>} />
          <Check ok={!o.dryRun} label={o.dryRun ? "DRY_RUN включён: публикации только в журнал" : "DRY_RUN выключен: публикации уходят в Threads"} hint={<>Это намеренно на старте. Когда черновики начнут вас устраивать, снимите DRY_RUN в <a href="#" onClick={(e) => { e.preventDefault(); navigate("settings"); }}>Настройках</a>.</>} />
          <Check ok={o.readiness.publicBaseUrl} label={o.readiness.publicBaseUrl ? "Публичный адрес задан (для картинок)" : "Публичный адрес не задан"} hint="Threads скачивает картинки по публичной ссылке; задаётся переменной SITE_URL сайта." />
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Button size="sm" onClick={() => void act.run("Проверить источники", () => post("/sources/poll"), () => { reload(); void logs.reload(); })}>Проверить источники сейчас</Button>
          <Button size="sm" onClick={() => navigate("logs")}>Открыть журнал</Button>
          <span className="dim small">{ready ? "Всё готово к работе в текущем режиме." : "Пока не выполнены пункты выше, часть шагов будет заканчиваться ошибкой — это нормально и видно в журнале."}</span>
        </div>
        <ErrorBox text={act.error} />
        <Notice text={act.notice} />
      </Card>

      <Card title="Автопилот">
        <div className="grid grid-stats">
          <Stat label="Режим" value={MODE_LABEL[o.mode] ?? o.mode} tone={o.killSwitch ? "error" : o.mode === "AUTO" ? "success" : "accent"} sub={o.killSwitch ? "остановлен" : o.dryRun ? "DRY_RUN" : "боевой режим"} />
          <Stat label="Постов за 24 ч" value={o.today.posts} sub={o.lastPostAt ? `последний ${fmtDate(o.lastPostAt)}` : "ещё не публиковали"} />
          <Stat label="Ответов за 24 ч" value={o.today.own_replies} />
          <Stat label="Ответов на чужие посты" value={o.today.public_replies} />
          <Stat label="Кандидатов за 24 ч" value={o.today.candidates_found} sub={`отклонено ${o.today.candidates_rejected}`} />
          <Stat label="Черновики ждут" value={o.today.drafts_waiting} tone={o.today.drafts_waiting ? "warn" : undefined} />
          <Stat label="Запланировано" value={o.today.scheduled} />
          <Stat label="Ответы на проверку" value={o.today.needs_review} tone={o.today.needs_review ? "warn" : undefined} />
          <Stat label="Расход ИИ сегодня" value={fmtUsd(o.today.cost_today)} sub="оценка по тарифам" />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="muted small">Автоматические функции:</span>
          <Badge tone={o.flags.autoPost ? "success" : "neutral"}>автопубликация {o.flags.autoPost ? "вкл" : "выкл"}</Badge>
          <Badge tone={o.flags.autoOwnReplies ? "success" : "neutral"}>автоответы под постами {o.flags.autoOwnReplies ? "вкл" : "выкл"}</Badge>
          <Badge tone={o.flags.autoPublicReplies ? "success" : "neutral"}>ответы на чужие посты {o.flags.autoPublicReplies ? "вкл" : "выкл"}</Badge>
          <Badge tone={o.flags.imageTranslation ? "success" : "neutral"}>перевод картинок {o.flags.imageTranslation ? "вкл" : "выкл"}</Badge>
          <Button size="sm" tone="ghost" onClick={() => navigate("settings")}>Настройки</Button>
        </div>
      </Card>

      <div className="grid grid-2">
        <Card title="Здоровье">
          <div className="stack">
            <div className="row row-between"><span>База данных</span><Badge tone={ok(o.health.db.ok)}>{o.health.db.ok ? "работает" : o.health.db.message}</Badge></div>
            <div className="row row-between"><span>Redis (очереди)</span><Badge tone={ok(o.health.redis.ok)}>{o.health.redis.ok ? "работает" : o.health.redis.message}</Badge></div>
            <div className="row row-between"><span>Threads API</span><Badge tone={ok(o.health.threads.ok)}>{o.health.threads.ok ? o.health.threads.message : "нет токена"}</Badge></div>
            <div className="row row-between"><span>Провайдер ИИ</span><Badge>{o.health.llmProvider}</Badge></div>
            {o.account?.tokenExpiresAt && <div className="row row-between"><span>Токен истекает</span><span className="muted">{fmtDate(o.account.tokenExpiresAt)}</span></div>}
            <div className="row row-between"><span>Последняя проверка источников</span><span className="muted">{fmtDate(o.readiness.lastSourceCheckAt)}</span></div>
            <div className="row row-between"><span>Последний найденный пост</span><span className="muted">{fmtDate(o.readiness.lastSourcePostAt)}</span></div>
            <div className="row row-between"><span>Последний черновик</span><span className="muted">{fmtDate(o.readiness.lastDraftAt)}</span></div>
          </div>
        </Card>
        <Card title="Очереди задач">
          <table className="table">
            <thead><tr><th>Очередь</th><th>Ждут</th><th>В работе</th><th>Отложены</th><th>Ошибки</th></tr></thead>
            <tbody>
              {Object.entries(o.queues ?? {}).map(([name, c]) => (
                <tr key={name}><td>{QUEUE_LABEL[name] ?? name}</td><td>{c.waiting}</td><td>{c.active}</td><td>{c.delayed}</td><td className={c.failed ? "muted" : ""}>{c.failed}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="dim small" style={{ marginTop: 6 }}>«Отложены» — задачи по расписанию и повторы после ошибок; это штатно.</div>
        </Card>
      </div>
      <Card title="Последние действия" actions={<Button size="sm" tone="ghost" onClick={() => navigate("logs")}>Весь журнал</Button>}>
        <LogList logs={logs.data?.logs ?? []} navigate={navigate} />
      </Card>
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
