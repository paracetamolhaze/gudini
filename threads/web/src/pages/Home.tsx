import { post } from "../api";
import { useAction, useFetch, fmtDate } from "../hooks";
import { Button, Card, ErrorBox, Notice } from "../ui";
import { Icon, PlatformMark, Usd } from "../kit";
import type { OverviewData, PlatformOverview } from "../App";

type LogRow = { id: number; at: string; event: string; level: string; message: string };

/** What is still missing before the account can run on its own — each item says exactly what to do. */
function todo(o: OverviewData): Array<{ key: string; title: string; hint: string }> {
  const items: Array<{ key: string; title: string; hint: string }> = [];
  const t = o.platforms.find((p) => p.id === "threads");
  const x = o.platforms.find((p) => p.id === "x");
  if (!o.readiness.llmKey) items.push({ key: "llm", title: "Ключ ИИ", hint: "OPENROUTER_API_KEY в threads/.env — без него не пишутся посты и ответы." });
  if (t?.enabled && !t.health.ok) items.push({ key: "threads", title: "Подключить Threads", hint: t.configured ? t.health.message : "THREADS_ACCESS_TOKEN в threads/.env (Meta for Developers → Threads API → User Token Generator)." });
  if (x?.enabled && !x.health.ok) items.push({ key: "x", title: "Подключить X", hint: x.configured ? x.health.message : "Четыре ключа X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET в threads/.env (приложение с правами Read and write)." });
  if (o.hyperliquid.enabled && !o.hyperliquid.walletValid) items.push({ key: "hl", title: "Адрес кошелька Hyperliquid", hint: o.hyperliquid.walletSet ? "Адрес должен быть вида 0x… из 42 символов." : "Только публичный адрес 0x… — приватный ключ не нужен и нигде не спрашивается. Настройки → Сделки." });
  if (!o.persona.filled) items.push({ key: "persona", title: "Рассказать о себе", hint: "Имя, пара фраз о себе и свои правила — посты и ответы пишутся от вашего лица. Настройки → Голос." });
  if (!o.readiness.publicBaseUrl) items.push({ key: "url", title: "Публичный адрес сайта", hint: "PUBLIC_BASE_URL нужен, чтобы Threads мог скачать карточку сделки." });
  return items;
}

function PlatformCard({ p, navigate }: { p: PlatformOverview; navigate: (p: string) => void }) {
  const state = !p.enabled ? "выключена" : p.health.ok ? "подключена" : p.configured ? "ошибка подключения" : "не подключена";
  return (
    <section className={`pcard ${p.enabled && p.health.ok ? "pcard-on" : ""}`}>
      <div className="pcard-head">
        <PlatformMark id={p.id} size={30} />
        <div>
          <div className="pcard-name">{p.label}</div>
          <div className="small muted">{p.username ? `@${p.username}` : state}</div>
        </div>
        <span className={`dot ${!p.enabled ? "dot-off" : p.health.ok ? "dot-ok" : "dot-warn"}`} title={p.health.message} />
      </div>
      <div className="pcard-stats">
        <div><b>{p.today.posts}</b><span>постов за сутки</span></div>
        <div><b>{p.today.replies}</b><span>ответов</span></div>
        <div><b>{p.today.waiting}</b><span>ждут вас</span></div>
      </div>
      <div className="pcard-foot small muted">
        {p.id === "x" ? (
          <>
            Расход X API: <Usd value={p.usage?.today ?? 0} /> сегодня · <Usd value={p.usage?.last30d ?? 0} /> за 30 дней
            <br />
            Чужие посты: {p.publicReplies === "manual" ? "ответ готовится, отправляете вы" : p.publicReplies === "quote" ? "цитатой через API" : "выключено"}
          </>
        ) : (
          <>Ответы под своими и чужими постами идут через API{p.tokenExpiresAt ? ` · токен до ${fmtDate(p.tokenExpiresAt)}` : ""}</>
        )}
      </div>
      {(!p.health.ok || !p.enabled) && (
        <button className="btn btn-sm" onClick={() => navigate("settings")}>
          Как подключить
        </button>
      )}
    </section>
  );
}

