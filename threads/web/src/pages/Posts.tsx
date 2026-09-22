import { useEffect, useRef, useState } from "react";
import { API, post, put } from "../api";
import { useFetch, useAction, fmtDate } from "../hooks";
import { Button, Card, Empty, ErrorBox, Notice, Status } from "../ui";
import { PLATFORM_LABEL, PlatformChip, PlatformMark, type ChipState, type PlatformFilter, type PlatformId } from "../kit";
import type { PlatformOverview } from "../App";

type Publication = { platform: PlatformId; permalink: string | null; dry_run: boolean };
type Draft = {
  id: string;
  kind: "NEWS" | "TOPIC" | "TRADE" | "MOVER";
  text: string;
  text_x: string | null;
  platforms: PlatformId[];
  status: string;
  source_summary: string | null;
  source_urls_json: string[];
  error: string | null;
  review_reason: string | null;
  scheduled_at: string | null;
  created_at: string;
  image_asset_id: string | null;
  publications?: Publication[];
};

const KIND_LABEL: Record<Draft["kind"], string> = { TRADE: "Сделка", MOVER: "Рынок", NEWS: "Новость", TOPIC: "Моя тема" };
const KINDS: Array<[string, string]> = [["", "Все"], ["TRADE", "Сделки"], ["NEWS", "Новости"], ["MOVER", "Рынок"], ["TOPIC", "Мои темы"]];
const STATUSES: Array<[string, string]> = [["", "Все"], ["GENERATING,DRAFT,NEEDS_REVIEW,FAILED,PARTIAL", "Ждут вас"], ["APPROVED,SCHEDULED,PUBLISHING", "Запланированы"], ["PUBLISHED", "Опубликованы"]];
const PLATFORMS: PlatformId[] = ["threads", "x"];

function chipState(d: Draft, p: PlatformId): { state: ChipState; href: string | null; title: string } {
  const pub = d.publications?.find((x) => x.platform === p);
  if (pub) return { state: "ok", href: pub.permalink, title: pub.dry_run ? "Пробная публикация" : "Опубликовано" };
  if (d.status === "PARTIAL" || d.status === "FAILED") return { state: "fail", href: null, title: "Не опубликовано — откройте пост" };
  return { state: "wait", href: null, title: "Ещё не опубликовано" };
}

