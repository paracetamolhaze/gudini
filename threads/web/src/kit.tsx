import type { ReactNode } from "react";

/** Pieces of the two-platform dashboard: icons, platform marks, segmented control, numbers. */
export type PlatformId = "threads" | "x";
export type PlatformFilter = "" | PlatformId;
export const PLATFORM_LABEL: Record<PlatformId, string> = { threads: "Threads", x: "X" };

const ICONS: Record<string, ReactNode> = {
  home: <path d="M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10" />,
  posts: <path d="M4 5h16M4 10h16M4 15h10M17.5 14.5l3 3-5 5-3.5.5.5-3.5z" />,
  trades: <path d="M6 4v4m0 8v4M6 8h0a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 6 16h0a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 6 8Zm6-5v3m0 9v6m0-15h0a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12 15h0a1.5 1.5 0 0 1-1.5-1.5v-6A1.5 1.5 0 0 1 12 6Zm6 1v4m0 6v3m0-9h0a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 18 17h0a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 18 11Z" />,
  market: <path d="M3 17l5.5-6 4 3.5L21 6m0 0h-5m5 0v5" />,
  replies: <path d="M20 12a8 8 0 0 1-11.8 7L4 20l1.1-3.9A8 8 0 1 1 20 12Z" />,
  discovery: <path d="M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Zm5-1.5L20 20" />,
  settings: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7.6 7.6 0 0 0-2-1.2L14.6 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.4-.9c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c0-.4.1-.8.1-1.2Z" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
  pause: <path d="M8 5v14M16 5v14" strokeWidth="2.4" />,
  play: <path d="M7 5l12 7-12 7z" />,
  refresh: <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />,
  external: <path d="M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" strokeWidth="2.2" />,
  alert: <path d="M12 8v5m0 3.5h.01M10.3 4l-7 12.2A2 2 0 0 0 5 19.2h14a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0Z" />,
  image: <path d="M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15.5 9.5h.01" />,
  close: <path d="M6 6l12 12M18 6L6 18" strokeWidth="2" />,
};

export function Icon({ name, size = 18 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name] ?? null}
    </svg>
  );
}

/** Platform mark: a neutral glyph, not a brand logo. */
export function PlatformMark({ id, size = 18 }: { id: PlatformId; size?: number }) {
  return (
    <span className={`pmark pmark-${id}`} style={{ width: size, height: size, fontSize: size * 0.62 }} aria-hidden="true">
      {id === "threads" ? "@" : "X"}
    </span>
  );
}

export type ChipState = "idle" | "ok" | "fail" | "wait" | "off";

export function PlatformChip({ id, state = "idle", title, href }: { id: PlatformId; state?: ChipState; title?: string; href?: string | null }) {
  const body = (
    <>
      <PlatformMark id={id} size={16} />
      <span>{PLATFORM_LABEL[id]}</span>
      {state === "ok" && <Icon name="check" size={13} />}
      {state === "fail" && <Icon name="alert" size={13} />}
    </>
  );
  return href ? (
    <a className={`pchip pchip-${state}`} href={href} target="_blank" rel="noreferrer" title={title ?? "Открыть публикацию"}>
      {body}
    </a>
  ) : (
    <span className={`pchip pchip-${state}`} title={title}>
      {body}
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? "on" : ""} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PlatformFilterControl({ value, onChange }: { value: PlatformFilter; onChange: (v: PlatformFilter) => void }) {
  return (
    <Segmented<PlatformFilter>
      label="Площадка"
      value={value}
      onChange={onChange}
      options={[
        { value: "", label: "Все" },
        { value: "threads", label: <><PlatformMark id="threads" size={15} /> Threads</> },
        { value: "x", label: <><PlatformMark id="x" size={15} /> X</> },
      ]}
    />
  );
}

export function Pct({ value, digits = 1 }: { value: number | null | undefined; digits?: number }) {
  if (value === null || value === undefined) return <span className="dim">—</span>;
  return <span className={value >= 0 ? "num-up" : "num-down"}>{`${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`}</span>;
}

export function Usd({ value, signed = false }: { value: number | null | undefined; signed?: boolean }) {
  if (value === null || value === undefined) return <span className="dim">—</span>;
  const abs = Math.abs(value);
  const body = abs >= 1000 ? Math.round(abs).toLocaleString("ru-RU") : abs.toFixed(2);
  const text = `${value < 0 ? "−" : signed ? "+" : ""}$${body}`;
  return signed ? <span className={value >= 0 ? "num-up" : "num-down"}>{text}</span> : <span>{text}</span>;
}

export const fmtPrice = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return "—";
  const abs = Math.abs(v);
  return v.toLocaleString("ru-RU", { maximumFractionDigits: abs >= 1000 ? 1 : abs >= 1 ? 3 : 6 });
};

export const fmtHeld = (from: string, to: string | null): string => {
  if (!to) return "открыта";
  const m = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d}д ${h}ч` : h > 0 ? `${h}ч ${m % 60}м` : `${m}м`;
};

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