export default function Home({ data: o, navigate, reload }: { data: OverviewData | null; navigate: (p: string) => void; reload: () => void }) {
  const logs = useFetch<{ logs: LogRow[] }>("/logs?limit=9", { intervalMs: 20000 });
  const act = useAction();
  if (!o) return <p className="muted">Загружаю…</p>;
  const missing = todo(o);
  const hl = o.hyperliquid;
  return (
    <>
      <Notice text={act.notice} />
      <ErrorBox text={act.error} />
      {missing.length > 0 && (
        <Card title="Что нужно от вас" className="todo">
          <ol className="todo-list">
            {missing.map((m) => (
              <li key={m.key}>
                <b>{m.title}</b>
                <span className="muted">{m.hint}</span>
              </li>
            ))}
          </ol>
          <div className="row">
            <Button tone="primary" onClick={() => navigate("settings")}>Открыть настройки</Button>
            <span className="small dim">Ключи кладутся в файл threads/.env на сервере — в интерфейсе они не вводятся и не показываются.</span>
          </div>
        </Card>
      )}

      <div className="grid-cards">
        {o.platforms.map((p) => (
          <PlatformCard key={p.id} p={p} navigate={navigate} />
        ))}
        <section className={`pcard ${hl.walletValid ? "pcard-on" : ""}`}>
          <div className="pcard-head">
            <span className="pmark pmark-hl" style={{ width: 30, height: 30, fontSize: 15 }}>HL</span>
            <div>
              <div className="pcard-name">Hyperliquid</div>
              <div className="small muted">{hl.wallet ?? "кошелёк не указан"}</div>
            </div>
            <span className={`dot ${!hl.enabled ? "dot-off" : hl.walletValid ? "dot-ok" : "dot-warn"}`} />
          </div>
          <div className="pcard-stats">
            <div><b>{hl.closed7d}</b><span>сделок за 7 дней</span></div>
            <div><b>{hl.wins7d}</b><span>в плюс</span></div>
            <div><b>{hl.draftsWaiting}</b><span>постов ждут</span></div>
          </div>
          <div className="pcard-foot small muted">
            Публикуются только закрытые плюсовые сделки{hl.autoPublish ? " · автоматически" : " · после вашего «ок»"}
            {hl.lastFillAt ? ` · последнее исполнение ${fmtDate(hl.lastFillAt)}` : ""}
          </div>
          <div className="row">
            <button className="btn btn-sm" disabled={!hl.walletValid || act.busy !== null} onClick={() => void act.run("Синхронизация запущена", () => post("/trades/sync"), reload)}>
              <Icon name="refresh" size={14} /> Проверить сделки
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate("trades")}>Все сделки →</button>
          </div>
        </section>
      </div>

      <div className="tiles">
        <button className="tile" onClick={() => navigate("posts")}><b>{o.today.drafts_waiting}</b><span>черновиков ждут</span></button>
        <button className="tile" onClick={() => navigate("posts")}><b>{o.today.scheduled}</b><span>запланировано</span></button>
        <button className="tile" onClick={() => navigate("replies")}><b>{o.today.needs_review}</b><span>ответов на проверке</span></button>
        <button className="tile" onClick={() => navigate("market")}><b>{o.market.moves24h}</b><span>движений за сутки</span></button>
        <button className="tile" onClick={() => navigate("analytics")}><b><Usd value={o.today.cost_today ?? 0} /></b><span>ИИ сегодня</span></button>
      </div>

      <Card title="Последние действия" actions={<button className="btn btn-ghost btn-sm" onClick={() => navigate("logs")}>Вся история →</button>}>
        <ErrorBox text={logs.error} />
        {logs.data?.logs.length === 0 && <p className="muted">Пока тихо. Как только появятся посты, сделки или комментарии — они будут здесь.</p>}
        <div className="feed">
          {logs.data?.logs.map((l) => (
            <div key={l.id} className={`feed-row feed-${l.level}`}>
              <span className="feed-time">{fmtDate(l.at)}</span>
              <span className="feed-msg">{l.message.split("\n")[0]}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
