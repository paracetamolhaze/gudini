import { useEffect, useState } from "react";
import { post, PREFIX } from "./api";
import { useFetch, useRoute, useAction } from "./hooks";
import { Button, ErrorBox } from "./ui";
import { Icon, PlatformFilterControl, PlatformMark, type PlatformFilter, type PlatformId } from "./kit";
import Home from "./pages/Home";
import Posts from "./pages/Posts";
import Trades from "./pages/Trades";
import Market from "./pages/Market";
import Conversations from "./pages/Conversations";
import SimpleSettings from "./pages/SimpleSettings";
import Overview from "./pages/Overview";
import Settings from "./pages/Settings";
import Sources from "./pages/Sources";
import Voice from "./pages/Voice";
import Logs from "./pages/Logs";
import Replies from "./pages/Replies";
import Prompts from "./pages/Prompts";
import Analytics from "./pages/Analytics";
import Images from "./pages/Images";

export type PlatformOverview = {
  id: PlatformId;
  label: string;
  enabled: boolean;
  configured: boolean;
  health: { ok: boolean; message: string; username?: string };
  username: string | null;
  tokenExpiresAt: string | null;
  maxChars: number;
  publicReplies: "api" | "auto" | "manual" | "quote" | "off";
  today: { posts: number; replies: number; waiting: number };
  usage: { today: number; last30d: number; byOperation: Array<{ operation: string; units: number; cost: number }> } | null;
};

export type OverviewData = {
  mode: "OFF" | "DRAFT" | "REVIEW" | "AUTO";
  killSwitch: boolean;
  dryRun: boolean;
  flags: { autoPost: boolean; autoOwnReplies: boolean; autoPublicReplies: boolean; imageTranslation: boolean };
  // needs_review counts only replies under our own posts; comments on other people's posts are public_needs_review.
  today: { posts: number; own_replies: number; public_replies: number; candidates_found: number; candidates_rejected: number; drafts_waiting: number; scheduled: number; needs_review: number; public_needs_review: number; cost_today: number | null };
  sources: { total: number; enabled: number; errors: number } | null;
  lastPostAt: string | null;
  platforms: PlatformOverview[];
  hyperliquid: { enabled: boolean; walletSet: boolean; walletValid: boolean; wallet: string | null; autoPublish: boolean; fills: number; lastFillAt: string | null; closed7d: number; wins7d: number; draftsWaiting: number };
  market: { enabled: boolean; lastMoveAt: string | null; moves24h: number };
  persona: { filled: boolean; name: string };
  account: { username: string; userId: string; tokenExpiresAt: string | null } | null;
  health: { db: { ok: boolean; message: string }; redis: { ok: boolean; message: string }; threads: { ok: boolean; message: string; username?: string }; llmProvider: string };
  readiness: { llmKey: boolean; publicBaseUrl: boolean; lastSourceCheckAt: string | null; lastSourcePostAt: string | null; lastDraftAt: string | null };
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }>;
};

const TITLES: Record<string, string> = {
  home: "Главная",
  posts: "Посты",
  trades: "Сделки",
  market: "Рынок",
  replies: "Ответы мне",
  discovery: "Чужие посты",
  settings: "Настройки",
  advanced: "Расширенные настройки",
  voice: "Стиль и голос",
  sources: "Источники новостей",
  logs: "История действий",
  overview: "Подключение и диагностика",
  prompts: "Промпты",
  analytics: "Статистика",
  images: "Изображения",
};

const NAV: Array<{ group: string; items: Array<{ id: string; label: string; icon: string }> }> = [
  { group: "", items: [{ id: "home", label: "Главная", icon: "home" }] },
  { group: "Контент", items: [{ id: "posts", label: "Посты", icon: "posts" }, { id: "trades", label: "Сделки", icon: "trades" }, { id: "market", label: "Рынок", icon: "market" }] },
  { group: "Разговоры", items: [{ id: "replies", label: "Ответы мне", icon: "replies" }, { id: "discovery", label: "Чужие посты", icon: "discovery" }] },
];
const MORE: Array<[string, string]> = [["voice", "Стиль и голос"], ["sources", "Источники новостей"], ["analytics", "Статистика"], ["logs", "История действий"], ["prompts", "Промпты"], ["images", "Изображения"], ["overview", "Диагностика"], ["advanced", "Расширенные настройки"]];
const TABS: Array<[string, string, string]> = [["home", "Главная", "home"], ["posts", "Посты", "posts"], ["trades", "Сделки", "trades"], ["replies", "Ответы", "replies"]];
const FILTERED = new Set(["posts", "replies", "discovery"]);

