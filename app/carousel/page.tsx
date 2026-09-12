"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, EmptyState, ErrorState, Field, StatusBadge, type StatusTone } from "../components/ui";
import { CAROUSEL_STYLES, DEFAULT_STYLE } from "@/lib/carousel/styles";
import { CAROUSEL_LIMITS, FORMATS, IG_LIMITS, LANGUAGES } from "@/lib/carousel/limits";
import type { CarouselFormat, CarouselLanguage, CarouselStyleId } from "@/lib/carousel/types";
import { AccessNotice, api, ApiError, formatDate, isAccessError, plural } from "./shared";
import s from "./carousel.module.css";

type Summary = {
  id: string;
  title: string;
  idea: string;
  createdAt: string;
  format: CarouselFormat;
  slideCount: number;
  cover: string | null;
  status: { text: string; tone: StatusTone; busy?: boolean };
  permalink: string | null;
};

type SectionStatus = {
  llm: { available: boolean; transport: string };
  instagram: { connected: boolean; label: string | null; problems: string[] };
  mode: { label: string; note: string };
};

type Form = { idea: string; wishes: string; slideCount: number; language: CarouselLanguage; style: CarouselStyleId; format: CarouselFormat };

const EMPTY_FORM: Form = { idea: "", wishes: "", slideCount: CAROUSEL_LIMITS.defaultSlides, language: "ru", style: DEFAULT_STYLE, format: "portrait" };
const FORM_KEY = "gudini:carousel:new";

function RowMenu({ onDelete }: { onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className={s.menu} ref={ref}>
      <Button variant="ghost" size="sm" aria-label="Действия с каруселью" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        ⋯
      </Button>
      {open && (
        <div className={s.menuList} role="menu">
          <button
            className={s.menuItem}
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Удалить карусель
          </button>
        </div>
      )}
    </div>
  );
}

