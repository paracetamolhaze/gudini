import { useCallback, useEffect, useRef, useState } from "react";
import { get, post } from "./api";
import { Button, ErrorBox } from "./ui";

/**
 * Sign-in window for X. What you see is the real page inside our browser container: frames come out
 * as pictures, your clicks and typing go straight back in. Nothing you type is stored or read by the
 * service — X receives it exactly as it would from a normal browser.
 *
 * Only one command can touch the browser at a time, so the window never has two requests in the air:
 * a click answers with the page as it looks after it, and the idle refresh pauses while you act.
 */
export type XStatus = {
  transport: "browser" | "api";
  connected: boolean;
  username: string | null;
  login: boolean;
  busy: boolean;
  issue: string | null;
  error: string;
};

type Frame = { image: string; url: string };

const W = 1280;
const H = 900;
const KEYS = ["Enter", "Tab", "Backspace", "Escape", "ArrowDown", "ArrowUp"] as const;
/** Keys the page needs verbatim; everything else printable travels as text. */
const SPECIAL: Record<string, string> = { Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Escape: "Escape", ArrowDown: "ArrowDown", ArrowUp: "ArrowUp", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight" };

export function XConnect({ status, onChanged }: { status: XStatus | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [typed, setTyped] = useState<string>("");
  const img = useRef<HTMLImageElement | null>(null);
  /** One request at a time, and typed characters batched so a password is not 12 round trips. */
  const inFlight = useRef(false);
  const buffer = useRef<string>("");
  const flushTimer = useRef<number | null>(null);

  const show = (f: Frame) => {
    setFrame(f);
    setError("");
  };

  const pull = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      show(await get<Frame>("/x-browser/frame"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
    }
  }, []);

  const send = useCallback(async (body: Record<string, unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      show(await post<Frame>("/x-browser/input", body));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
    }
  }, []);

  const flush = useCallback(() => {
    const text = buffer.current;
    buffer.current = "";
    if (flushTimer.current) window.clearTimeout(flushTimer.current);
    flushTimer.current = null;
    if (text) void send({ type: "text", text });
  }, [send]);

  useEffect(() => {
    if (!open) return;
    void pull();
    const t = window.setInterval(() => void pull(), 1500);
    return () => window.clearInterval(t);
  }, [open, pull]);

  async function run(what: string, fn: () => Promise<unknown>, after?: () => void) {
    setBusy(what);
    setError("");
    try {
      await fn();
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  function click(e: React.MouseEvent<HTMLImageElement>) {
    const box = img.current?.getBoundingClientRect();
    if (!box) return;
    flush();
    // The picture is scaled to fit; the browser inside still lives at its own size.
    const x = Math.round(((e.clientX - box.left) / box.width) * W);
    const y = Math.round(((e.clientY - box.top) / box.height) * H);
    img.current?.focus();
    void send({ type: "click", x, y });
  }

  /** Type straight onto the picture, the way you would into the page itself. */
  function keyDown(e: React.KeyboardEvent<HTMLImageElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const special = SPECIAL[e.key];
    if (special) {
      e.preventDefault();
      flush();
      void send({ type: "key", key: special });
      return;
    }
    if (e.key.length !== 1) return;
    e.preventDefault();
    buffer.current += e.key;
    if (flushTimer.current) window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(flush, 180);
  }

  const openWindow = () =>
    void run("login", () => post("/x-browser/login"), () => {
      setOpen(true);
      onChanged();
    });

  if (status?.transport === "api") return null;

  return (
    <div className="xconn">
      <div className="xconn-row">
        {status?.connected ? (
          <>
            <Button tone="ghost" busy={busy === "disconnect"} onClick={() => void run("disconnect", () => post("/x-browser/disconnect"), onChanged)}>
              Отключить X
            </Button>
            <Button tone="ghost" busy={busy === "login"} onClick={openWindow}>
              Открыть окно браузера
            </Button>
          </>
        ) : (
          <Button tone="primary" busy={busy === "login"} onClick={openWindow}>
            Подключить X
          </Button>
        )}
        {open && (
          <>
            <Button
              tone="primary"
              busy={busy === "finish"}
              onClick={() =>
                void run("finish", () => post("/x-browser/finish"), () => {
                  setOpen(false);
                  onChanged();
                })
              }
            >
              Я вошёл, проверить
            </Button>
            <Button
              tone="ghost"
              busy={busy === "close"}
              onClick={() =>
                void run("close", () => post("/x-browser/close"), () => {
                  setOpen(false);
                  onChanged();
                })
              }
            >
              Закрыть окно
            </Button>
          </>
        )}
      </div>

      {open && (
        <div className="xconn-window">
          <ErrorBox text={error} />
          <p className="small muted">
            Это настоящая страница X внутри нашего браузера. Кликните по картинке и печатайте прямо с клавиатуры — буквы, Enter и Backspace уходят на страницу. Пароль идёт прямо в X: сервис его не видит и не хранит.
          </p>
          <div className="xconn-url small muted">{frame?.url ?? ""}</div>
          {frame ? (
            <img ref={img} className="xconn-frame" tabIndex={0} src={`data:image/jpeg;base64,${frame.image}`} alt="Окно браузера X" onClick={click} onKeyDown={keyDown} />
          ) : (
            <p className="muted">Открываю браузер…</p>
          )}
          <div className="xconn-input">
            <input
              value={typed}
              placeholder="Если печатать по картинке не выходит — впишите текст сюда"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !typed) return;
                e.preventDefault();
                const text = typed;
                setTyped("");
                void send({ type: "text", text });
              }}
            />
            <Button
              tone="ghost"
              disabled={!typed}
              onClick={() => {
                const text = typed;
                setTyped("");
                void send({ type: "text", text });
              }}
            >
              Ввести
            </Button>
          </div>
          <div className="xconn-keys">
            {KEYS.map((k) => (
              <button key={k} className="btn btn-ghost btn-sm" onClick={() => void send({ type: "key", key: k })}>
                {k}
              </button>
            ))}
            <button className="btn btn-ghost btn-sm" onClick={() => void send({ type: "scroll", dy: 400 })}>
              ниже
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void send({ type: "scroll", dy: -400 })}>
              выше
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void send({ type: "back" })}>
              назад
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void pull()}>
              обновить кадр
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