function readFilter(): PlatformFilter {
  try {
    const v = localStorage.getItem("social:platform");
    return v === "threads" || v === "x" ? v : "";
  } catch {
    return "";
  }
}

export default function App() {
  const [route, navigate] = useRoute();
  const overview = useFetch<OverviewData>("/overview", { intervalMs: 15000 });
  const act = useAction();
  const [filter, setFilter] = useState<PlatformFilter>(readFilter);
  const [sheet, setSheet] = useState(false);
  const o = overview.data;
  const page = route.page === "drafts" || route.page === "candidates" ? "posts" : route.page;
  const title = TITLES[page] ?? "Главная";
  useEffect(() => {
    document.title = `${title} · Соцсети · Гудини`;
    setSheet(false);
  }, [title]);
  useEffect(() => {
    try {
      localStorage.setItem("social:platform", filter);
    } catch {
      // private mode
    }
  }, [filter]);

  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(id);
  };
  const paused = Boolean(o?.killSwitch || o?.mode === "OFF");
  const connected = (o?.platforms ?? []).filter((p) => p.enabled && p.health.ok);
  const waiting: Record<string, number> = { posts: o?.today.drafts_waiting ?? 0, replies: o?.today.needs_review ?? 0, discovery: o?.today.public_needs_review ?? 0, trades: o?.hyperliquid.draftsWaiting ?? 0 };
  const statusText = !o ? "" : paused ? "Автоматика на паузе" : o.dryRun ? "Пробный запуск — отправки выключены" : connected.length === 0 ? "Площадки не подключены" : `Работает: ${connected.map((p) => p.label).join(" + ")}`;
  const running = Boolean(o && !paused && !o.dryRun && connected.length > 0);

  const body = (() => {
    switch (page) {
      case "posts":
        return <Posts id={route.id} navigate={navigate} platform={filter} platforms={o?.platforms ?? []} />;
      case "trades":
        return <Trades navigate={navigate} overview={o} reloadOverview={() => void overview.reload()} />;
      case "market":
        return <Market navigate={navigate} tab={route.id} />;
      case "replies":
        return route.id ? <Replies id={route.id} navigate={navigate} /> : <Conversations key={`own${filter}`} kind="own" navigate={navigate} platform={filter} />;
      case "discovery":
        return <Conversations key={`public${filter}`} kind="public" navigate={navigate} platform={filter} xMode={o?.platforms.find((p) => p.id === "x")?.publicReplies} />;
      case "settings":
        return <SimpleSettings navigate={navigate} changed={() => void overview.reload()} overview={o} />;
      case "advanced":
        return <Settings onSaved={() => void overview.reload()} />;
      case "sources":
        return <Sources />;
      case "voice":
        return <Voice />;
      case "logs":
        return <Logs />;
      case "prompts":
        return <Prompts />;
      case "analytics":
        return <Analytics />;
      case "images":
        return <Images navigate={navigate} />;
      case "overview":
        return <Overview data={o} error={overview.error} navigate={navigate} reload={() => void overview.reload()} />;
      default:
        return <Home data={o} navigate={navigate} reload={() => void overview.reload()} />;
    }
  })();

  // Пауза трогает только стоп-кран. Режим — отдельное решение владельца: «Возобновить» не должно
  // втихую включать самый агрессивный режим, когда автоматика была выключена насовсем.
  const modeOff = o?.mode === "OFF";
  const pauseButton = o && (
    <Button
      tone={paused ? "primary" : "default"}
      busy={act.busy !== null}
      disabled={modeOff && Boolean(paused)}
      title={modeOff && paused ? "Автоматика выключена в расширенных настройках — включите режим там" : undefined}
      onClick={() => void act.run("Режим изменён", () => post("/kill-switch", { stop: !paused }), overview.reload)}
    >
      <Icon name={paused ? "play" : "pause"} size={15} /> {paused ? "Возобновить" : "Пауза"}
    </Button>
  );

  return (
    <div className="shell">
      <aside className="side" aria-label="Разделы">
        <a className="side-brand" href="/">
          Гудини <span>/ Соцсети</span>
        </a>
        <div className="side-platforms">
          {(o?.platforms ?? []).map((p) => (
            <a key={p.id} href={`${PREFIX}/settings`} onClick={go("settings")} className="side-platform" title={p.health.message}>
              <PlatformMark id={p.id} />
              <span className="side-platform-name">{p.username ? `@${p.username}` : p.label}</span>
              <span className={`dot ${!p.enabled ? "dot-off" : p.health.ok ? "dot-ok" : "dot-warn"}`} />
            </a>
          ))}
        </div>
        <nav className="side-nav">
          {NAV.map((g) => (
            <div key={g.group || "top"} className="side-group">
              {g.group && <div className="side-group-title">{g.group}</div>}
              {g.items.map((it) => (
                <a key={it.id} href={`${PREFIX}/${it.id}`} onClick={go(it.id)} className={page === it.id ? "active" : ""} aria-current={page === it.id ? "page" : undefined}>
                  <Icon name={it.icon} />
                  <span>{it.label}</span>
                  {waiting[it.id] ? <span className="count">{waiting[it.id]}</span> : null}
                </a>
              ))}
            </div>
          ))}
          <div className="side-group">
            <div className="side-group-title">Система</div>
            <a href={`${PREFIX}/settings`} onClick={go("settings")} className={page === "settings" ? "active" : ""}>
              <Icon name="settings" />
              <span>Настройки</span>
            </a>
            <details className="side-more" open={MORE.some(([id]) => id === page)}>
              <summary>
                <Icon name="more" />
                <span>Ещё</span>
              </summary>
              {MORE.map(([id, label]) => (
                <a key={id} href={`${PREFIX}/${id}`} onClick={go(id)} className={page === id ? "active" : ""}>
                  {label}
                </a>
              ))}
            </details>
          </div>
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <a className="topbar-brand" href="/">
            Гудини <span>/ Соцсети</span>
          </a>
          <div className="topbar-title">
            <h1>{title}</h1>
            {o && (
              <span className={`live ${running ? "live-on" : ""}`}>
                <span className="dot" />
                {statusText}
              </span>
            )}
          </div>
          <div className="topbar-actions">
            {FILTERED.has(page) && !route.id && <PlatformFilterControl value={filter} onChange={setFilter} />}
            {pauseButton}
          </div>
        </header>
        <main className="content">
          <ErrorBox text={act.error || overview.error} />
          {body}
        </main>
      </div>

      <nav className="tabbar" aria-label="Разделы">
        {TABS.map(([id, label, icon]) => (
          <a key={id} href={`${PREFIX}/${id}`} onClick={go(id)} className={page === id ? "active" : ""}>
            <Icon name={icon} size={21} />
            <span>{label}</span>
            {waiting[id] ? <i className="tab-badge">{waiting[id]}</i> : null}
          </a>
        ))}
        <button type="button" className={sheet || !TABS.some(([id]) => id === page) ? "active" : ""} onClick={() => setSheet(!sheet)} aria-expanded={sheet}>
          <Icon name="more" size={21} />
          <span>Ещё</span>
        </button>
      </nav>
      {sheet && (
        <div className="sheet-backdrop" onClick={() => setSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {([["market", "Рынок"], ["discovery", "Чужие посты"], ["settings", "Настройки"], ...MORE] as Array<[string, string]>).map(([id, label]) => (
              <a key={id} href={`${PREFIX}/${id}`} onClick={go(id)} className={page === id ? "active" : ""}>
                {label}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
