import { useState } from "react";
import { API, post, put } from "../api";
import { useAction, useFetch, fmtDate } from "../hooks";
import { Button, Card, Empty, ErrorBox, Notice } from "../ui";
import { Icon, Modal, Pct, Usd, fmtHeld, fmtPrice } from "../kit";
import type { OverviewData } from "../App";

type Trade = {
  id: string;
  coin: string;
  direction: "LONG" | "SHORT";
  status: "OPEN" | "CLOSED";
  opened_at: string;
  closed_at: string | null;
  entry_px: number;
  exit_px: number | null;
  net_pnl: number;
  leverage: number | null;
  roe_pct: number | null;
  move_pct: number | null;
  post_status: "NONE" | "SKIPPED" | "DRAFTED" | "POSTED";
  skip_reason: string | null;
  note: string | null;
  draft_id: string | null;
  worth: { ok: boolean; reason: string };
};
type Data = {
  wallet: { short: string; valid: boolean } | null;
  settings: { enabled: boolean; minPnlUsd: number; minRoePct: number; requireBoth: boolean; showUsd: boolean; autoPublish: boolean; maxPostsPerDay: number };
  stats: { closed: number; wins: number; net_pnl: number; best: number | null } | null;
  trades: Trade[];
};

const POST_LABEL: Record<Trade["post_status"], string> = { NONE: "без поста", SKIPPED: "пропущена", DRAFTED: "пост готов", POSTED: "опубликована" };

