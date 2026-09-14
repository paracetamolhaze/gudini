"use client";
import { useEffect, useRef, useState } from "react";
import { Button, StatusBadge } from "./ui";

type Job = { id: string; projectId: string; caption: string; status: string; message: string; url?: string; scheduledAt: string };
type State = { connected: boolean; autoPublish: boolean; login: boolean; busy: boolean; error: string; jobs: Job[] };
export default function TikTokBrowserSettings() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState("");
  const [text, setText] = useState("");
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const requests = useRef<Promise<unknown>>(Promise.resolve());
  async function send(action: string, body?: unknown) {
    const r = await fetch(`/api/tiktok/browser/${action}`, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "TikTok недоступен");
    return data;
  }
  function request(action: string, body?: unknown): Promise<any> {
    const pending = requests.current.catch(() => {}).then(() => send(action, body));
    requests.current = pending;
    return pending;
  }
  async function refresh() {
    const next = await request("status"); setState(next);
    if (next.login) { const frame = await request("frame"); setImage(`data:image/jpeg;base64,${frame.image}`); }
    else setImage("");
  }
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (!busy) await refresh(); } catch (e) { if (!stopped) setError(String((e as Error).message)); }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [busy]);
  async function act(action: string, body: unknown = {}) {
    setBusy(true); setError("");
    try { await request(action, body); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="setting-tile" style={{ gridColumn: "1 / -1" }}>
    <div className="row"><h3>TikTok</h3><span className="spacer" />
      <StatusBadge tone={state?.connected ? "success" : "neutral"}>{state?.connected ? "Сессия подключена" : "Нужен вход"}</StatusBadge>
    </div>
    <p className="hint">Публикация идёт в отдельном фоновом браузере. Ваш браузер и мышь свободны.</p>
    {(error || state?.error) && <p role="alert" className="error-box">{error || state?.error}</p>}
    <div className="actions">
      <Button size="sm" busy={busy} disabled={busy || state?.busy} onClick={() => void act("login")}>{state?.connected ? "Проверить вход" : "Подключить TikTok"}</Button>
      {state?.connected && <Button size="sm" variant="ghost" disabled={busy || state.busy} onClick={() => void act("disconnect")}>Отключить</Button>}
    </div>
    {state?.login && <div style={{ marginTop: 16 }}>
      <p>Войдите в TikTok ниже. Удобнее выбрать <b>Use QR code</b> и отсканировать код приложением TikTok. Затем нажмите «Я вошёл».</p>
      {image && <img src={image} draggable={false} alt="Окно входа в отдельную сессию TikTok" style={{ width: "100%", maxWidth: 960, cursor: "pointer", borderRadius: 8, touchAction: "none" }}
        onPointerDown={e => { if (busy) return; e.currentTarget.setPointerCapture(e.pointerId); const r = e.currentTarget.getBoundingClientRect(); pointer.current = { x: (e.clientX - r.left) * 1280 / r.width, y: (e.clientY - r.top) * 900 / r.height }; }}
        onPointerCancel={() => { pointer.current = null; }}
        onPointerUp={e => {
          const from = pointer.current; pointer.current = null; if (!from || busy) return;
          const r = e.currentTarget.getBoundingClientRect(); const toX = Math.max(0, Math.min(1280, (e.clientX - r.left) * 1280 / r.width)); const toY = Math.max(0, Math.min(900, (e.clientY - r.top) * 900 / r.height));
          void act("input", Math.hypot(toX - from.x, toY - from.y) > 5 ? { type: "drag", ...from, toX, toY } : { type: "click", ...from });
        }} />}
      <details><summary>Ввод с клавиатуры и прокрутка</summary>
        <p className="hint">Сначала нажмите нужное поле в окне выше, затем введите текст здесь и отправьте его в поле.</p>
        <input aria-label="Текст для выбранного поля TikTok" type="password" value={text} onChange={e => setText(e.target.value)} autoComplete="off" />
        <div className="actions"><Button size="sm" disabled={busy || !text} onClick={() => { void act("input", { type: "text", text }); setText(""); }}>Ввести</Button>
          {["Tab", "Enter", "Backspace", "Escape"].map(key => <Button key={key} size="sm" variant="secondary" disabled={busy} onClick={() => void act("input", { type: "key", key })}>{key}</Button>)}
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act("input", { type: "scroll", dy: 500 })}>Вниз</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act("input", { type: "scroll", dy: -500 })}>Вверх</Button>
        </div>
      </details>
      <div className="actions"><Button disabled={busy} onClick={() => void act("finish")}>Я вошёл — проверить подключение</Button>
        <Button variant="secondary" disabled={busy} onClick={() => void act("close")}>Закрыть окно</Button></div>
    </div>}
    {state?.connected && <label style={{ display: "block", marginTop: 16 }}>
      <input type="checkbox" checked={state.autoPublish} disabled={busy} onChange={e => void act("settings", { autoPublish: e.target.checked })} />{" "}
      Автоматически публиковать новые готовые ролики для всех зрителей
      <p className="hint">С описанием, хэштегами и обложкой проекта. Уже готовые ролики не затрагиваются. Запланировать конкретный ролик можно на его странице.</p>
    </label>}
    {state && state.jobs.length > 0 && <details style={{ marginTop: 16 }}><summary>Очередь и последние публикации ({state.jobs.length})</summary>
      {state.jobs.map(job => <div className="state-box" key={job.id} style={{ marginTop: 8 }}>
        <a href={`/project/${job.projectId}`}>{job.caption.split("\n")[0]}</a>
        <p>{job.message}</p>
        {job.status === "queued" && <p className="hint">Запуск: {new Date(job.scheduledAt).toLocaleString()}</p>}
        {job.url && <a href={job.url} target="_blank" rel="noreferrer">Открыть публикацию</a>}
        {["queued", "needs_login"].includes(job.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("cancel", { id: job.id })}>Отменить публикацию</Button>}
        {job.status === "unknown" && <div className="actions">
          <a href="https://www.tiktok.com/tiktokstudio/content" target="_blank" rel="noreferrer">Проверить TikTok Studio</a>
          <Button size="sm" disabled={busy} onClick={() => void act("resolve", { id: job.id, result: "published" })}>Проверил: опубликовано</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act("resolve", { id: job.id, result: "error" })}>Проверил: публикации нет</Button>
        </div>}
      </div>)}
    </details>}
  </div>;
}
