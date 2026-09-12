"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { BackLink, Button, ErrorState, Field, StatusBadge, TechDetails, type StatusTone } from "../../components/ui";
import type { Carousel, CarouselJob, CarouselStyleId, Slide, SlideKind } from "@/lib/carousel/types";
import { CAROUSEL_STYLES } from "@/lib/carousel/styles";
import { CAROUSEL_LIMITS, FORMATS, IG_LIMITS, TEXT_LIMITS } from "@/lib/carousel/limits";
import { captionProblems, composeCaption, normalizeHashtags, visibleLength } from "@/lib/carousel/text";
import { AccessNotice, api, ApiError, formatDate, isAccessError, isPending, JOB_TITLES, plural } from "../shared";
import s from "../carousel.module.css";

type View = {
  carousel: Carousel;
  status: { text: string; tone: StatusTone; busy?: boolean };
  readiness: string[];
  staleSlideIds: string[];
  jobInterrupted: boolean;
};

type SectionStatus = {
  instagram: { connected: boolean; label: string | null; via: string | null; expiresInDays: number | null; problems: string[] };
  mode: { label: string; note: string };
};

type SlideDraft = { kicker: string; title: string; body: string; bullets: string[]; cta: string };
type Drafts = { slides: Record<string, SlideDraft>; caption?: string; hashtags?: string; title?: string; footer?: string };

const KIND_LABEL: Record<SlideKind, string> = { cover: "обложка", content: "слайд", final: "финал" };
const EXAMPLES = ["Сократи третий слайд", "Сделай обложку интригующей", "Упрости язык на всех слайдах", "Добавь в подпись вопрос к подписчикам"];

const fieldsOf = (sl: Slide): SlideDraft => ({ kicker: sl.kicker, title: sl.title, body: sl.body, bullets: [...sl.bullets], cta: sl.cta });
const cleanBullets = (list: string[]) => list.map((b) => b.trim()).filter(Boolean);
const sameSlide = (sl: Slide, d: SlideDraft) =>
  sl.kicker === d.kicker && sl.title === d.title && sl.body === d.body && sl.cta === d.cta && JSON.stringify(sl.bullets) === JSON.stringify(cleanBullets(d.bullets));

function isDirty(d: Drafts, c: Carousel): boolean {
  if (d.caption !== undefined && d.caption !== c.caption) return true;
  if (d.hashtags !== undefined && d.hashtags !== c.hashtags.join(" ")) return true;
  if (d.title !== undefined && d.title !== c.title) return true;
  if (d.footer !== undefined && d.footer !== c.footer) return true;
  return Object.entries(d.slides).some(([id, draft]) => {
    const sl = c.slides.find((x) => x.id === id);
    return Boolean(sl && !sameSlide(sl, draft));
  });
}

function Counter({ value, limit }: { value: string; limit: number }) {
  const len = visibleLength(value);
  return (
    <div className={`${s.counter} ${len > limit ? s.counterOver : ""}`}>
      {len} / {limit}
      {len > limit ? " — может не поместиться" : ""}
    </div>
  );
}

