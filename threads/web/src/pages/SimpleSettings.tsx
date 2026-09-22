import { useEffect, useState } from "react";
import { useFetch, useAction } from "../hooks";
import { put } from "../api";
import { Button, Card, ErrorBox, Field, Notice, Toggle } from "../ui";
import { Icon, PlatformMark } from "../kit";
import type { OverviewData } from "../App";
import { XConnect, type XStatus } from "../xconnect";

type S = {
  mode: string;
  dryRun: boolean;
  killSwitch: boolean;
  flags: { autoOwnReplies: boolean; autoPublicReplies: boolean; autoPost: boolean };
  platforms: { threads: { enabled: boolean; maxChars: number }; x: { enabled: boolean; maxChars: number; language: "ru" | "en"; engagementMode: "off" | "manual" | "quote" | "auto"; dailyReadBudget: number; allowLinks: boolean; engagementQuery: string } };
  persona: { name: string; bio: string; tone: string; rules: string };
  trades: { enabled: boolean; wallet: string; minPnlUsd: number; minRoePct: number; requireBoth: boolean; showUsd: boolean; showSize: boolean; showWallet: boolean; maxPostsPerDay: number; autoPublish: boolean; handle: string; pollMinutes: number };
  movers: { enabled: boolean; minChange24hPct: number; minChange1hPct: number; minVolumeUsd: number; maxPostsPerDay: number; topN: number };
};
type Data = { settings: S; env: { threadsToken: boolean; xKeys: { apiKey: boolean; apiSecret: boolean; accessToken: boolean; accessSecret: boolean }; keys: Record<string, boolean>; hyperliquidWalletEnv: boolean; publicBaseUrl: string | null } };

const Code = ({ children }: { children: string }) => <code className="env">{children}</code>;

function Connection({ mark, title, ok, status, children }: { mark: React.ReactNode; title: string; ok: boolean; status: string; children: React.ReactNode }) {
  return (
    <div className={`conn ${ok ? "conn-ok" : ""}`}>
      <div className="conn-head">
        {mark}
        <b>{title}</b>
        <span className={`conn-state ${ok ? "ok" : ""}`}>{ok ? <Icon name="check" size={14} /> : <Icon name="alert" size={14} />} {status}</span>
      </div>
      <div className="conn-body small muted">{children}</div>
    </div>
  );
}