export default function CarouselsPage() {
  const router = useRouter();
  const [list, setList] = useState<Summary[] | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [section, setSection] = useState<SectionStatus | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const restored = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ carousels: Summary[] }>("/api/carousel");
      setList(data.carousels);
      setLoadError(null);
    } catch (e) {
      setLoadError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void load();
    api<SectionStatus>("/api/carousel/status")
      .then(setSection)
      .catch(() => {});
  }, [load]);

  // черновик формы переживает обновление страницы
  useEffect(() => {
    try {
      const raw = localStorage.getItem(FORM_KEY);
      if (raw) setForm((f) => ({ ...f, ...JSON.parse(raw) }));
    } catch {}
    restored.current = true;
  }, []);
  useEffect(() => {
    if (!restored.current) return;
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(form));
    } catch {}
  }, [form]);

  const busy = Boolean(list?.some((c) => c.status.busy));
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [busy, load]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function create() {
    if (creating || form.idea.trim().length < CAROUSEL_LIMITS.ideaMin) return;
    setCreating(true);
    setError("");
    try {
      const r = await api<{ id: string }>("/api/carousel", { method: "POST", json: form });
      try {
        localStorage.removeItem(FORM_KEY);
      } catch {}
      router.push(`/carousel/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  async function remove(c: Summary) {
    if (!confirm(`Удалить карусель «${c.title}» со всеми слайдами? Опубликованный пост в Instagram останется. Отменить удаление будет нельзя.`)) return;
    try {
      await api(`/api/carousel/${c.id}`, { method: "DELETE" });
      setList((prev) => (prev ? prev.filter((x) => x.id !== c.id) : prev));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (loadError && isAccessError(loadError)) {
    return (
      <main>
        <div className="page-head">
          <h1 className="page-title">Карусели</h1>
        </div>
        <AccessNotice error={loadError} />
      </main>
    );
  }

  return (
    <main>
      <div className="page-head">
        <div>
          <h1 className="page-title">Карусели</h1>
          <p className={s.lead}>Идея → Claude пишет слайды и подпись → вы просматриваете и правите → публикация в Instagram.</p>
        </div>
      </div>

      <div className="card">
        <h2>Новая карусель</h2>
        <Field label="Идея или тема">
          <textarea
            rows={3}
            maxLength={CAROUSEL_LIMITS.ideaMax}
            placeholder="Например: 5 привычек, которые помогают высыпаться"
            value={form.idea}
            onChange={(e) => set("idea", e.target.value)}
            disabled={creating}
          />
        </Field>
        <Field label="Дополнительные пожелания" note="Необязательно: тон, аудитория, что упомянуть или чего избегать.">
          <textarea
            rows={2}
            maxLength={CAROUSEL_LIMITS.wishesMax}
            placeholder="Например: для новичков, дружелюбно, без медицинских советов"
            value={form.wishes}
            onChange={(e) => set("wishes", e.target.value)}
            disabled={creating}
          />
        </Field>
        <div className={s.formGrid}>
          <Field label="Количество слайдов" note={`Instagram принимает до ${IG_LIMITS.maxItems}.`}>
            <select value={form.slideCount} onChange={(e) => set("slideCount", Number(e.target.value))} disabled={creating}>
              {Array.from({ length: CAROUSEL_LIMITS.maxSlides - CAROUSEL_LIMITS.minSlides + 1 }, (_, i) => CAROUSEL_LIMITS.minSlides + i).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Язык">
            <select value={form.language} onChange={(e) => set("language", e.target.value as CarouselLanguage)} disabled={creating}>
              {(Object.keys(LANGUAGES) as CarouselLanguage[]).map((l) => (
                <option key={l} value={l}>
                  {LANGUAGES[l].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Формат">
            <select value={form.format} onChange={(e) => set("format", e.target.value as CarouselFormat)} disabled={creating}>
              {(Object.keys(FORMATS) as CarouselFormat[]).map((f) => (
                <option key={f} value={f}>
                  {FORMATS[f].label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="field">
          <span>Визуальный стиль</span>
          <div className={s.styleGrid}>
            {CAROUSEL_STYLES.map((st) => (
              <button type="button" key={st.id} className={s.styleCard} aria-pressed={form.style === st.id} onClick={() => set("style", st.id)} disabled={creating}>
                <span className={s.swatch} aria-hidden>
                  {st.swatch.map((color) => (
                    <span key={color} style={{ background: color }} />
                  ))}
                </span>
                <span className={s.styleName}>{st.label}</span>
                <span className={s.styleDesc}>{st.description}</span>
              </button>
            ))}
          </div>
        </div>

        <p className={s.modeNote}>
          Режим: <strong>{section?.mode.label ?? "текстовые карточки с графическим оформлением"}</strong>. Иллюстрации не генерируются.
        </p>
        {section && !section.llm.available && (
          <div className="warn-box">Claude сейчас недоступен: не задан ключ для транспорта {section.llm.transport}. Карусель сохранится, но генерация завершится ошибкой.</div>
        )}
        {error && <div className="error-box">{error}</div>}
        <div className="actions">
          <Button onClick={create} busy={creating} disabled={form.idea.trim().length < CAROUSEL_LIMITS.ideaMin}>
            {creating ? "Создаём…" : "Создать карусель"}
          </Button>
        </div>
      </div>

      <section className="section" aria-label="Список каруселей">
        {list === null && !loadError && (
          <div className={s.list} aria-busy="true">
            {[0, 1].map((i) => (
              <div className="skeleton" key={i} style={{ height: 104 }} />
            ))}
          </div>
        )}
        {loadError && <ErrorState title="Не удалось загрузить карусели" text={loadError.message} onRetry={() => void load()} />}
        {list && list.length === 0 && <EmptyState title="Каруселей пока нет" text="Опишите идею выше — Claude подготовит слайды и подпись." />}
        {list && list.length > 0 && (
          <div className={s.list}>
            {list.map((c) => (
              <div className={s.row} key={c.id}>
                <Link href={`/carousel/${c.id}`} aria-hidden tabIndex={-1}>
                  <div className={`${s.thumb} ${c.format === "square" ? s.thumbSquare : ""}`}>
                    {c.cover ? <img src={`/api/carousel/${c.id}/image/${c.cover}`} alt="" loading="lazy" /> : c.status.busy ? "Готовится" : "Нет обложки"}
                  </div>
                </Link>
                <div className={s.rowMain}>
                  <Link href={`/carousel/${c.id}`} className={s.rowTitle}>
                    {c.title}
                  </Link>
                  <div className={s.rowMeta}>
                    <span>{formatDate(c.createdAt)}</span>
                    {c.slideCount > 0 && (
                      <span>
                        {c.slideCount} {plural(c.slideCount, "слайд", "слайда", "слайдов")}
                      </span>
                    )}
                    <StatusBadge tone={c.status.tone} busy={c.status.busy}>
                      {c.status.text}
                    </StatusBadge>
                    {c.permalink && (
                      <a href={c.permalink} target="_blank" rel="noreferrer" className="link-btn">
                        Пост в Instagram
                      </a>
                    )}
                  </div>
                </div>
                <div className={s.rowActions}>
                  <Link href={`/carousel/${c.id}`} className="btn btn-secondary btn-sm">
                    Открыть
                  </Link>
                  <RowMenu onDelete={() => void remove(c)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
