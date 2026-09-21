import type { ReactNode } from "react";

export type Tone = "neutral" | "success" | "warn" | "error" | "accent";

export function Button({ tone = "default", size = "md", busy, children, className = "", ...rest }: { tone?: "default" | "primary" | "danger" | "ghost"; size?: "sm" | "md"; busy?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`btn btn-${tone} btn-${size} ${className}`} {...rest} disabled={busy || rest.disabled}>
      {busy ? "…" : children}
    </button>
  );
}

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export const STATUS_TONE: Record<string, Tone> = {
  OK: "success",
  PUBLISHED: "success",
  SENT: "success",
  QA_PASSED: "success",
  VERIFIED: "success",
  APPROVED: "accent",
  SCHEDULED: "accent",
  APPROVED_FOR_GENERATION: "accent",
  GENERATED: "accent",
  QUEUED: "accent",
  PUBLISHING: "accent",
  SENDING: "accent",
  GENERATING: "accent",
  ANALYZING: "accent",
  CANDIDATE: "accent",
  RENDERED: "accent",
  NEEDS_REVIEW: "warn",
  PERMISSION_REQUIRED: "warn",
  RATE_LIMITED: "warn",
  UNVERIFIED: "warn",
  REJECTED: "error",
  FAILED: "error",
  ERROR: "error",
  CONTRADICTED: "error",
};

/** Russian captions for technical statuses; the raw value stays in the tooltip. */
export const STATUS_LABEL: Record<string, string> = {
  OK: "ок",
  NEW: "новый",
  ANALYZING: "анализируется",
  ANALYZED: "проанализирован",
  DUPLICATE: "дубликат",
  CANDIDATE: "кандидат",
  DISCOVERED: "найден",
  APPROVED_FOR_GENERATION: "к генерации",
  GENERATING: "пишется",
  GENERATED: "черновик создан",
  REJECTED: "отклонён",
  EXPIRED: "просрочен",
  FAILED: "ошибка",
  ERROR: "ошибка",
  DRAFT: "черновик",
  NEEDS_REVIEW: "нужна проверка",
  APPROVED: "одобрен",
  SCHEDULED: "запланирован",
  PUBLISHING: "публикуется",
  PUBLISHED: "опубликован",
  PENDING: "ожидает решения",
  SENDING: "отправляется",
  SENT: "отправлен",
  SKIPPED: "пропущен",
  FOUND: "найден",
  QUEUED: "в очереди",
  QA_PASSED: "QA пройден",
  RENDERED: "отрисован",
  DOWNLOADED: "загружен",
  OCR_DONE: "распознан",
  TRANSLATED: "переведён",
  VERIFIED: "подтверждено",
  UNVERIFIED: "не подтверждено",
  CONTRADICTED: "противоречит рынку",
  NOT_CHECKABLE: "не проверяемо",
  PERMISSION_REQUIRED: "нужно разрешение API",
  RATE_LIMITED: "лимит API",
  DISABLED: "выключен",
  PROPOSED: "предложено",
  ACCEPTED: "принято",
  FACT: "факт",
  OPINION: "мнение",
  RUMOR: "слух",
  PREDICTION: "прогноз",
};

export const MODE_LABEL: Record<string, string> = { OFF: "выключен", DRAFT: "только черновики", REVIEW: "на одобрение", AUTO: "автопилот" };
export const TYPE_LABEL: Record<string, string> = {
  THREADS_PROFILE: "профиль Threads",
  THREADS_SEARCH: "поиск Threads",
  RSS: "RSS",
  NEWS: "новости",
  MANUAL: "вручную",
  OWN_POST_REPLY: "комментарий под нашим постом",
  NESTED_REPLY: "ответ в ветке",
  MENTION: "упоминание",
  PUBLIC_POST_REPLY: "чужой пост",
  NEWS_POST: "новость",
  OPINION: "мнение",
  EXPLAINER: "разбор",
  HOT_TAKE: "тезис",
  SHORT: "коротко",
  SKIP: "пропустить",
  REPLY: "ответить",
  REPLY_AND_QUESTION: "ответить и спросить",
};

export function Status({ value }: { value: string | null | undefined }) {
  if (!value) return <Badge>—</Badge>;
  return (
    <Badge tone={STATUS_TONE[value] ?? "neutral"} title={value}>
      {STATUS_LABEL[value] ?? value}
    </Badge>
  );
}

export function Label({ value, tone = "neutral" }: { value: string | null | undefined; tone?: Tone }) {
  if (!value) return null;
  return (
    <Badge tone={tone} title={value}>
      {TYPE_LABEL[value] ?? STATUS_LABEL[value] ?? value}
    </Badge>
  );
}

export function Card({ title, children, actions, className = "" }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2 className="card-title">{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {note && <span className="field-note">{note}</span>}
    </label>
  );
}

export function Empty({ title, text }: { title: string; text?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {text && <div className="empty-text">{text}</div>}
    </div>
  );
}

export function ErrorBox({ text }: { text: string }) {
  return text ? <div className="error-box">{text}</div> : null;
}

export function Notice({ text }: { text: string }) {
  return text ? <div className="notice-box">{text}</div> : null;
}

export function Score({ label, value }: { label: string; value: number | null | undefined }) {
  const v = value === null || value === undefined ? null : Math.max(0, Math.min(100, Number(value)));
  return (
    <div className="score" title={label}>
      <span className="score-label">{label}</span>
      <span className="score-bar">
        <span className="score-fill" style={{ width: `${v ?? 0}%` }} />
      </span>
      <span className="score-value">{v === null ? "—" : Math.round(v)}</span>
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Readiness row: green check or the exact thing to do. */
export function Check({ ok, label, hint }: { ok: boolean; label: string; hint?: ReactNode }) {
  return (
    <div className={`check ${ok ? "check-ok" : "check-bad"}`}>
      <span className="check-mark">{ok ? "✓" : "✗"}</span>
      <span>
        <span className="check-label">{label}</span>
        {!ok && hint && <span className="check-hint">{hint}</span>}
      </span>
    </div>
  );
}