export default function SimpleSettings({ navigate, changed, overview }: { navigate: (p: string) => void; changed: () => void; overview: OverviewData | null }) {
  const data = useFetch<Data>("/settings");
  // The X connection lives in its own container, so its state is its own request.
  const xb = useFetch<XStatus>("/x-browser/status", { intervalMs: 10_000 });
  const act = useAction();
  const [form, setForm] = useState<S | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (data.data && !dirty) setForm(structuredClone(data.data.settings));
  }, [data.data, dirty]);
  const s = form;
  const env = data.data?.env;
  const t = overview?.platforms.find((p) => p.id === "threads");
  const x = overview?.platforms.find((p) => p.id === "x");

  function patch<K extends keyof S>(key: K, value: Partial<S[K]>) {
    if (!form) return;
    setForm({ ...form, [key]: { ...(form[key] as object), ...(value as object) } } as S);
    setDirty(true);
  }
  const save = () =>
    void act.run(
      "Настройки сохранены",
      () => put("/settings", { platforms: form!.platforms, persona: form!.persona, trades: form!.trades, movers: form!.movers }),
      async () => {
        setDirty(false);
        await data.reload();
        changed();
      },
    );
  // A switch saves on its own. Turning one ON lifts the mode out of OFF — and ONLY out of OFF: the
  // owner may have parked everything in DRAFT or REVIEW on purpose, and a harmless-looking switch
  // must not hand the autopilot back the keys. Turning one OFF never starts anything.
  // It also keeps whatever the owner has typed but not saved yet: apply locally, and re-read the server only when nothing is pending.
  function flag<K extends keyof S>(on: boolean, key: K, value: Partial<S[K]>) {
    const lift = on && s?.mode === "OFF";
    void act.run(
      "Сохранено",
      () => put("/settings", lift ? { mode: "AUTO", [key]: value } : { [key]: value }),
      async () => {
        setForm((f) => (f ? ({ ...f, [key]: { ...(f[key] as object), ...(value as object) } } as S) : f));
        if (!dirty) await data.reload();
        changed();
      },
    );
  }
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : fallback);

  return (
    <>
      <ErrorBox text={data.error || act.error} />
      <Notice text={act.notice} />
      {!s && <p className="muted">Загружаю…</p>}
      {s && env && (
        <>
          <Card title="Подключения">
            <p className="small muted">Threads подключается токеном из файла <Code>threads/.env</Code> — в интерфейсе, базе и логах его нет. X подключается входом в окне браузера, никаких ключей. После правки файла перезапустите сервис — или просто напишите Claude «ключи добавил».</p>
            <div className="conn-list">
              <Connection mark={<PlatformMark id="threads" size={26} />} title="Threads" ok={Boolean(t?.health.ok)} status={t?.health.ok ? `@${t.username}` : env.threadsToken ? "токен есть, но не работает" : "нет токена"}>
                <Code>THREADS_ACCESS_TOKEN</Code> — Meta for Developers → ваше приложение → Threads API → User Token Generator. Права: threads_basic, threads_content_publish, threads_read_replies, threads_manage_replies, threads_manage_mentions, threads_keyword_search, threads_manage_insights. Для обмена на 60-дневный токен — ещё <Code>THREADS_APP_ID</Code> и <Code>THREADS_APP_SECRET</Code>.
                {t && !t.health.ok && env.threadsToken && <div className="error-text">{t.health.message}</div>}
              </Connection>
              <Connection
                mark={<PlatformMark id="x" size={26} />}
                title="X"
                ok={Boolean(xb.data?.connected)}
                status={xb.data?.connected ? `@${xb.data.username ?? ""}` : xb.data?.transport === "api" ? (Object.values(env.xKeys).every(Boolean) ? "ключи есть, но не работают" : `ключей ${Object.values(env.xKeys).filter(Boolean).length} из 4`) : "вход не выполнен"}
              >
                {xb.data?.transport === "api" ? (
                  <>
                    Включён старый платный путь через API X (<Code>X_TRANSPORT=api</Code>). Чтобы работать бесплатно, уберите эту строку из <Code>threads/.env</Code> и войдите в X в окне браузера.
                  </>
                ) : (
                  <>
                    Ключи X не нужны. Наш браузер держит ваш вход так же, как TikTok: вы один раз входите в окне ниже, дальше сервис сам публикует, отвечает и читает. Пароль идёт прямо в X — сервис его не видит и не хранит.
                  </>
                )}
                {xb.data?.issue && <div className="error-text">{xb.data.issue}</div>}
                {xb.data?.error && <div className="error-text">{xb.data.error}</div>}
                <XConnect status={xb.data} onChanged={() => void xb.reload()} />
              </Connection>
              <Connection mark={<span className="pmark pmark-hl" style={{ width: 26, height: 26, fontSize: 13 }}>HL</span>} title="Hyperliquid" ok={Boolean(overview?.hyperliquid.walletValid)} status={overview?.hyperliquid.walletValid ? overview.hyperliquid.wallet ?? "" : "адрес не указан"}>
                Только публичный адрес кошелька — поле ниже, в блоке «Сделки». Приватный ключ и сид-фраза не нужны и нигде не спрашиваются.
              </Connection>
              <Connection mark={<span className="pmark pmark-ai" style={{ width: 26, height: 26, fontSize: 13 }}>AI</span>} title="ИИ для текстов" ok={Boolean(overview?.readiness.llmKey)} status={overview?.readiness.llmKey ? "подключён" : "не подключён"}>
                Тексты для Threads и X пишет Claude по вашей подписке через мост на этом компьютере (<Code>LLM_PROVIDER=claude-bridge</Code>). Платный ключ не нужен; мост должен быть запущен, пока сервис работает.
              </Connection>
            </div>
          </Card>

          <Card title="Автоматика">
            <fieldset disabled={act.busy !== null} className="settings-fields">
              <Toggle checked={s.trades.autoPublish} onChange={(v) => flag(v, "trades", { autoPublish: v })} label="Публиковать посты о плюсовых сделках без моего «ок»" />
              <p className="muted small">Если выключено — карточка и текст готовятся сами и ждут вас в «Постах».</p>
              <Toggle checked={s.flags.autoPost} onChange={(v) => flag(v, "flags", { autoPost: v })} label="Публиковать новости и движения рынка автоматически" />
              <p className="muted small">Проходят только тексты без замечаний проверки; остальное остаётся черновиком.</p>
              <Toggle checked={s.flags.autoOwnReplies} onChange={(v) => flag(v, "flags", { autoOwnReplies: v })} label="Отвечать на комментарии под моими постами" />
              <p className="muted small">До 30 ответов в сутки, пауза от 5 минут, не более двух ответов одному человеку в ветке.</p>
              <Toggle checked={s.flags.autoPublicReplies} onChange={(v) => flag(v, "flags", { autoPublicReplies: v })} label="Комментировать чужие посты" />
              <p className="muted small">Threads — до 6 в сутки. Что делать с чужими постами в X, выбирается ниже в «Площадках»: отвечать самому, готовить текст вам, публиковать цитатой или не трогать вовсе.</p>
            </fieldset>
            {s.dryRun && <p className="warn-text">Включён пробный запуск: в соцсети ничего не отправляется. Выключается в расширенных настройках.</p>}
          </Card>

          <Card title="Голос: всё от вашего лица">
            <div className="form-grid">
              <Field label="Как вас зовут (необязательно)"><input value={s.persona.name} maxLength={80} onChange={(e) => patch("persona", { name: e.target.value })} placeholder="Алмаз" /></Field>
              <Field label="Подпись на карточке сделки"><input value={s.trades.handle} maxLength={60} onChange={(e) => patch("trades", { handle: e.target.value })} placeholder="@ваш_ник" /></Field>
            </div>
            <Field label="Кто вы" note="Пара фраз: чем торгуете, сколько лет на рынке, что вам интересно."><textarea rows={2} maxLength={600} value={s.persona.bio} onChange={(e) => patch("persona", { bio: e.target.value })} /></Field>
            <Field label="Как вы говорите"><textarea rows={2} maxLength={600} value={s.persona.tone} onChange={(e) => patch("persona", { tone: e.target.value })} /></Field>
            <Field label="Ваши правила" note="Например: не обсуждаю размер депозита; не пишу про мемкоины; без мата."><textarea rows={2} maxLength={1200} value={s.persona.rules} onChange={(e) => patch("persona", { rules: e.target.value })} /></Field>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate("voice")}>Добавить примеры своих постов (сильнее всего влияет на стиль) →</button>
          </Card>

          <Card title="Площадки">
            <div className="form-grid">
              <Toggle checked={s.platforms.threads.enabled} onChange={(v) => patch("platforms", { threads: { ...s.platforms.threads, enabled: v } })} label="Публиковать в Threads" />
              <Toggle checked={s.platforms.x.enabled} onChange={(v) => patch("platforms", { x: { ...s.platforms.x, enabled: v } })} label="Публиковать в X" />
            </div>
            <div className="form-grid">
              <Field label="Язык постов в X"><select value={s.platforms.x.language} onChange={(e) => patch("platforms", { x: { ...s.platforms.x, language: e.target.value as "ru" | "en" } })}><option value="ru">русский</option><option value="en">английский</option></select></Field>
              <Field label="Лимит символов X" note="280 без Premium"><input type="number" min={100} value={s.platforms.x.maxChars} onChange={(e) => patch("platforms", { x: { ...s.platforms.x, maxChars: num(e.target.value, 280) } })} /></Field>
              <Field label="Чужие посты в X" note="«не трогать» — комментариев под чужими постами не будет вообще"><select value={s.platforms.x.engagementMode} onChange={(e) => patch("platforms", { x: { ...s.platforms.x, engagementMode: e.target.value as "off" | "manual" | "quote" | "auto" } })}><option value="auto">отвечать под постом самому</option><option value="manual">готовить ответ, отправляю сам</option><option value="quote">публиковать цитатой</option><option value="off">не трогать</option></select></Field>
              <Field label="Сколько чужих постов смотреть в день" note="Через браузер это бесплатно; ограничение нужно, чтобы аккаунт не выглядел роботом."><input type="number" min={0} value={s.platforms.x.dailyReadBudget} onChange={(e) => patch("platforms", { x: { ...s.platforms.x, dailyReadBudget: num(e.target.value, 60) } })} /></Field>
            </div>
            <Field label="Что искать в X" note="Синтаксис поиска самого X — один запрос, по нему берётся свежая лента."><input value={s.platforms.x.engagementQuery} maxLength={400} onChange={(e) => patch("platforms", { x: { ...s.platforms.x, engagementQuery: e.target.value } })} /></Field>
            <Toggle checked={s.platforms.x.allowLinks} onChange={(v) => patch("platforms", { x: { ...s.platforms.x, allowLinks: v } })} label="Разрешить ссылки в текстах постов X" />
            <p className="muted small">По умолчанию ссылки вырезаются: вы держите их в описании профиля и ставите туда сами.</p>
          </Card>

          <Card title="Сделки Hyperliquid">
            <Field label="Публичный адрес кошелька" note="0x… — только адрес. Приватный ключ не нужен."><input value={s.trades.wallet} maxLength={64} spellCheck={false} onChange={(e) => patch("trades", { wallet: e.target.value.trim() })} placeholder="0x…" /></Field>
            <div className="form-grid">
              <Field label="Минимум прибыли, $"><input type="number" min={0} value={s.trades.minPnlUsd} onChange={(e) => patch("trades", { minPnlUsd: num(e.target.value, 50) })} /></Field>
              <Field label="Минимум на маржу (ROE), %"><input type="number" min={0} value={s.trades.minRoePct} onChange={(e) => patch("trades", { minRoePct: num(e.target.value, 5) })} /></Field>
              <Field label="Постов о сделках в день"><input type="number" min={0} max={20} value={s.trades.maxPostsPerDay} onChange={(e) => patch("trades", { maxPostsPerDay: num(e.target.value, 3) })} /></Field>
            </div>
            <div className="form-grid">
              <Toggle checked={s.trades.requireBoth} onChange={(v) => patch("trades", { requireBoth: v })} label="Нужны оба порога сразу" />
              <Toggle checked={s.trades.showUsd} onChange={(v) => patch("trades", { showUsd: v })} label="Показывать прибыль в долларах" />
              <Toggle checked={s.trades.showSize} onChange={(v) => patch("trades", { showSize: v })} label="Показывать размер позиции" />
              <Toggle checked={s.trades.showWallet} onChange={(v) => patch("trades", { showWallet: v })} label="Показывать адрес кошелька на карточке" />
            </div>
          </Card>

          <Card title="Рынок: взлёты и падения">
            <Toggle checked={s.movers.enabled} onChange={(v) => patch("movers", { enabled: v })} label="Следить за громкими движениями" />
            <div className="form-grid">
              <Field label="От, % за сутки"><input type="number" min={1} value={s.movers.minChange24hPct} onChange={(e) => patch("movers", { minChange24hPct: num(e.target.value, 15) })} /></Field>
              <Field label="От, % за час"><input type="number" min={1} value={s.movers.minChange1hPct} onChange={(e) => patch("movers", { minChange1hPct: num(e.target.value, 8) })} /></Field>
              <Field label="Постов в день"><input type="number" min={0} max={20} value={s.movers.maxPostsPerDay} onChange={(e) => patch("movers", { maxPostsPerDay: num(e.target.value, 2) })} /></Field>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate("sources")}>Источники новостей →</button>
          </Card>

          <div className={`savebar ${dirty ? "savebar-on" : ""}`}>
            <span className="small muted">{dirty ? "Есть несохранённые изменения" : "Всё сохранено"}</span>
            <Button tone="primary" disabled={!dirty} busy={act.busy !== null} onClick={save}>Сохранить</Button>
          </div>

          <details className="tech">
            <summary>Диагностика и тонкая настройка</summary>
            <div className="settings-links">
              <button onClick={() => navigate("overview")}>Состояние подключения →</button>
              <button onClick={() => navigate("advanced")}>Расширенные настройки (лимиты, расписание, модели) →</button>
              <button onClick={() => navigate("logs")}>История действий →</button>
            </div>
          </details>
        </>
      )}
    </>
  );
}
