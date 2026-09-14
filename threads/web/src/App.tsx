import { useEffect, useState } from "react";
import { get, post } from "./api";
import { useFetch, useRoute } from "./hooks";
import { Badge, ErrorBox } from "./ui";
import Overview from "./pages/Overview";
import Sources from "./pages/Sources";
import Candidates from "./pages/Candidates";
import Drafts from "./pages/Drafts";
import Queue from "./pages/Queue";
import Published from "./pages/Published";
import Replies from "./pages/Replies";
import Discovery from "./pages/Discovery";
import Images from "./pages/Images";
import Analytics from "./pages/Analytics";
import Voice from "./pages/Voice";
import Prompts from "./pages/Prompts";
import SettingsPage from "./pages/Settings";
import Logs from "./pages/Logs";

export type OverviewData = {
  mode: "OFF" | "DRAFT" | "REVIEW" | "AUTO";
  killSwitch: boolean;
  dryRun: boolean;
  flags: { autoPost: boolean; autoOwnReplies: boolean; autoPublicReplies: boolean; imageTranslation: boolean };
  today: { posts: number; own_replies: number; public_replies: number; candidates_found: number; candidates_rejected: number; drafts_waiting: number; scheduled: number; needs_review: number; cost_today: number | null };
  sources: { total: number; enabled: number; errors: number } | null;
  lastPostAt: string | null;
  account: { username: string; userId: string; tokenExpiresAt: string | null } | null;
  health: { db: { ok: boolean; message: string }; redis: { ok: boolean; message: string }; threads: { ok: boolean; message: string; username?: string }; llmProvider: string };
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }>;
};

const PAGES: Array<{ id: string; label: string; badge?: (o: OverviewData) => number }> = [
  { id: "overview", label: "Overview" },
  { id: "sources", label: "Sources", badge: (o) => o.sources?.errors ?? 0 },
  { id: "candidates", label: "Candidates" },
  { id: "drafts", label: "Drafts", badge: (o) => o.today.drafts_waiting },
  { id: "queue", label: "Queue", badge: (o) => o.today.scheduled },
  { id: "published", label: "Published" },
  { id: "replies", label: "Replies", badge: (o) => o.today.needs_review },
  { id: "discovery", label: "Discovery" },
  { id: "images", label: "Images" },
  { id: "analytics", label: "Analytics" },
  { id: "voice", label: "Voice" },
  { id: "prompts", label: "Prompts" },
  { id: "settings", label: "Settings" },
  { id: "logs", label: "Logs" },
];

export default function App() {
  const [route, navigate] = useRoute();
  const overview = useFetch<OverviewData>("/overview", { intervalMs: 15_000 });
  const [killBusy, setKillBusy] = useState(false);
  const [killError, setKillError] = useState("");
  const o = overview.data;

  useEffect(() => {
    document.title = `${PAGES.find((p) => p.id === route.page)?.label ?? "Threads"} · Threads · Гудини`;
  }, [route.page]);

  async function toggleKill() {
    if (!o) return;
    const stop = !o.killSwitch;
    if (stop && !confirm("Остановить автопилот? Новые публикации, ответы и engagement будут запрещены немедленно.")) return;
    setKillBusy(true);
    setKillError("");
    try {
      await post("/kill-switch", { stop });
      await overview.reload();
    } catch (e) {
      setKillError(e instanceof Error ? e.message : String(e));
    } finally {
      setKillBusy(false);
    }
  }

  const page = (() => {
    switch (route.page) {
      case "sources":
        return <Sources />;
      case "candidates":
        return <Candidates navigate={navigate} />;
      case "drafts":
        return <Drafts id={route.id} navigate={navigate} />;
      case "queue":
        return <Queue navigate={navigate} />;
      case "published":
        return <Published />;
      case "replies":
        return <Replies id={route.id} navigate={navigate} />;
      case "discovery":
        return <Discovery navigate={navigate} />;
      case "images":
        return <Images navigate={navigate} />;
      case "analytics":
        return <Analytics />;
      case "voice":
        return <Voice />;
      case "prompts":
        return <Prompts />;
      case "settings":
        return <SettingsPage onSaved={() => void overview.reload()} />;
      case "logs":
        return <Logs />;
      default:
        return <Overview data={o} error={overview.error} navigate={navigate} reload={() => void overview.reload()} />;
    }
  })();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <a href="/" className="brand-name" style={{ color: "inherit" }}>Гудини</a>
          <span className="brand-sub">/ Threads</span>
        </div>
        <nav className="nav">
          {PAGES.map((p) => {
            const n = o && p.badge ? p.badge(o) : 0;
            return (
              <a key={p.id} href={`${p.id}`} className={route.page === p.id ? "active" : ""} onClick={(e) => { e.preventDefault(); navigate(p.id); }}>
                <span>{p.label}</span>
                {n > 0 && <span className="count">{n}</span>}
              </a>
            );
          })}
        </nav>
      </aside>
      <main className="main">
        <div className="topbar">
          <div className="topbar-left">
            <h1 className="page-title">{PAGES.find((p) => p.id === route.page)?.label ?? "Overview"}</h1>
            {o && <Badge tone={o.mode === "AUTO" ? "success" : o.mode === "OFF" ? "error" : "accent"}>режим {o.mode}</Badge>}
            {o?.dryRun && <Badge tone="warn" title="Threads только читается; publish/reply пишутся в лог">DRY_RUN</Badge>}
            {o?.killSwitch && <Badge tone="error">STOPPED</Badge>}
            {o?.account && <Badge>@{o.account.username}</Badge>}
            {o && !o.health.threads.ok && <Badge tone="warn" title={o.health.threads.message}>Threads: нет токена</Badge>}
          </div>
          <button className={`kill ${o?.killSwitch ? "active" : ""}`} onClick={() => void toggleKill()} disabled={killBusy || !o}>
            {o?.killSwitch ? "ВОЗОБНОВИТЬ АВТОПИЛОТ" : "STOP AUTOPILOT"}
          </button>
        </div>
        <ErrorBox text={killError} />
        {page}
      </main>
    </div>
  );
}

export { get, post };