export default function Posts({ id, navigate, platform, platforms }: { id: string | null; navigate: (p: string) => void; platform: PlatformFilter; platforms: PlatformOverview[] }) {
  const [topic, setTopic] = useState(() => {
    try {
      return localStorage.getItem("threads:topic") ?? "";
    } catch {
      return "";
    }
  });
  const ready = platforms.filter((p) => p.enabled && p.health.ok).map((p) => p.id);
  const [targets, setTargets] = useState<PlatformId[] | null>(null);
  const chosen = targets ?? (ready.length ? ready : platforms.filter((p) => p.enabled).map((p) => p.id));
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const qs = [`limit=100`, status && `status=${status}`, kind && `kind=${kind}`, platform && `platform=${platform}`].filter(Boolean).join("&");
  const items = useFetch<{ drafts: Draft[] }>(id ? null : `/drafts?${qs}`, { intervalMs: 5000 });
  const act = useAction();
  useEffect(() => {
    try {
      localStorage.setItem("threads:topic", topic);
    } catch {
      // private mode
    }
  }, [topic]);
  if (id) return <PostEditor key={id} id={id} navigate={navigate} platforms={platforms} />;

  async function create() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await post<{ id: string }>("/drafts", { topic, platforms: chosen.length ? chosen : undefined });
      setTopic("");
      navigate(`posts/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const toggle = (p: PlatformId) => setTargets(chosen.includes(p) ? chosen.filter((x) => x !== p) : [...chosen, p]);

  return (
    <>
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label className="compose-label" htmlFor="topic">О чём написать от вашего лица?</label>
          <textarea id="topic" rows={3} maxLength={1500} minLength={5} required value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Например: почему я не держу шорт через фандинг, когда толпа уже в шорте" disabled={busy} />
          <div className="compose-actions">
            <div className="target-picker" role="group" aria-label="Куда публиковать">
              {PLATFORMS.map((p) => (
                <button key={p} type="button" className={`target ${chosen.includes(p) ? "on" : ""}`} aria-pressed={chosen.includes(p)} onClick={() => toggle(p)}>
                  <PlatformMark id={p} size={16} /> {PLATFORM_LABEL[p]}
                </button>
              ))}
            </div>
            <Button type="submit" tone="primary" busy={busy} disabled={!chosen.length}>Написать пост</Button>
          </div>
          <ErrorBox text={error} />
        </form>
      </Card>

      <div className="list-head">
        <div className="chips" role="group" aria-label="Тип поста">
          {KINDS.map(([v, label]) => (
            <button key={v} className={`chip ${kind === v ? "on" : ""}`} onClick={() => setKind(v)}>{label}</button>
          ))}
        </div>
        <Button busy={act.busy !== null} onClick={() => void act.run("Поиск новостей запущен", () => post("/sources/poll"), items.reload)}>Найти свежие новости</Button>
      </div>
      <div className="tabs">
        {STATUSES.map(([v, label]) => (
          <button key={v} className={`btn ${status === v ? "on" : "btn-ghost"}`} onClick={() => setStatus(v)}>{label}</button>
        ))}
      </div>
      <Notice text={act.notice} />
      <ErrorBox text={act.error || items.error} />
      {items.loading && !items.data && <p className="muted">Загружаю посты…</p>}
      {items.data?.drafts.length === 0 && <Empty title="Здесь появятся ваши посты" text="Сделки, новости и движения рынка попадают сюда сами. Свою тему можно задать выше." />}
      <div className="post-list">
        {items.data?.drafts.map((d) => (
          <button className="post-row" key={d.id} onClick={() => navigate(`posts/${d.id}`)}>
            <div className="post-row-head">
              <span className={`kind kind-${d.kind}`}>{KIND_LABEL[d.kind] ?? d.kind}</span>
              <Status value={d.status} />
              <span className="post-row-chips">
                {d.platforms.map((p) => {
                  const c = chipState(d, p);
                  return <PlatformChip key={p} id={p} state={c.state} title={c.title} />;
                })}
              </span>
              <span className="small dim post-row-date">{fmtDate(d.scheduled_at ?? d.created_at)}</span>
            </div>
            <div className="post-row-body">
              {d.image_asset_id && <img className="post-thumb" src={`${API}/media/${d.image_asset_id}/final`} alt="" loading="lazy" />}
              <p>{d.text || d.source_summary}</p>
            </div>
            {d.error && <span className="error-text small">{d.error}</span>}
          </button>
        ))}
      </div>
    </>
  );
}

function Preview({ platform, handle, text, image, max }: { platform: PlatformId; handle: string | null; text: string; image: string | null; max: number }) {
  const over = text.length > max;
  return (
    <div className={`preview preview-${platform}`}>
      <div className="preview-head">
        <span className="preview-avatar"><PlatformMark id={platform} size={20} /></span>
        <div>
          <b>{handle ? `@${handle}` : "ваш аккаунт"}</b>
          <span className="small dim"> · {PLATFORM_LABEL[platform]}</span>
        </div>
        <span className={`counter ${over ? "counter-over" : ""}`}>{text.length} / {max}</span>
      </div>
      <p className="preview-text">{text || "…"}</p>
      {image && <img className="preview-image" src={image} alt="Карточка сделки" />}
      {over && <p className="small warn-text">Длиннее лимита — уйдёт тредом из нескольких частей.</p>}
    </div>
  );
}

function PostEditor({ id, navigate, platforms }: { id: string; navigate: (p: string) => void; platforms: PlatformOverview[] }) {
  const info = useFetch<{ draft: Draft; publications: Array<Publication & { id: string; platform_post_id: string }> }>(`/drafts/${id}`, { intervalMs: 4000 });
  const [text, setText] = useState("");
  const [textX, setTextX] = useState("");
  const [ownX, setOwnX] = useState(false);
  const [targets, setTargets] = useState<PlatformId[]>([]);
  const [dirty, setDirty] = useState(false);
  const [when, setWhen] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const act = useAction();
  const d = info.data?.draft;
  const pubs = info.data?.publications ?? [];
  useEffect(() => {
    if (d && !dirty) {
      setText(d.text);
      setTextX(d.text_x ?? "");
      setOwnX(Boolean(d.text_x));
      setTargets(d.platforms);
    }
  }, [d?.text, d?.text_x, d?.platforms.join(","), dirty]);
  const editable = Boolean(d && ["DRAFT", "NEEDS_REVIEW", "FAILED"].includes(d.status));
  const partial = d?.status === "PARTIAL";
  const limit = (p: PlatformId) => platforms.find((x) => x.id === p)?.maxChars ?? (p === "x" ? 280 : 500);
  const handle = (p: PlatformId) => platforms.find((x) => x.id === p)?.username ?? null;
  const image = d?.image_asset_id ? `${API}/media/${d.image_asset_id}/final` : null;

  async function savedAction(action: string) {
    if (dirty) {
      await put(`/drafts/${id}`, { text, textX: ownX ? textX : null, platforms: targets });
      setDirty(false);
    }
    if (action === "schedule") {
      if (!when || new Date(when) <= new Date()) throw new Error("Выберите время в будущем");
      await post(`/drafts/${id}/schedule`, { scheduledAt: new Date(when).toISOString() });
    } else if (action !== "save") await post(`/drafts/${id}/${action}`);
  }
  async function regenerate() {
    const result = await post<{ draftId?: string }>(`/drafts/${id}/regenerate`);
    if (!result.draftId) navigate("posts");
  }
  const toggle = (p: PlatformId) => {
    setTargets(targets.includes(p) ? targets.filter((x) => x !== p) : [...targets, p]);
    setDirty(true);
  };

  return (
    <>
      <Button tone="ghost" onClick={() => navigate("posts")}>← Все посты</Button>
      <ErrorBox text={info.error} />
      {d && (
        <div className="editor">
          <Card className="editor-main">
            <div className="row row-between">
              <div className="row">
                <span className={`kind kind-${d.kind}`}>{KIND_LABEL[d.kind] ?? d.kind}</span>
                <h2>{d.source_summary?.slice(0, 90) || "Ваш пост"}</h2>
              </div>
              <Status value={d.status} />
            </div>
            {d.status === "GENERATING" ? (
              <p className="generation-note" role="status">Пишу пост. Страницу можно закрыть — результат сохранится здесь.</p>
            ) : (
              <>
                <div className="target-picker" role="group" aria-label="Куда публиковать">
                  {PLATFORMS.map((p) => {
                    const pub = pubs.find((x) => x.platform === p);
                    return (
                      <button key={p} type="button" disabled={!editable || Boolean(pub)} className={`target ${targets.includes(p) ? "on" : ""}`} aria-pressed={targets.includes(p)} onClick={() => toggle(p)}>
                        <PlatformMark id={p} size={16} /> {PLATFORM_LABEL[p]}
                      </button>
                    );
                  })}
                </div>
                <label className="field-label" htmlFor="post-text">Текст{targets.includes("x") && targets.includes("threads") && !ownX ? " (для обеих площадок)" : targets.includes("threads") ? " для Threads" : " для X"}</label>
                <textarea id="post-text" className="post-editor" value={text} readOnly={!editable} onChange={(e) => { setText(e.target.value); setDirty(true); }} />
                {targets.includes("x") && (
                  <>
                    <label className="toggle small">
                      <input type="checkbox" checked={ownX} disabled={!editable} onChange={(e) => { setOwnX(e.target.checked); if (e.target.checked && !textX) setTextX(text.slice(0, limit("x"))); setDirty(true); }} />
                      <span>Отдельный короткий текст для X</span>
                    </label>
                    {ownX && <textarea aria-label="Текст для X" className="post-editor post-editor-x" value={textX} readOnly={!editable} onChange={(e) => { setTextX(e.target.value); setDirty(true); }} />}
                  </>
                )}
              </>
            )}
            <ErrorBox text={d.error ?? ""} />
            {d.review_reason && <p className="muted small">На что обратить внимание: {d.review_reason}</p>}
            {d.source_urls_json?.length > 0 && (
              <details className="conversation-parent">
                <summary>Источники поста</summary>
                {d.source_urls_json.filter((url) => /^https?:\/\//i.test(url)).map((url) => (
                  <p key={url}><a href={url} target="_blank" rel="noreferrer">{new URL(url).hostname} ↗</a></p>
                ))}
              </details>
            )}
            <ErrorBox text={act.error} />
            <Notice text={act.notice} />
            {editable && (
              <div className="compose-actions">
                <Button tone="primary" busy={act.busy !== null} disabled={!text.trim() || !targets.length} onClick={() => void act.run("Публикация запущена", () => savedAction("publish-now"), info.reload)}>Опубликовать</Button>
                <Button disabled={!text.trim() || act.busy !== null} onClick={() => setScheduling(!scheduling)}>Запланировать</Button>
                <Button disabled={!dirty || act.busy !== null} onClick={() => void act.run("Сохранено", () => savedAction("save"), info.reload)}>Сохранить</Button>
                <Button disabled={dirty || act.busy !== null || d.kind === "TRADE" || d.kind === "MOVER"} onClick={() => void act.run("Пишу заново", regenerate, info.reload)}>Написать заново</Button>
                <Button tone="ghost" disabled={act.busy !== null} onClick={() => void act.run("Отклонено", () => post(`/drafts/${id}/reject`), () => navigate("posts"))}>Отклонить</Button>
              </div>
            )}
            {d && ["APPROVED", "SCHEDULED"].includes(d.status) && (
              <div className="compose-actions">
                <Button busy={act.busy !== null} onClick={() => void act.run("Вернули в черновики", () => post(`/drafts/${id}/unschedule`), info.reload)}>Вернуть в черновики</Button>
                <Button tone="ghost" disabled={act.busy !== null} onClick={() => void act.run("Отклонено", () => post(`/drafts/${id}/reject`), () => navigate("posts"))}>Отклонить</Button>
                <span className="small muted">Пока пост в очереди, текст не редактируется — верните его в черновики.</span>
              </div>
            )}
            {partial && (
              <div className="compose-actions">
                <Button tone="primary" busy={act.busy !== null} onClick={() => void act.run("Повторная отправка запущена", () => post(`/drafts/${id}/publish-now`), info.reload)}>Дослать туда, куда не дошло</Button>
                <span className="small muted">Уже опубликованное повторно не отправляется.</span>
              </div>
            )}
            {editable && scheduling && (
              <div className="compose-actions">
                <label>Дата и время <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
                <Button busy={act.busy !== null} onClick={() => void act.run("Запланировано", () => savedAction("schedule"), info.reload)}>Назначить время</Button>
              </div>
            )}
            {d.scheduled_at && d.status === "SCHEDULED" && <p className="muted">Публикация: {fmtDate(d.scheduled_at)}</p>}
            {pubs.length > 0 && (
              <div className="row">
                {pubs.map((p) => (
                  <PlatformChip key={p.platform} id={p.platform} state="ok" href={p.permalink} title={p.dry_run ? "Пробная публикация — в сеть не отправлялась" : "Открыть публикацию"} />
                ))}
              </div>
            )}
          </Card>
          <aside className="editor-side" aria-label="Как это будет выглядеть">
            <div className="side-title">Как это будет выглядеть</div>
            {(targets.length ? targets : d.platforms).map((p) => (
              <Preview key={p} platform={p} handle={handle(p)} text={p === "x" && ownX && textX.trim() ? textX : text} image={image} max={limit(p)} />
            ))}
          </aside>
        </div>
      )}
    </>
  );
}
