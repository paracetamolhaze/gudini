import { useCallback, useEffect, useRef, useState } from "react";
import { get, post } from "./api";
import { Button, ErrorBox } from "./ui";

/**
 * Sign-in window for X. What you see is the real page inside our browser container: frames come out
 * as pictures, your clicks and typing go straight back in. Nothing you type is stored or read by the
 * service — X receives it exactly as it would from a normal browser.
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

const W = 1280;
const H = 900;
const KEYS = ["Tab", "Enter", "Backspace", "Escape", "ArrowDown", "ArrowUp"] as const;

export function XConnect({ status, onChanged }: { status: XStatus | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [frame, setFrame] = useState<string>("");
  const [url, setUrl] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [typed, setTyped] = useState<string>("");
  const img = useRef<HTMLImageElement | null>(null);

  const pull = useCallback(async () => {
    try {
      const f = await get<{ image: string; url: string }>("/x-browser/frame");
      setFrame(f.image);
      setUrl(f.url);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void pull();
    const t = setInterval(() => void pull(), 1200);
    return () => clearInterval(t);
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

  const send = (body: Record<string, unknown>) => run("", () => post("/x-browser/input", body), () => void pull());

  function click(e: React.MouseEvent<HTMLImageElement>) {
    const box = img.current?.getBoundingClientRect();
    if (!box) return;
    // The picture is scaled to fit; the browser inside still lives at its own size.
    const x = Math.round(((e.clientX - box.left) / box.width) * W);
    const y = Math.round(((e.clientY - box.top) / box.height) * H);
    void send({ type: "click", x, y });
  }

  if (status?.transport === "api") return null;

  return (
    <div className="xconn">
      <div className="xconn-row">
        {status?.connected ? (
          <>
            <Button tone="ghost" busy={busy === "disconnect"} onClick={() => void run("disconnect", () => post("/x-browser/disconnect"), onChanged)}>
              Отключить X
            </Button>
            <Button
              tone="ghost"
              busy={busy === "login"}
              onClick={() =>
                void run("login", () => post("/x-browser/login"), () => {
                  setOpen(true);
                  onChanged();
                })
              }
            >
              Открыть окно браузера
            </Button>
          </>
        ) : (
          <Button
            tone="primary"
            busy={busy === "login"}
            onClick={() =>
              void run("login", () => post("/x-browser/login"), () => {
                setOpen(true);
                onChanged();
              })
            }
          >
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
            Это настоящая страница X внутри нашего браузера. Войдите как обычно — пароль идёт прямо в X, мы его не видим и не храним. Кадр обновляется раз в секунду, поэтому ввод отзывается с небольшой задержкой.
          </p>
          <div className="xconn-url small muted">{url}</div>
          {frame ? (
            <img ref={img} className="xconn-frame" src={`data:image/jpeg;base64,${frame}`} alt="Окно браузера X" onClick={click} />
          ) : (
            <p className="muted">Открываю браузер…</p>
          )}
          <div className="xconn-input">
            <input
              value={typed}
              placeholder="Текст для страницы — отправится в поле, по которому вы кликнули"
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