function JobPanel({ job, interrupted, onRetry, disabled }: { job: CarouselJob; interrupted: boolean; onRetry: (job: CarouselJob) => void; disabled: boolean }) {
  if (job.state === "done") {
    return job.note ? (
      <div className="state-box">
        <strong>{JOB_TITLES[job.type]}:</strong> {job.note}
      </div>
    ) : null;
  }
  if (job.state === "error") {
    return (
      <div className="error-box plain" role="alert">
        <div style={{ fontWeight: 600, color: "var(--error)" }}>Ошибка: {JOB_TITLES[job.type].toLowerCase()}</div>
        <div style={{ marginTop: 4 }}>{job.error}</div>
        <div className="actions" style={{ marginTop: 10 }}>
          <Button variant="secondary" size="sm" onClick={() => onRetry(job)} disabled={disabled}>
            Повторить
          </Button>
        </div>
      </div>
    );
  }
  const stages =
    job.type === "generate"
      ? [
          { label: "Очередь", done: job.state === "running", active: job.state === "queued" },
          { label: "Тексты от Claude", done: job.progress >= 40, active: job.state === "running" && job.progress < 40 },
          { label: "Рендер слайдов", done: job.progress >= 98, active: job.progress >= 40 && job.progress < 98 },
          { label: "Готово", done: false, active: job.progress >= 98 },
        ]
      : null;
  return (
    <div className={s.jobBox} aria-live="polite">
      <div className={s.jobHead}>
        <span className="spin" aria-hidden />
        <strong>{JOB_TITLES[job.type]}</strong>
        <span className="hint">{job.state === "queued" ? "в очереди" : job.step}</span>
      </div>
      {stages && (
        <ol className={s.stageList}>
          {stages.map((st) => (
            <li key={st.label} className={`${s.stage} ${st.done ? s.stageDone : st.active ? s.stageActive : ""}`}>
              {st.label}
            </li>
          ))}
        </ol>
      )}
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.max(3, job.progress)}%` }} />
      </div>
      <div className="hint">
        Задание выполняется на сервере — страницу можно закрыть и вернуться позже.
        {interrupted ? " Обработчик перезапускается: задание продолжится с места остановки." : ""}
      </div>
    </div>
  );
}

export default function CarouselEditor() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [section, setSection] = useState<SectionStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({ slides: {} });
  const [restoredNote, setRestoredNote] = useState("");
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [instruction, setInstruction] = useState("");
  const [hint, setHint] = useState("");
  const [copied, setCopied] = useState(false);
  const restored = useRef(false);
  const draftKey = `gudini:carousel:${id}:draft`;

  const c = view?.carousel ?? null;

  const load = useCallback(async () => {
    try {
      const v = await api<View>(`/api/carousel/${id}`);
      setView(v);
      setLoadError(null);
    } catch (e) {
      setLoadError(e as ApiError);
    }
  }, [id]);

  useEffect(() => {
    void load();
    api<SectionStatus>("/api/carousel/status")
      .then(setSection)
      .catch(() => {});
  }, [load]);

  // несохранённые правки восстанавливаются после обновления страницы
  useEffect(() => {
    if (!c || restored.current) return;
    restored.current = true;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as Drafts & { revision?: number };
      const slides = Object.fromEntries(Object.entries(saved.slides ?? {}).filter(([sid]) => c.slides.some((x) => x.id === sid)));
      const next: Drafts = { slides, caption: saved.caption, hashtags: saved.hashtags, title: saved.title, footer: saved.footer };
      if (isDirty(next, c)) {
        setDrafts(next);
        setRestoredNote(
          saved.revision === c.revision
            ? "Восстановлены несохранённые правки."
            : "Восстановлены несохранённые правки, сделанные до последних изменений карусели — проверьте их перед сохранением.",
        );
      } else localStorage.removeItem(draftKey);
    } catch {}
  }, [c, draftKey]);

  useEffect(() => {
    if (!c || !restored.current) return;
    try {
      if (isDirty(drafts, c)) localStorage.setItem(draftKey, JSON.stringify({ ...drafts, revision: c.revision }));
      else localStorage.removeItem(draftKey);
    } catch {}
  }, [drafts, c, draftKey]);

  useEffect(() => {
    if (c?.slides.length && (!selected || !c.slides.some((x) => x.id === selected))) setSelected(c.slides[0].id);
  }, [c, selected]);

  const pending = isPending(c?.job);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [pending, load]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const dirty = useMemo(() => (c ? isDirty(drafts, c) : false), [drafts, c]);

  async function run(name: string, fn: () => Promise<View | void>): Promise<boolean> {
    if (busy) return false;
    setBusy(name);
    setActionError("");
    try {
      const v = await fn();
      if (v) setView(v);
      return true;
    } catch (e) {
      const err = e as ApiError;
      setActionError(err.message);
      if (err.status === 409) void load();
      return false;
    } finally {
      setBusy("");
    }
  }

  if (loadError && isAccessError(loadError)) {
    return (
      <main>
        <BackLink href="/carousel">Карусели</BackLink>
        <AccessNotice error={loadError} />
      </main>
    );
  }
  if (!view || !c) {
    return (
      <main>
        <BackLink href="/carousel">Карусели</BackLink>
        {loadError ? (
          <ErrorState title={loadError.status === 404 ? "Карусель не найдена" : "Не удалось загрузить карусель"} text={loadError.message} onRetry={() => void load()} />
        ) : (
          <div className="skeleton" style={{ height: 320 }} />
        )}
      </main>
    );
  }

  const publishing = c.publish.status === "queued" || c.publish.status === "running";
  const locked = pending || publishing;
  const total = c.slides.length;
  const square = c.format === "square";
  const index = Math.max(0, c.slides.findIndex((x) => x.id === selected));
  const current = c.slides[index] as Slide | undefined;
  const draft = current ? drafts.slides[current.id] ?? fieldsOf(current) : null;
  const archiveReady = total > 0 && view.staleSlideIds.length === 0 && c.slides.every((x) => x.render?.file);

  const setSlideField = <K extends keyof SlideDraft>(key: K, value: SlideDraft[K]) => {
    if (!current || !draft) return;
    setDrafts((d) => ({ ...d, slides: { ...d.slides, [current.id]: { ...draft, [key]: value } } }));
  };

  function discardDrafts() {
    setDrafts({ slides: {} });
    setRestoredNote("");
  }

  function buildPatch(): Record<string, unknown> | null {
    if (!c) return null;
    const patch: Record<string, unknown> = { revision: c.revision };
    const slides = Object.entries(drafts.slides)
      .filter(([sid, d]) => {
        const sl = c.slides.find((x) => x.id === sid);
        return sl && !sameSlide(sl, d);
      })
      .map(([sid, d]) => ({ id: sid, kicker: d.kicker, title: d.title, body: d.body, bullets: cleanBullets(d.bullets), cta: d.cta }));
    if (slides.length) patch.slides = slides;
    if (drafts.caption !== undefined && drafts.caption !== c.caption) patch.caption = drafts.caption;
    if (drafts.hashtags !== undefined && drafts.hashtags !== c.hashtags.join(" ")) patch.hashtags = drafts.hashtags;
    if (drafts.title !== undefined && drafts.title !== c.title) patch.title = drafts.title;
    if (drafts.footer !== undefined && drafts.footer !== c.footer) patch.footer = drafts.footer;
    return Object.keys(patch).length > 1 ? patch : null;
  }

  const save = () =>
    run("save", async () => {
      const patch = buildPatch();
      if (!patch) return;
      const v = await api<View>(`/api/carousel/${id}`, { method: "PATCH", json: patch });
      setDrafts({ slides: {} });
      setRestoredNote("");
      return v;
    });

  const startJob = (name: string, payload: Record<string, unknown>) =>
    run(name, () => api<View>(`/api/carousel/${id}/jobs`, { method: "POST", json: { ...payload, revision: c.revision } }));

  function move(i: number, dir: -1 | 1) {
    if (!c) return;
    const order = c.slides.map((x) => x.id);
    const j = i + dir;
    [order[i], order[j]] = [order[j], order[i]];
    void run("order", () => api<View>(`/api/carousel/${id}`, { method: "PATCH", json: { revision: c.revision, order } }));
  }

  function changeStyle(style: CarouselStyleId) {
    if (!c || style === c.style) return;
    if (dirty) {
      setActionError("Сначала сохраните или отмените правки — смена стиля перерендерит все слайды.");
      return;
    }
    void run("style", () => api<View>(`/api/carousel/${id}`, { method: "PATCH", json: { revision: c.revision, style } }));
  }

  function regenerate(sl: Slide) {
    const d = drafts.slides[sl.id];
    if (d && !sameSlide(sl, d) && !confirm("Несохранённые правки этого слайда будут заменены новым текстом. Продолжить?")) return;
    setDrafts((prev) => {
      const next = { ...prev.slides };
      delete next[sl.id];
      return { ...prev, slides: next };
    });
    void startJob("regenerate", { type: "regenerate_slide", slideId: sl.id, hint }).then((okay) => okay && setHint(""));
  }

  function instruct() {
    if (dirty) {
      setActionError("Сначала сохраните или отмените ручные правки — поручение применяется к сохранённой версии.");
      return;
    }
    void startJob("instruct", { type: "instruct", instruction }).then((okay) => okay && setInstruction(""));
  }

  function publish() {
    if (!c) return;
    const label = section?.instagram.label;
    const ok = confirm(
      `Опубликовать карусель из ${total} ${plural(total, "слайда", "слайдов", "слайдов")} в Instagram${label ? ` (${label})` : ""}?\n\nПост появится в профиле сразу, отменить публикацию из Гудини нельзя.`,
    );
    if (!ok) return;
    void run("publish", () => api<View>(`/api/carousel/${id}/publish`, { method: "POST", json: { revision: c.revision } }));
  }

  const verify = () => run("verify", () => api<View>(`/api/carousel/${id}/publish`, { method: "POST", json: { action: "verify" } }));

  function retry(job: CarouselJob) {
    if (job.type === "publish") return publish();
    if (job.type === "verify_publish") return void verify();
    if (job.type === "generate") return void run("retry", () => api<View>(`/api/carousel/${id}/jobs`, { method: "POST", json: { type: "generate" } }));
    void startJob("retry", { type: job.type, slideId: job.params.slideId, hint: job.params.hint, instruction: job.params.instruction });
  }

  async function copyCaption(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setActionError("Браузер не дал скопировать текст — выделите его вручную");
    }
  }

  const captionValue = drafts.caption ?? c.caption;
  const tagsValue = drafts.hashtags ?? c.hashtags.join(" ");
  const tagsList = normalizeHashtags(tagsValue);
  const fullCaption = composeCaption(captionValue, tagsList);
  const capProblems = captionProblems(captionValue, tagsList);
  const p = c.publish;
  const igProblems = section?.instagram.problems ?? [];
  const blockers = [...igProblems, ...view.readiness.filter((x) => !(pending && x.startsWith("Дождитесь"))), ...(dirty ? ["Сохраните правки перед публикацией"] : [])];
  const staleCurrent = current ? view.staleSlideIds.includes(current.id) : false;
  const limits = current ? TEXT_LIMITS[current.kind] : null;

  return (
    <main>
      <BackLink href="/carousel">Карусели</BackLink>
      <div className={s.head}>
        <div className={s.headMain}>
          <input
            type="text"
            className={s.titleInput}
            aria-label="Название карусели"
            value={drafts.title ?? c.title}
            maxLength={CAROUSEL_LIMITS.titleMax}
            onChange={(e) => setDrafts((d) => ({ ...d, title: e.target.value }))}
            disabled={locked}
          />
          <div className={s.rowMeta}>
            <span>{formatDate(c.createdAt, true)}</span>
            {total > 0 && (
              <span>
                {total} {plural(total, "слайд", "слайда", "слайдов")} · {FORMATS[c.format].label}
              </span>
            )}
            <StatusBadge tone={view.status.tone} busy={view.status.busy}>
              {view.status.text}
            </StatusBadge>
            {c.cost.usd > 0 && <span title="Расход на Claude по этой карусели">≈ ${c.cost.usd.toFixed(2)}</span>}
          </div>
        </div>
        <div className={s.headActions}>
          <a className={`btn btn-secondary btn-sm ${archiveReady ? "" : s.disabledLink}`} href={archiveReady ? `/api/carousel/${id}/archive` : undefined} aria-disabled={!archiveReady}>
            Скачать ZIP
          </a>
        </div>
      </div>

      {restoredNote && (
        <div className="warn-box">
          {restoredNote}{" "}
          <button type="button" className="link-btn" onClick={discardDrafts}>
            Отменить эти правки
          </button>
        </div>
      )}
      {c.job && <JobPanel job={c.job} interrupted={view.jobInterrupted} onRetry={retry} disabled={Boolean(busy) || locked} />}
      {actionError && (
        <div className="error-box" role="alert">
          {actionError}
        </div>
      )}
      <div className="hint">
        Режим: {section?.mode.label.toLowerCase() ?? "текстовые карточки с графическим оформлением"} — иллюстрации не генерируются.
      </div>

      {total === 0 ? (
        !pending && !c.job?.error && <div className="empty" style={{ marginTop: 16 }}>Слайдов пока нет.</div>
      ) : (
        <>
          <section className="section" aria-label="Слайды">
            <div className={s.slides}>
              {c.slides.map((sl, i) => {
                const stale = view.staleSlideIds.includes(sl.id);
                const unsaved = drafts.slides[sl.id] && !sameSlide(sl, drafts.slides[sl.id]);
                return (
                  <div key={sl.id} className={`${s.slideCard} ${sl.id === current?.id ? s.slideCardActive : ""}`}>
                    <button type="button" className={`${s.slideImg} ${square ? s.slideImgSquare : ""}`} onClick={() => setSelected(sl.id)} aria-label={`Открыть слайд ${i + 1}`}>
                      {sl.render?.file ? <img src={`/api/carousel/${id}/image/${sl.render.file}`} alt={`Слайд ${i + 1}`} loading="lazy" /> : <span>{sl.render?.error ? "Нужны правки" : "Рендер…"}</span>}
                    </button>
                    <div className={s.slideLabel}>
                      <span className={sl.render?.error ? s.slideErr : stale || unsaved ? s.slideWarn : ""}>
                        {i + 1} · {KIND_LABEL[sl.kind]}
                        {unsaved ? " · не сохранён" : stale ? " · обновится" : sl.render?.error ? " · ошибка" : ""}
                      </span>
                      {sl.kind === "content" && (
                        <span className={s.moveBtns}>
                          <button type="button" className={s.iconBtn} onClick={() => move(i, -1)} disabled={i <= 1 || locked || Boolean(busy)} aria-label={`Сдвинуть слайд ${i + 1} раньше`}>
                            ←
                          </button>
                          <button type="button" className={s.iconBtn} onClick={() => move(i, 1)} disabled={i >= total - 2 || locked || Boolean(busy)} aria-label={`Сдвинуть слайд ${i + 1} позже`}>
                            →
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {dirty && (
            <div className={s.saveBar} role="status">
              <span>Есть несохранённые правки.</span>
              <span style={{ flex: 1 }} />
              <Button size="sm" onClick={() => void save()} busy={busy === "save"} disabled={locked}>
                Сохранить
              </Button>
              <Button size="sm" variant="ghost" onClick={discardDrafts} disabled={Boolean(busy)}>
                Отменить
              </Button>
            </div>
          )}

          <div className={s.editor}>
            <div>
              {current && draft && limits && (
                <div className="card">
                  <div className="card-head">
                    <h2>
                      Слайд {index + 1} · {KIND_LABEL[current.kind]}
                    </h2>
                  </div>
                  {current.render?.error && !staleCurrent && <div className="error-box plain">{current.render.error}</div>}
                  <Field label="Метка над заголовком" note="Необязательно, например «Шаг 2».">
                    <input type="text" value={draft.kicker} onChange={(e) => setSlideField("kicker", e.target.value)} disabled={locked} />
                  </Field>
                  <Counter value={draft.kicker} limit={limits.kicker} />
                  <Field label="Заголовок" note="**слово** — выделить акцентом.">
                    <textarea rows={2} value={draft.title} onChange={(e) => setSlideField("title", e.target.value)} disabled={locked} />
                  </Field>
                  <Counter value={draft.title} limit={limits.title} />
                  <Field label={current.kind === "cover" ? "Подзаголовок" : "Текст"}>
                    <textarea rows={current.kind === "cover" ? 2 : 4} value={draft.body} onChange={(e) => setSlideField("body", e.target.value)} disabled={locked} />
                  </Field>
                  <Counter value={draft.body} limit={cleanBullets(draft.bullets).length ? limits.bodyWithBullets : limits.body} />
                  {current.kind === "content" && (
                    <div className="field">
                      <span>Пункты списка</span>
                      {draft.bullets.map((b, bi) => (
                        <div className={s.bulletRow} key={bi}>
                          <input
                            type="text"
                            value={b}
                            aria-label={`Пункт ${bi + 1}`}
                            onChange={(e) => setSlideField("bullets", draft.bullets.map((x, k) => (k === bi ? e.target.value : x)))}
                            disabled={locked}
                          />
                          <button
                            type="button"
                            className={s.iconBtn}
                            aria-label={`Удалить пункт ${bi + 1}`}
                            onClick={() => setSlideField("bullets", draft.bullets.filter((_, k) => k !== bi))}
                            disabled={locked}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      {draft.bullets.length < limits.bullets && (
                        <button type="button" className="link-btn" style={{ marginTop: 8 }} onClick={() => setSlideField("bullets", [...draft.bullets, ""])} disabled={locked}>
                          + пункт
                        </button>
                      )}
                    </div>
                  )}
                  {current.kind === "final" && (
                    <>
                      <Field label="Призыв">
                        <input type="text" value={draft.cta} onChange={(e) => setSlideField("cta", e.target.value)} disabled={locked} />
                      </Field>
                      <Counter value={draft.cta} limit={limits.cta} />
                    </>
                  )}
                  <div className="actions">
                    <Button onClick={() => void save()} busy={busy === "save"} disabled={!dirty || locked}>
                      Сохранить и перерендерить
                    </Button>
                    {current.render?.file && !staleCurrent && (
                      <a className="btn btn-secondary" href={`/api/carousel/${id}/image/${current.render.file}?download=1`}>
                        Скачать JPG
                      </a>
                    )}
                  </div>
                  <div className="field">
                    <span>Перегенерировать слайд через Claude</span>
                    <div className={s.inline}>
                      <input
                        type="text"
                        placeholder="Пожелание, необязательно: проще, с примером…"
                        value={hint}
                        maxLength={CAROUSEL_LIMITS.hintMax}
                        onChange={(e) => setHint(e.target.value)}
                        disabled={locked}
                      />
                      <Button variant="secondary" onClick={() => regenerate(current)} busy={busy === "regenerate"} disabled={locked || Boolean(busy)}>
                        Перегенерировать
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <div className="card">
                <h2>Поручение Claude</h2>
                <p className="hint">Опишите правку словами — Claude изменит только то, о чём попросили, изменённые слайды перерендерятся.</p>
                <textarea
                  rows={2}
                  style={{ marginTop: 10 }}
                  value={instruction}
                  maxLength={CAROUSEL_LIMITS.instructionMax}
                  placeholder="Например: сократи третий слайд"
                  onChange={(e) => setInstruction(e.target.value)}
                  disabled={locked}
                />
                <div className={s.chips}>
                  {EXAMPLES.map((x) => (
                    <button type="button" key={x} className={s.chip} onClick={() => setInstruction(x)} disabled={locked}>
                      {x}
                    </button>
                  ))}
                </div>
                <div className="actions">
                  <Button onClick={instruct} busy={busy === "instruct"} disabled={locked || Boolean(busy) || instruction.trim().length < 3}>
                    Применить поручение
                  </Button>
                </div>
              </div>

              <div className="card">
                <h2>Подпись к публикации</h2>
                <textarea rows={9} value={captionValue} onChange={(e) => setDrafts((d) => ({ ...d, caption: e.target.value }))} disabled={locked} aria-label="Подпись" />
                <Field label="Хэштеги" note="Через пробел; символ # добавится сам.">
                  <input type="text" value={tagsValue} onChange={(e) => setDrafts((d) => ({ ...d, hashtags: e.target.value }))} disabled={locked} />
                </Field>
                <div className={`${s.counter} ${fullCaption.length > IG_LIMITS.captionMaxChars ? s.counterOver : ""}`}>
                  {fullCaption.length} / {IG_LIMITS.captionMaxChars} символов · {tagsList.length} / {IG_LIMITS.maxHashtags} хэштегов
                </div>
                {capProblems.length > 0 && <div className="warn-box">Instagram не примет подпись: {capProblems.join("; ")}.</div>}
                <div className="actions">
                  <Button onClick={() => void save()} busy={busy === "save"} disabled={!dirty || locked}>
                    Сохранить подпись
                  </Button>
                  <Button variant="secondary" onClick={() => void copyCaption(fullCaption)}>
                    {copied ? "Скопировано" : "Копировать"}
                  </Button>
                </div>
              </div>

              <div className="card">
                <h2>Оформление</h2>
                <div className={s.styleGrid}>
                  {CAROUSEL_STYLES.map((st) => (
                    <button type="button" key={st.id} className={s.styleCard} aria-pressed={c.style === st.id} onClick={() => changeStyle(st.id)} disabled={locked || Boolean(busy)}>
                      <span className={s.swatch} aria-hidden>
                        {st.swatch.map((color) => (
                          <span key={color} style={{ background: color }} />
                        ))}
                      </span>
                      <span className={s.styleName}>{st.label}</span>
                    </button>
                  ))}
                </div>
                <Field label="Подпись внизу каждой карточки" note="Например, @ваш_аккаунт. Пусто — без подписи.">
                  <input
                    type="text"
                    value={drafts.footer ?? c.footer}
                    maxLength={CAROUSEL_LIMITS.footerMax}
                    onChange={(e) => setDrafts((d) => ({ ...d, footer: e.target.value }))}
                    disabled={locked}
                  />
                </Field>
                <div className="actions">
                  <Button variant="secondary" onClick={() => void save()} disabled={!dirty || locked} busy={busy === "save"}>
                    Сохранить
                  </Button>
                  <Button variant="ghost" onClick={() => void startJob("render", { type: "render" })} disabled={locked || Boolean(busy)}>
                    Повторить рендер
                  </Button>
                </div>
              </div>

              {c.claimsToCheck.length > 0 && (
                <div className="warn-box">
                  <strong>Проверьте перед публикацией.</strong> Claude отметил утверждения, которые стоит сверить с источниками:
                  <ul className={s.claims}>
                    {c.claimsToCheck.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}

              {c.story.length > 0 && (
                <TechDetails summary="Структура истории и исходная идея">
                  <ol className={s.story}>
                    {c.story.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ol>
                  <p className="hint" style={{ marginTop: 10 }}>
                    Идея: {c.request.idea}
                    {c.request.wishes ? ` · Пожелания: ${c.request.wishes}` : ""}
                  </p>
                </TechDetails>
              )}
            </div>

            <aside className={s.aside}>
              {current && (
                <div className="preview-box">
                  <div className="preview-title">
                    Предпросмотр · слайд {index + 1} из {total}
                  </div>
                  {current.render?.file ? (
                    <img className={s.previewImg} src={`/api/carousel/${id}/image/${current.render.file}`} alt={`Слайд ${index + 1}`} />
                  ) : (
                    <div className={`${s.slideImg} ${square ? s.slideImgSquare : ""}`} style={{ cursor: "default", padding: 16 }}>
                      {current.render?.error ?? "Слайд ещё не отрендерен"}
                    </div>
                  )}
                  {staleCurrent && <div className="hint" style={{ marginTop: 8 }}>Картинка показывает прошлую версию — слайд перерендерится.</div>}
                  {!staleCurrent && current.render?.scale !== undefined && current.render.scale < 1 && (
                    <div className="hint" style={{ marginTop: 8 }}>
                      Кегль уменьшен до {Math.round(current.render.scale * 100)}%, чтобы текст поместился.
                    </div>
                  )}
                  <div className={s.previewNav}>
                    <Button variant="ghost" size="sm" disabled={index <= 0} onClick={() => setSelected(c.slides[index - 1].id)}>
                      ← Предыдущий
                    </Button>
                    <Button variant="ghost" size="sm" disabled={index >= total - 1} onClick={() => setSelected(c.slides[index + 1].id)}>
                      Следующий →
                    </Button>
                  </div>
                </div>
              )}

              <div className="card" style={{ marginBottom: 0 }}>
                <h2>Публикация в Instagram</h2>
                <p className="hint">
                  Аккаунт: {section ? (section.instagram.connected ? section.instagram.label ?? "подключён" : "не подключён") : "…"}
                </p>
                {p.status === "published" && (
                  <div className="success-box">
                    Опубликовано{p.publishedAt ? ` ${formatDate(p.publishedAt, true)}` : ""}.{" "}
                    {p.permalink ? (
                      <a href={p.permalink} target="_blank" rel="noreferrer" className="link-btn">
                        Открыть пост
                      </a>
                    ) : (
                      p.note
                    )}
                  </div>
                )}
                {p.status === "uncertain" && (
                  <div className="warn-box">
                    {p.error}
                    <div className="actions" style={{ marginTop: 10 }}>
                      <Button size="sm" onClick={() => void verify()} busy={busy === "verify"} disabled={locked}>
                        Проверить статус
                      </Button>
                    </div>
                  </div>
                )}
                {p.status === "failed" && !pending && <div className="error-box">{p.error}</div>}
                {publishing && <div className="state-box">Публикация идёт: {c.job?.step ?? "в очереди"}. Повторное нажатие заблокировано.</div>}
                {p.status !== "published" && p.status !== "uncertain" && !publishing && (
                  <>
                    {blockers.length > 0 ? (
                      <ul className={s.checklist}>
                        {blockers.map((b) => (
                          <li key={b} className={s.checkBad}>
                            {b}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <ul className={s.checklist}>
                        <li className={s.checkOk}>
                          {total} {plural(total, "слайд", "слайда", "слайдов")} в JPEG, {FORMATS[c.format].label}
                        </li>
                        <li className={s.checkOk}>Подпись в пределах Instagram</li>
                        <li className={s.checkOk}>Аккаунт подключён</li>
                      </ul>
                    )}
                    <Button block onClick={publish} busy={busy === "publish"} disabled={blockers.length > 0 || locked || Boolean(busy)}>
                      {p.status === "failed" ? "Повторить публикацию" : "Опубликовать в Instagram"}
                    </Button>
                    {igProblems.length > 0 && (
                      <p className="hint" style={{ marginTop: 8 }}>
                        <Link href="/settings" className="link-btn">
                          Открыть Настройки
                        </Link>
                      </p>
                    )}
                  </>
                )}
                {p.log.length > 0 && (
                  <TechDetails summary="Журнал публикации">
                    <ul className={s.log}>
                      {p.log
                        .slice()
                        .reverse()
                        .map((line, i) => (
                          <li key={i}>
                            {new Date(line.at).toLocaleTimeString("ru-RU")} — {line.text}
                          </li>
                        ))}
                    </ul>
                  </TechDetails>
                )}
              </div>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
