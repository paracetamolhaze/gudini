"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, EmptyState, ErrorState, Field, StatusBadge, TechDetails, type StatusTone } from "../components/ui";
import { CAROUSEL_LIMITS, FORMATS, IG_LIMITS, LANGUAGES } from "@/lib/carousel/limits";
import type { CarouselFormat, CarouselLanguage } from "@/lib/carousel/types";
import { AccessNotice, api, ApiError, formatDate, isAccessError, money, plural, type SectionStatus } from "./shared";
import s from "./carousel.module.css";

type Summary = {
  id: string;
  title: string;
  createdAt: string;
  format: CarouselFormat;
  mode: "text_cards" | "illustrated";
  slideCount: number;
  cover: string | null;
  status: { text: string; tone: StatusTone; busy?: boolean };
  permalink: string | null;
  costUsd: number;
  schedule: { status: string; when: string; account: string; permalink: string | null; error: string | null; stale: boolean } | null;
};

type ScheduleRow = { carouselId: string; title: string; cover: string | null; status: string; when: string; runAt: string; account: { label: string | null; igUserId: string }; permalink: string | null; error: string | null; stale: boolean };

type Form = { idea: string; slideCount: number; language: CarouselLanguage; format: CarouselFormat; imageModel: string };
const FORM_KEY = "gudini:carousel:new";