export default function Trades({ navigate, overview, reloadOverview }: { navigate: (p: string) => void; overview: OverviewData | null; reloadOverview: () => void }) {
  const [only, setOnly] = useState<"" | "CLOSED" | "OPEN">("");
  const data = useFetch<Data>(`/trades?limit=150${only ? `&status=${only}` : ""}`, { intervalMs: 8000 });
  const act = useAction();
  const [card, setCard] = useState<Trade | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const d = data.data;
  const s = d?.settings;
  const reload = async () => {
    await data.reload();
    reloadOverview();
  };

  if (d && !d.wallet) {
    return (
      <Card title="Подключите Hyperliquid">
        <p className="muted">Нужен только публичный адрес кошелька (0x…). По нему читаются исполнения сделок — приватный ключ не нужен, доступа к средствам нет.</p>
        <Button tone="primary" onClick={() => navigate("settings")}>Указать адрес в настройках</Button>
      </Card>
    );
  }

  return (
    <>
      <Notice text={act.notice} />
      <ErrorBox text={act.error || data.error} />
      {d?.wallet && !d.wallet.valid && <div className="warn-box">Адрес кошелька выглядит неверно — нужен адрес вида 0x… из 42 символов.</div>}
      <div className="tiles">
        <div className="tile tile-static"><b>{d?.stats?.closed ?? 0}</b><span>закрыто за 30 дней</span></div>
        <div className="tile tile-static"><b>{d?.stats && d.stats.closed ? `${Math.round((d.stats.wins / d.stats.closed) * 100)}%` : "—"}</b><span>в плюс</span></div>
        <div className="tile tile-static"><b><Usd value={d?.stats?.net_pnl ?? null} signed /></b><span>итог после комиссий</span></div>
        <div className="tile tile-static"><b><Usd value={d?.stats?.best ?? null} signed /></b><span>лучшая сделка</span></div>
      </div>

      <div className="list-head">
        <div className="chips" role="group" aria-label="Статус сделки">
          {([["", "Все"], ["CLOSED", "Закрытые"], ["OPEN", "Открытые"]] as const).map(([v, label]) => (
            <button key={v} className={`chip ${only === v ? "on" : ""}`} onClick={() => setOnly(v)}>{label}</button>
          ))}
        </div>
        <div className="row">
          <span className="small muted">{d?.wallet?.short}</span>
          <Button busy={act.busy !== null} onClick={() => void act.run("Проверяю Hyperliquid", () => post("/trades/sync"), reload)}><Icon name="refresh" size={14} /> Обновить</Button>
        </div>
      </div>
      {s && (
        <p className="small muted rule-line">
          Пост получают только закрытые плюсовые сделки: от <b>${s.minPnlUsd}</b> {s.requireBoth ? "и" : "или"} от <b>{s.minRoePct}%</b> на маржу, не больше {s.maxPostsPerDay} в день, {s.autoPublish ? "публикуются сами" : "публикуются после вашего «ок»"}. Сумма в долларах {s.showUsd ? "показывается" : "скрыта"}.{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); navigate("settings"); }}>Изменить</a>
        </p>
      )}

      {data.loading && !d && <p className="muted">Загружаю сделки…</p>}
      {d?.trades.length === 0 && <Empty title="Сделок пока нет" text={overview?.hyperliquid.fills ? "В выбранном фильтре пусто." : "Нажмите «Обновить» — исполнения подтянутся с Hyperliquid за последние дни."} />}
      <div className="trade-list">
        {d?.trades.map((t) => (
          <div key={t.id} className={`trade ${t.status === "OPEN" ? "trade-open" : t.net_pnl >= 0 ? "trade-win" : "trade-loss"}`}>
            <div className="trade-main">
              <div className="trade-coin">
                <b>{t.coin}</b>
                <span className={`side-chip ${t.direction === "LONG" ? "side-long" : "side-short"}`}>{t.direction}</span>
                {t.leverage && <span className="lev-chip">x{t.leverage}</span>}
              </div>
              <div className="trade-prices">
                <span>{fmtPrice(t.entry_px)}</span>
                <span className="dim">→</span>
                <span>{t.exit_px === null ? "…" : fmtPrice(t.exit_px)}</span>
              </div>
              <div className="trade-meta small muted">
                {fmtHeld(t.opened_at, t.closed_at)} · {fmtDate(t.closed_at ?? t.opened_at)}
              </div>
            </div>
            <div className="trade-result">
              <div className="trade-roe">{t.status === "OPEN" ? <span className="dim">открыта</span> : <Pct value={t.roe_pct ?? t.move_pct} />}</div>
              <div className="small">{t.status === "CLOSED" && <Usd value={t.net_pnl} signed />}</div>
            </div>
            <div className="trade-actions">
              <span className={`post-state post-${t.post_status}`} title={t.skip_reason ?? (t.worth.ok ? "" : t.worth.reason)}>{POST_LABEL[t.post_status]}</span>
              {t.status === "CLOSED" && t.net_pnl > 0 && <button className="btn btn-sm btn-ghost" onClick={() => setCard(t)}><Icon name="image" size={14} /> Карточка</button>}
              {t.draft_id ? (
                <button className="btn btn-sm" onClick={() => navigate(`posts/${t.draft_id}`)}>Открыть пост</button>
              ) : (
                t.status === "CLOSED" && t.net_pnl > 0 && (
                  <button className="btn btn-sm btn-primary" disabled={act.busy !== null} onClick={() => void act.run("Готовлю карточку и текст", () => post(`/trades/${t.id}/draft`), reload)}>Сделать пост</button>
                )
              )}
              {t.status === "CLOSED" && t.net_pnl > 0 && !t.draft_id && (
                <button className="btn btn-sm btn-ghost" onClick={() => { setNoteFor(noteFor === t.id ? null : t.id); setNote(t.note ?? ""); }}>{t.note ? "Заметка ✓" : "Заметка"}</button>
              )}
            </div>
            {(t.skip_reason || (!t.worth.ok && t.status === "CLOSED" && t.net_pnl > 0)) && t.post_status !== "POSTED" && !t.draft_id && <div className="trade-reason small dim">{t.skip_reason ?? t.worth.reason}</div>}
            {noteFor === t.id && (
              <form className="trade-note" onSubmit={(e) => { e.preventDefault(); void act.run("Заметка сохранена", () => put(`/trades/${t.id}`, { note }), async () => { setNoteFor(null); await data.reload(); }); }}>
                <textarea rows={2} maxLength={1500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Почему зашли и как вели сделку — пост возьмёт идею только отсюда, сам он её не придумывает" />
                <Button type="submit" busy={act.busy !== null}>Сохранить заметку</Button>
              </form>
            )}
          </div>
        ))}
      </div>
      {card && (
        <Modal title={`${card.coin} ${card.direction}`} onClose={() => setCard(null)}>
          <img className="card-preview" src={`${API}/trades/${card.id}/card.jpg`} alt={`Карточка сделки ${card.coin}`} />
          <p className="small muted">Карточка рисуется из исполнений, которые отдаёт Hyperliquid по вашему адресу. Что показывать (сумму, размер, адрес) — в настройках.</p>
        </Modal>
      )}
    </>
  );
}
