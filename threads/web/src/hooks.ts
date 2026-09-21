import { useCallback, useEffect, useRef, useState } from "react";
import { get, PREFIX } from "./api";

/** GET with polling; `key` re-fetches when it changes. Errors are kept alongside stale data. */
export function useFetch<T>(path: string | null, opts: { intervalMs?: number; key?: unknown } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(Boolean(path));
  const alive = useRef(true);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const d = await get<T>(path);
      if (alive.current) {
        setData(d);
        setError("");
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    setLoading(Boolean(path));
    void reload();
    const t = opts.intervalMs && path ? setInterval(() => void reload(), opts.intervalMs) : null;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reload, opts.intervalMs, JSON.stringify(opts.key ?? null)]);
  return { data, error, loading, reload };
}

export type Route = { page: string; id: string | null; query: URLSearchParams };

function parse(): Route {
  const rel = window.location.pathname.startsWith(PREFIX) ? window.location.pathname.slice(PREFIX.length) : window.location.pathname;
  const parts = rel.split("/").filter(Boolean);
  return { page: parts[0] ?? "home", id: parts[1] ?? null, query: new URLSearchParams(window.location.search) };
}

export function useRoute(): [Route, (path: string) => void] {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onPop = () => setRoute(parse());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((path: string) => {
    const target = path.startsWith("/") ? `${PREFIX}${path}` : `${PREFIX}/${path}`;
    window.history.pushState(null, "", target);
    setRoute(parse());
  }, []);
  return [route, navigate];
}

export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // `done` is for actions that only put work in a queue: saying "готово" there would be a lie.
  const run = useCallback(async (label: string, fn: () => Promise<unknown>, after?: () => void | Promise<void>, opts: { done?: string } = {}) => {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(opts.done ?? `${label}: готово`);
      await after?.();
      setTimeout(() => setNotice(""), 2500);
    } catch (e) {
      setError(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, notice, run, setError };
}

/** Queue state of the post asked for one row; `at` changes only when a new job starts. */
export type RowJob = { state: "QUEUED" | "RUNNING" | "DONE" | "FAILED"; error: string | null; at: string } | null;

/**
 * Honest per-row state for "написать пост". A click is remembered until the queue reports a job newer
 * than the one that was there at the time, so the row says "пишется…" straight away, never shows the
 * previous failure as the new one, and shows the real reason when the job dies.
 */
export function useJobRows() {
  const [seen, setSeen] = useState<Record<string, string>>({});
  const mark = useCallback((id: string, job: RowJob) => setSeen((prev) => ({ ...prev, [id]: job?.at ?? "" })), []);
  const state = useCallback(
    (id: string, job: RowJob, done: boolean): { writing: boolean; error: string } => {
      const clicked = seen[id];
      const fresh = clicked !== undefined && (job?.at ?? "") === clicked ? null : job;
      const writing = !done && (fresh ? fresh.state === "QUEUED" || fresh.state === "RUNNING" : clicked !== undefined);
      return { writing, error: !done && fresh?.state === "FAILED" ? fresh.error || "задача упала без объяснения" : "" };
    },
    [seen],
  );
  return { mark, state };
}

export const fmtDate = (v: string | Date | null | undefined): string => {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

export const fmtNum = (n: number | null | undefined, digits = 0): string => (n === null || n === undefined || Number.isNaN(n) ? "—" : n.toLocaleString("ru-RU", { maximumFractionDigits: digits }));
export const fmtUsd = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : `$${n.toFixed(n < 1 ? 4 : 2)}`);
export const fmtPct = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);