const SCHEDULE_LABEL: Record<string, { text: string; tone: StatusTone }> = {
  scheduled: { text: "Ожидает", tone: "accent" },
  queued: { text: "Отправляется", tone: "accent" },
  publishing: { text: "Публикуется", tone: "accent" },
  published: { text: "Опубликовано", tone: "success" },
  failed: { text: "Ошибка", tone: "error" },
  uncertain: { text: "Не подтверждено", tone: "warn" },
  missed: { text: "Просрочено", tone: "warn" },
  canceled: { text: "Отменено", tone: "neutral" },
};

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
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [section, setSection] = useState<SectionStatus | null>(null);
  const [form, setForm] = useState<Form>({ idea: "", slideCount: CAROUSEL_LIMITS.defaultSlides, language: "ru", format: "portrait", imageModel: "" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const restored = useRef(false);

  const load = useCallback(async () => {
    try {
      const [data, sch] = await Promise.all([api<{ carousels: Summary[] }>("/api/carousel"), api<{ schedules: ScheduleRow[] }>("/api/carousel/schedules").catch(() => ({ schedules: [] }))]);
      setList(data.carousels);
      setSchedules(sch.schedules);
      setLoadError(null);
    } catch (e) {
      setLoadError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void load();
    api<SectionStatus>("/api/carousel/status")
      .then((st) => {
        setSection(st);
        setForm((f) => (f.imageModel ? f : { ...f, imageModel: st.config.imageModel ?? "" }));
      })
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

  const busy = Boolean(list?.some((c) => c.status.busy)) || schedules.some((x) => x.status === "queued" || x.status === "publishing");
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [busy, load]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const model = section?.models.find((m) => m.id === form.imageModel) ?? section?.models.find((m) => m.id === section.config.imageModel) ?? null;
  const estimate = useMemo(() => {
    if (!section || !model) return null;
    const images = model.perImageUsd * form.slideCount;
    return { text: section.pricing.textPlanUsd, images, total: section.pricing.textPlanUsd + images };
  }, [section, model, form.slideCount]);
  const configOk = section ? section.config.problems.length === 0 : true;
  const modelBlocked = model ? model.available === false : false;

  async function create() {
    if (creating || form.idea.trim().length < CAROUSEL_LIMITS.ideaMin) return;
    setCreating(true);
    setError("");
    try {
      const r = await api<{ id: string }>("/api/carousel", { method: "POST", json: { ...form, imageModel: form.imageModel || undefined } });
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
    const scheduled = c.schedule?.status === "scheduled" ? " Запланированная публикация будет отменена." : "";
    if (!confirm(`Удалить карусель «${c.title}» со всеми слайдами и иллюстрациями? Опубликованный пост в Instagram останется.${scheduled} Отменить удаление будет нельзя.`)) return;
    try {
      await api(`/api/carousel/${c.id}`, { method: "DELETE" });
      setList((prev) => (prev ? prev.filter((x) => x.id !== c.id) : prev));
      setSchedules((prev) => prev.filter((x) => x.carouselId !== c.id));
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

  const pendingSchedules = schedules.filter((x) => x.status !== "canceled");

  return (
    <main>
      <div className="page-head">
        <div>
          <h1 className="page-title">Карусели</h1>
          <p className={s.lead}>Опишите идею → Claude готовит содержание и промпты → ИИ рисует иллюстрации → сайт собирает карточки → вы правите → публикуете сразу или по расписанию.</p>
        </div>
        <div className={s.headActions}>
          <Link href="/carousel/settings" className="btn btn-secondary btn-sm">
            Оформление
          </Link>
        </div>
      </div>

      {section && !section.config.keySet && (
        <div className="warn-box" role="alert">
          <strong>Требуется ключ OpenRouter для каруселей.</strong> Задайте переменную <code>{section.config.keyEnv}</code> в <code>.env</code> сайта (на сервере:{" "}
          <code>node scripts/carousel-env.mjs set {section.config.keyEnv}</code>) и перезапустите сайт. Пока ключа нет, генерация не запускается; карусели, созданные раньше, открываются и правятся.
        </div>
      )}
      {section && section.config.keySet && section.config.problems.length > 0 && <div className="warn-box">{section.config.problems.join(" ")}</div>}
      {section?.budget.disabled && <div className="warn-box">Платные действия каруселей выключены: бюджет раздела равен нулю.</div>}

      <div className="card">
        <h2>Новая карусель</h2>
        <Field label="Опишите идею" note="Тема, для кого, тон, что упомянуть или чего избегать — всё в одном поле.">
          <textarea
            rows={4}
            maxLength={CAROUSEL_LIMITS.ideaMax}
            placeholder="Например: 5 привычек, которые помогают высыпаться. Для занятых людей 25–35 лет, дружелюбно, без медицинских советов"
            value={form.idea}
            onChange={(e) => set("idea", e.target.value)}
            disabled={creating}
          />
        </Field>

        <details className={s.settings}>
          <summary>
            Настройки: {form.slideCount} {plural(form.slideCount, "слайд", "слайда", "слайдов")} · {LANGUAGES[form.language].label} · {FORMATS[form.format].label}
            {model ? ` · ${model.label}` : ""}
          </summary>
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
            <Field label="Формат" note="4:5 — основной для ленты; квадрат — дополнительный.">
              <select value={form.format} onChange={(e) => set("format", e.target.value as CarouselFormat)} disabled={creating}>
                {(Object.keys(FORMATS) as CarouselFormat[]).map((f) => (
                  <option key={f} value={f}>
                    {FORMATS[f].label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {section && (
            <div className="field">
              <span>Модель иллюстраций</span>
              <div className={s.styleGrid}>
                {section.models.map((m) => (
                  <button type="button" key={m.id} className={s.styleCard} aria-pressed={form.imageModel === m.id} onClick={() => set("imageModel", m.id)} disabled={creating || m.available === false}>
                    <span className={s.styleName}>{m.label}</span>
                    <span className={s.styleDesc}>{m.vendor}</span>
                    <span className={s.styleDesc}>
                      {m.available === false ? `Недоступна: ${m.reason}` : `≈ ${money(m.perImageUsd)} за картинку${m.resolution ? ` · ${m.resolution}` : ""}`}
                    </span>
                    {m.note && <span className={s.styleDesc}>{m.note}</span>}
                  </button>
                ))}
              </div>
              <div className="hint" style={{ marginTop: 8 }}>
                Оформление карточек — цвета, шрифт, подпись, стиль иллюстраций —{" "}
                <Link href="/carousel/settings" className="link-btn">
                  в настройках оформления
                </Link>
                , оно применяется ко всем новым каруселям.
              </div>
            </div>
          )}
        </details>

        {estimate && (
          <p className={s.modeNote}>
            Оценка расходов: ≈ {money(estimate.total)} — тексты Claude ≈ {money(estimate.text)}, {form.slideCount} {plural(form.slideCount, "иллюстрация", "иллюстрации", "иллюстраций")} ≈{" "}
            {money(estimate.images)}. Это оценка до запуска; фактическая цена берётся из ответов OpenRouter и видна в карусели.
            {section && ` Остаток месячного бюджета раздела: ${money(section.budget.monthRemainingUsd)}.`}
          </p>
        )}
        {modelBlocked && model && <div className="warn-box">Модель {model.label} сейчас недоступна: {model.reason}. Выберите другую в настройках.</div>}
        {error && <div className="error-box">{error}</div>}
        <div className="actions">
          <Button onClick={create} busy={creating} disabled={form.idea.trim().length < CAROUSEL_LIMITS.ideaMin || !configOk || modelBlocked}>
            {creating ? "Создаём…" : "Создать карусель"}
          </Button>
        </div>
      </div>

      {pendingSchedules.length > 0 && (
        <section className="section" aria-label="Запланированные публикации">
          <h2 className="h-block" style={{ marginBottom: 10 }}>
            Запланированные публикации
          </h2>
          <div className={s.list}>
            {pendingSchedules.map((x) => {
              const st = SCHEDULE_LABEL[x.status] ?? { text: x.status, tone: "neutral" as StatusTone };
              return (
                <div className={s.row} key={`${x.carouselId}-${x.runAt}`}>
                  <Link href={`/carousel/${x.carouselId}`} aria-hidden tabIndex={-1}>
                    <div className={s.thumb}>{x.cover ? <img src={`/api/carousel/${x.carouselId}/image/${x.cover}`} alt="" loading="lazy" /> : "—"}</div>
                  </Link>
                  <div className={s.rowMain}>
                    <Link href={`/carousel/${x.carouselId}`} className={s.rowTitle}>
                      {x.title}
                    </Link>
                    <div className={s.rowMeta}>
                      <span>{x.when}</span>
                      <span>{x.account.label ?? x.account.igUserId}</span>
                      <StatusBadge tone={st.tone} busy={x.status === "queued" || x.status === "publishing"}>
                        {st.text}
                      </StatusBadge>
                      {x.stale && <span className={s.slideWarn}>версия в расписании устарела</span>}
                      {x.permalink && (
                        <a href={x.permalink} target="_blank" rel="noreferrer" className="link-btn">
                          Пост в Instagram
                        </a>
                      )}
                    </div>
                    {x.error && <div className={`${s.rowMeta} ${s.slideErr}`}>{x.error}</div>}
                  </div>
                  <div className={s.rowActions}>
                    <Link href={`/carousel/${x.carouselId}`} className="btn btn-secondary btn-sm">
                      Открыть
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="section" aria-label="Список каруселей">
        {list === null && !loadError && (
          <div className={s.list} aria-busy="true">
            {[0, 1].map((i) => (
              <div className="skeleton" key={i} style={{ height: 104 }} />
            ))}
          </div>
        )}
        {loadError && <ErrorState title="Не удалось загрузить карусели" text={loadError.message} onRetry={() => void load()} />}
        {list && list.length === 0 && <EmptyState title="Каруселей пока нет" text="Опишите идею выше — Claude подготовит содержание, а генератор нарисует иллюстрации." />}
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
                    {c.mode === "text_cards" && <span>текстовые карточки</span>}
                    {c.costUsd > 0 && <span title="расход по этой карусели">≈ {money(c.costUsd)}</span>}
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

      {section && (
        <TechDetails summary="Состояние раздела">
          <ul className={s.log}>
            <li>Ключ OpenRouter для каруселей: {section.config.keySet ? "задан" : "не задан"}</li>
            {section.key && <li>Лимит ключа: {section.key.limit === null ? "без лимита" : money(section.key.limit)} · потрачено по ключу {money(section.key.usage)}</li>}
            {section.keyError && <li>Лимит ключа не прочитан: {section.keyError}</li>}
            <li>Модель текста: {section.config.textModel} · модель иллюстраций по умолчанию: {section.config.imageModel ?? "не задана"} · разрешение {section.config.resolution}</li>
            <li>
              Бюджет раздела за {section.budget.month}: {money(section.budget.monthSpentUsd)} из {money(section.budget.monthlyLimitUsd)}
              {section.budget.monthPendingUsd ? ` (+ ${money(section.budget.monthPendingUsd)} в работе)` : ""} · на одну карусель до {money(section.budget.perCarouselLimitUsd)}
            </li>
            <li>Instagram: {section.instagram.connected ? section.instagram.label ?? "подключён" : "не подключён"}</li>
            <li>Модели сверены с каталогом OpenRouter {section.modelsCheckedAt}</li>
          </ul>
        </TechDetails>
      )}
    </main>
  );
}
