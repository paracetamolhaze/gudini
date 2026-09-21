import { post } from "../api";
import { useAction, useFetch, fmtDate } from "../hooks";
import { Button, Empty, ErrorBox, Notice } from "../ui";
import { Icon, Pct, Segmented, fmtPrice } from "../kit";
import Candidates from "./Candidates";

type Move = { id: string; symbol: string; name: string; direction: "UP" | "DOWN"; period: string; change_pct: number; price: number; volume_24h: number | null; rank: number | null; status: string; reason: string | null; draft_id: string | null; detected_at: string; data_json: { onHyperliquid?: boolean } | null };
type Data = { settings: { enabled: boolean; minChange24hPct: number; minChange1hPct: number; minVolumeUsd: number; topN: number; maxPostsPerDay: number }; moves: Move[] };

const bigUsd = (v: number | null): string => (v === null ? "—" : v >= 1e9 ? `$${(v / 1e9).toFixed(1)} млрд` : `$${Math.round(v / 1e6)} млн`);

export default function Market({ navigate, tab }: { navigate: (p: string) => void; tab: string | null }) {
  const current = tab === "news" ? "news" : "moves";
  return (
    <>
      <Segmented label="Раздел рынка" value={current} onChange={(v) => navigate(v === "news" ? "market/news" : "market")} options={[{ value: "moves", label: "Взлёты и падения" }, { value: "news", label: "Новости" }]} />
      {current === "news" ? <Candidates navigate={navigate} /> : <Moves navigate={navigate} />}
    </>
  );
}

function Moves({ navigate }: { navigate: (p: string) => void }) {
  const data = useFetch<Data>("/market/moves", { intervalMs: 15000 });
  const act = useAction();
  const s = data.data?.settings;
  return (
    <>
      <div className="list-head">
        {s ? (
          <p className="small muted rule-line">
            Слежу за топ-{s.topN} монет: от <b>{s.minChange24hPct}%</b> за сутки или <b>{s.minChange1hPct}%</b> за час при объёме от {bigUsd(s.minVolumeUsd)}. До {s.maxPostsPerDay} постов в день; причину движения не выдумываю.
          </p>
        ) : <span />}
        <Button busy={act.busy !== null} onClick={() => void act.run("Проверяю рынок", () => post("/market/scan"), data.reload)}><Icon name="refresh" size={14} /> Проверить сейчас</Button>
      </div>
      <Notice text={act.notice} />
      <ErrorBox text={act.error || data.error} />
      {data.data?.moves.length === 0 && <Empty title="Громких движений пока не было" text="Как только монета из топа сильно вырастет или упадёт, она появится здесь вместе с черновиком поста." />}
      <div className="trade-list">
        {data.data?.moves.map((m) => (
          <div key={m.id} className={`trade ${m.direction === "UP" ? "trade-win" : "trade-loss"}`}>
            <div className="trade-main">
              <div className="trade-coin">
                <b>{m.symbol}</b>
                <span className="small muted">{m.name}</span>
                {m.data_json?.onHyperliquid && <span className="lev-chip">HL</span>}
              </div>
              <div className="trade-prices">
                <span>${fmtPrice(m.price)}</span>
                <span className="dim small">объём {bigUsd(m.volume_24h)}{m.rank ? ` · #${m.rank}` : ""}</span>
              </div>
              <div className="trade-meta small muted">{fmtDate(m.detected_at)} · за {m.period === "24h" ? "сутки" : "час"}</div>
            </div>
            <div className="trade-result">
              <div className="trade-roe"><Pct value={m.change_pct} /></div>
            </div>
            <div className="trade-actions">
              {m.draft_id ? (
                <button className="btn btn-sm" onClick={() => navigate(`posts/${m.draft_id}`)}>Открыть пост</button>
              ) : (
                <button className="btn btn-sm btn-primary" disabled={act.busy !== null} onClick={() => void act.run("Пишу пост", () => post(`/market/moves/${m.id}/draft`), data.reload)}>Написать пост</button>
              )}
            </div>
            {m.reason && !m.draft_id && <div className="trade-reason small dim">{m.reason}</div>}
          </div>
        ))}
      </div>
    </>
  );
}
