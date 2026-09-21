import { useEffect } from "react";
import { post, PREFIX } from "./api";
import { useFetch, useRoute, useAction } from "./hooks";
import { Button, ErrorBox } from "./ui";
import Posts from "./pages/Posts";
import Conversations from "./pages/Conversations";
import SimpleSettings from "./pages/SimpleSettings";
import Overview from "./pages/Overview";
import Settings from "./pages/Settings";
import Sources from "./pages/Sources";
import Voice from "./pages/Voice";
import Logs from "./pages/Logs";
import Replies from "./pages/Replies";
import Candidates from "./pages/Candidates";
import Prompts from "./pages/Prompts";
import Analytics from "./pages/Analytics";
import Images from "./pages/Images";
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
  readiness: { llmKey: boolean; publicBaseUrl: boolean; lastSourceCheckAt: string | null; lastSourcePostAt: string | null; lastDraftAt: string | null };
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }>;
};


export default function App() {
  const [route, navigate] = useRoute();
  const overview = useFetch<OverviewData>("/overview", { intervalMs: 15000 });
  const act = useAction();
  const o = overview.data;
  const titles: Record<string,string> = { posts: "Посты", drafts: "Посты", replies: "Ответы мне", discovery: "Чужие посты", settings: "Настройки", advanced: "Подключение", voice: "Стиль общения", sources: "Источники", logs: "История действий", overview: "Подключение", candidates: "Найденные темы", prompts: "Промпты", analytics: "Статистика", images: "Изображения" };
  const title = titles[route.page] ?? "Посты";
  useEffect(() => { document.title = `${title} · Threads · Гудини`; }, [title]);
  const nav = [["posts", "Посты"], ["replies", "Ответы мне"], ["discovery", "Чужие посты"]];
  const page = (() => { switch(route.page) {
    case "replies": return route.id ? <Replies id={route.id} navigate={navigate} /> : <Conversations key="own" kind="own" navigate={navigate} />;
    case "discovery": return <Conversations key="public" kind="public" navigate={navigate} />;
    case "settings": return <SimpleSettings navigate={navigate} changed={() => void overview.reload()} />;
    case "advanced": return <Settings onSaved={() => void overview.reload()} />;
    case "sources": return <Sources />;
    case "voice": return <Voice />;
    case "logs": return <Logs />;
    case "prompts": return <Prompts />;
    case "candidates": return <Candidates navigate={navigate} />;
    case "analytics": return <Analytics />;
    case "images": return <Images navigate={navigate} />;
    case "overview": return <Overview data={o} error={overview.error} navigate={navigate} reload={() => void overview.reload()} />;
    default: return <Posts id={route.id} navigate={navigate} />;
  } })();
  const connected = o?.health.threads.ok && o.readiness.llmKey;
  const paused = o?.killSwitch || o?.mode === "OFF";
  return <div className="threads-shell"><header className="threads-header"><a className="brand-name" href="/">Гудини <span className="dim">/ Threads</span></a><a href={`${PREFIX}/settings`} onClick={e => { e.preventDefault(); navigate("settings"); }}>Настройки</a></header>
    <nav className="threads-nav" aria-label="Threads">{nav.map(([id,label]) => <a key={id} href={`${PREFIX}/${id}`} className={route.page === id || (id === "posts" && ["drafts","queue","published"].includes(route.page)) ? "active" : ""} onClick={e => { e.preventDefault(); navigate(id!); }}>{label}</a>)}</nav>
    <main className="threads-main"><div className="workspace-heading"><h1>{title}</h1>{o && <Button tone="ghost" busy={act.busy !== null} onClick={() => void act.run("Режим изменён", async () => { if (o.mode === "OFF") await post("/mode", { mode: "AUTO" }); await post("/kill-switch", { stop: !paused }); }, overview.reload)}>{paused ? "Возобновить" : "Пауза"}</Button>}</div>
      <ErrorBox text={act.error || overview.error} />
      {o && <div className={`automation-status ${connected && !paused && !o.dryRun ? "running" : ""}`}><span className="status-dot" /><span>{!connected ? (!o.health.threads.ok ? "Подключите Threads для публикаций и автоответов" : "Подключите ИИ для написания постов") : paused ? "Автоматика на паузе" : o.dryRun ? "Пробный запуск — отправки выключены" : `Ответы мне: ${o.mode === "AUTO" && o.flags.autoOwnReplies ? "автоматически" : "выключены"} · Чужие посты: ${o.mode === "AUTO" && o.flags.autoPublicReplies ? "автоматически" : "выключены"}`}</span>{!connected && <button className="btn btn-ghost btn-sm" onClick={() => navigate("overview")}>Подключение</button>}</div>}
      {page}
    </main></div>;
}
