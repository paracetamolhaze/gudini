"use client";

import Link from "next/link";
import type { ReactNode, ButtonHTMLAttributes } from "react";

/* ---------- Кнопка: одна главная, остальные второстепенные ---------- */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  busy?: boolean;
  block?: boolean;
};
export function Button({ variant = "primary", size = "md", busy, block, className, children, disabled, ...rest }: ButtonProps) {
  const cls = [
    "btn",
    variant === "secondary" ? "btn-secondary" : variant === "ghost" ? "btn-ghost" : variant === "danger" ? "btn-danger" : "",
    size === "sm" ? "btn-sm" : "",
    block ? "btn-block" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <span className="spin" aria-hidden />}
      {children}
    </button>
  );
}

/* ---------- Поле формы ---------- */
export function Field({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {note && <div className="field-note">{note}</div>}
    </label>
  );
}

/* ---------- Статус ---------- */
export type StatusTone = "neutral" | "success" | "warn" | "error" | "accent";
export function StatusBadge({ tone = "neutral", busy, children }: { tone?: StatusTone; busy?: boolean; children: ReactNode }) {
  return <span className={`status ${tone === "neutral" ? "" : tone} ${busy ? "busy" : ""}`.trim()}>{children}</span>;
}

/* ---------- Пустой список и ошибка загрузки: разные состояния ---------- */
export function EmptyState({ title, text, action }: { title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div style={{ fontSize: 16, color: "var(--text)", fontWeight: 600 }}>{title}</div>
      {text && <div className="hint" style={{ marginTop: 6 }}>{text}</div>}
      {action && <div className="actions" style={{ justifyContent: "center" }}>{action}</div>}
    </div>
  );
}

export function ErrorState({ title, text, onRetry, retryLabel = "Повторить", busy }: { title: string; text?: ReactNode; onRetry?: () => void; retryLabel?: string; busy?: boolean }) {
  return (
    <div className="error-box plain" role="alert">
      <div style={{ fontWeight: 600, color: "var(--error)" }}>{title}</div>
      {text && <div style={{ marginTop: 4 }}>{text}</div>}
      {onRetry && (
        <div className="actions" style={{ marginTop: 10 }}>
          <Button variant="secondary" size="sm" onClick={onRetry} busy={busy}>
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------- Превью 9:16: ничего не растягиваем и не обрезаем ---------- */
export function VideoPreview({ src, poster, title, caption, empty }: { src?: string | null; poster?: string; title?: ReactNode; caption?: ReactNode; empty?: ReactNode }) {
  return (
    <div className="preview-box">
      {title && <div className="preview-title">{title}</div>}
      {src ? (
        <video key={src} src={src} poster={poster} controls playsInline preload="metadata" className="video-preview" />
      ) : (
        <div className="preview-empty">{empty ?? "Видео ещё нет"}</div>
      )}
      {caption && <div className="hint" style={{ marginTop: 10, textAlign: "center" }}>{caption}</div>}
    </div>
  );
}

/* ---------- Свёрнутые технические сведения ---------- */
export function TechDetails({ summary = "Технические сведения", children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="tech">
      <summary>{summary}</summary>
      <div className="tech-body">{children}</div>
    </details>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="back-link">
      <span aria-hidden>←</span> {children}
    </Link>
  );
}
