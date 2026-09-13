"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { BackLink, Button, ErrorState, Field, StatusBadge, TechDetails, type StatusTone } from "../../components/ui";
import type { Carousel, CarouselJob, CarouselStyleId, Slide, SlideKind } from "@/lib/carousel/types";
import { CAROUSEL_STYLES } from "@/lib/carousel/styles";
import { CAROUSEL_LIMITS, FORMATS, IG_LIMITS, TEXT_LIMITS } from "@/lib/carousel/limits";
import { captionProblems, composeCaption, normalizeHashtags, visibleLength } from "@/lib/carousel/text";
import { DEFAULT_TIME_ZONE, offsetLabel, utcToZonedLocal } from "@/lib/carousel/timezone";
import { AccessNotice, api, ApiError, formatDate, isAccessError, isPending, JOB_TITLES, money, plural, type SectionStatus } from "../shared";
import s from "../carousel.module.css";

type ScheduleView = {
  id: string;
  status: string;
  runAt: string;
  timeZone: string;
  localTime: string;
  when: string;
  account: { id: string; igUserId: string; label: string | null };
  snapshotRevision: number;
  stale: boolean;
  permalink: string | null;
  error: string | null;
  history: { at: string; text: string }[];
};

type View = {
  carousel: Carousel;
  status: { text: string; tone: StatusTone; busy?: boolean };
  readiness: string[];
  staleSlideIds: string[];
  jobInterrupted: boolean;
  images: { total: number; ready: number; failed: number; uncertain: number; generating: number } | null;
  schedule: ScheduleView | null;
};

type SlideDraft = { kicker: string; title: string; body: string; bullets: string[]; cta: string; brief: string };
type Drafts = { slides: Record<string, SlideDraft>; caption?: string; hashtags?: string; title?: string; footer?: string };

const KIND_LABEL: Record<SlideKind, string> = { cover: "обложка", content: "слайд", final: "финал" };
const EXAMPLES = ["Сократи третий слайд", "Сделай обложку интригующей", "Упрости язык на всех слайдах", "Добавь в подпись вопрос к подписчикам"];
const IMAGE_EXAMPLES = ["Сделай светлее", "Убери лишние предметы на фоне", "Ближе к персонажу", "Спокойнее и минималистичнее"];

const fieldsOf = (sl: Slide): SlideDraft => ({ kicker: sl.kicker, title: sl.title, body: sl.body, bullets: [...sl.bullets], cta: sl.cta, brief: sl.image?.brief ?? "" });
const cleanBullets = (list: string[]) => list.map((b) => b.trim()).filter(Boolean);
const sameSlide = (sl: Slide, d: SlideDraft) =>
  sl.kicker === d.kicker && sl.title === d.title && sl.body === d.body && sl.cta === d.cta && JSON.stringify(sl.bullets) === JSON.stringify(cleanBullets(d.bullets)) && (sl.image?.brief ?? "") === d.brief;

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

function JobPanel({ job, images, interrupted, onRetry, disabled }: { job: CarouselJob; images: View["images"]; interrupted: boolean; onRetry: (job: CarouselJob) => void; disabled: boolean }) {
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
        {job.note && <div className="hint" style={{ marginTop: 4 }}>{job.note}</div>}
        <div className="actions" style={{ marginTop: 10 }}>
          <Button variant="secondary" size="sm" onClick={() => onRetry(job)} disabled={disabled}>
            Повторить неудавшийся шаг
          </Button>
        </div>
      </div>
    );
  }
  const p = job.progress;
  const stages =
    job.type === "generate"
      ? [
          { label: "Очередь", done: job.state === "running", active: job.state === "queued" },
          { label: "Подготовка содержания", done: p >= 20, active: job.state === "running" && p < 20 },
          ...(images ? [{ label: `Иллюстрации: ${images.ready + images.failed + images.uncertain} из ${images.total || "…"}`, done: p >= 86, active: p >= 20 && p < 86 }] : []),
          { label: "Сборка карточек", done: p >= 98, active: p >= 86 && p < 98 },
          { label: "Готово", done: false, active: p >= 98 },
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
        <div className="progress-fill" style={{ width: `${Math.max(3, p)}%` }} />
      </div>
      <div className="hint">
        Задание выполняется на сервере — страницу можно закрыть и вернуться позже.
        {interrupted ? " Обработчик перезапускается: задание продолжится с места остановки, готовые иллюстрации не оплачиваются заново." : ""}
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
  const [withImage, setWithImage] = useState(false);
  const [imageHint, setImageHint] = useState("");
  const [imageEdit, setImageEdit] = useState("");
  const [copied, setCopied] = useState(false);
  const [publishMode, setPublishMode] = useState<"now" | "later">("now");
  const [accountId, setAccountId] = useState("");
  const [localTime, setLocalTime] = useState("");
  const [timeZone, setTimeZone] = useState(DEFAULT_TIME_ZONE);
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
      .then((st) => {
        setSection(st);
        setTimeZone(st.timeZone || DEFAULT_TIME_ZONE);
        const active = st.instagram.accounts.find((a) => a.active) ?? st.instagram.accounts[0];
        setAccountId((cur) => cur || active?.id || "");
      })
      .catch(() => {});
  }, [load]);

  useEffect(() => {
    if (!localTime) {
      const t = new Date(Date.now() + 2 * 3600_000);
      t.setMinutes(0, 0, 0);
      setLocalTime(utcToZonedLocal(t.getTime(), timeZone));
    }
  }, [timeZone, localTime]);

  // несохранённые правки восстанавливаются после обновления страницы
  useEffect(() => {
    if (!c || restored.current) return;
    restored.current = true;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as Drafts & { revision?: number };
      const slides = Object.fromEntries(Object.entries(saved.slides ?? {}).filter(([sid]) => c.slides.some((x) => x.id === sid)).map(([sid, d]) => [sid, { ...d, brief: typeof (d as SlideDraft).brief === "string" ? (d as SlideDraft).brief : "" }]));
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
  const scheduleBusy = c?.schedule?.status === "queued" || c?.schedule?.status === "publishing";
  useEffect(() => {
    if (!pending && !scheduleBusy) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [pending, scheduleBusy, load]);
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

  const car: Carousel = c;
  const illustrated = c.mode === "illustrated";
  const publishing = c.publish.status === "queued" || c.publish.status === "running";
  const locked = pending || publishing || Boolean(scheduleBusy);
  const total = c.slides.length;
  const square = c.format === "square";
  const index = Math.max(0, c.slides.findIndex((x) => x.id === selected));
  const current = c.slides[index] as Slide | undefined;
  const draft = current ? drafts.slides[current.id] ?? fieldsOf(current) : null;
  const archiveReady = total > 0 && view.staleSlideIds.length === 0 && c.slides.every((x) => x.render?.file);
  const currentImage = current?.image;
  const currentVersion = currentImage?.versions.find((v) => v.id === currentImage.currentId);
  const configOk = section ? section.config.problems.length === 0 : true;
  const sched = view.schedule;
  const scheduledActive = sched?.status === "scheduled";

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
      .map(([sid, d]) => {
        const sl = c.slides.find((x) => x.id === sid)!;
        return { id: sid, kicker: d.kicker, title: d.title, body: d.body, bullets: cleanBullets(d.bullets), cta: d.cta, ...(sl.image && d.brief !== sl.image.brief ? { imageBrief: d.brief } : {}) };
      });
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

  const patchNow = (name: string, body: Record<string, unknown>) => run(name, () => api<View>(`/api/carousel/${id}`, { method: "PATCH", json: { revision: car.revision, ...body } }));
  const startJob = (name: string, payload: Record<string, unknown>) =>
    run(name, () => api<View>(`/api/carousel/${id}/jobs`, { method: "POST", json: { ...payload, revision: car.revision } }));

  function move(i: number, dir: -1 | 1) {
    const order = car.slides.map((x) => x.id);
    const j = i + dir;
    [order[i], order[j]] = [order[j], order[i]];
    void patchNow("order", { order });
  }

  function guardDirty(what: string): boolean {
    if (!dirty) return true;
    setActionError(`Сначала сохраните или отмените правки — ${what}.`);
    return false;
  }

  function changeStyle(style: CarouselStyleId) {
    if (style === car.style || !guardDirty("смена стиля пересоберёт все карточки")) return;
    void patchNow("style", { style });
  }

  function regenerate(sl: Slide) {
    const d = drafts.slides[sl.id];
    if (d && !sameSlide(sl, d) && !confirm("Несохранённые правки этого слайда будут заменены новым текстом. Продолжить?")) return;
    setDrafts((prev) => {
      const next = { ...prev.slides };
      delete next[sl.id];
      return { ...prev, slides: next };
    });
    void startJob("regenerate", { type: "regenerate_slide", slideId: sl.id, hint, withImage }).then((okay) => okay && setHint(""));
  }

  function regenerateImage(sl: Slide) {
    if (!guardDirty("генератор рисует по сохранённому описанию")) return;
    void startJob("image", { type: "image", slideId: sl.id, hint: imageHint }).then((okay) => okay && setImageHint(""));
  }

  function editImage(sl: Slide) {
    if (!guardDirty("правка картинки идёт по сохранённому слайду")) return;
    void startJob("image-edit", { type: "image", slideId: sl.id, mode: "edit", instruction: imageEdit }).then((okay) => okay && setImageEdit(""));
  }

  function retryImages(includeUncertain: boolean) {
    if (includeUncertain && !confirm("У слайдов с неизвестным исходом запрос мог быть оплачен. Повторить их генерацию и заплатить ещё раз?")) return;
    void startJob("images", { type: "images", includeUncertain });
  }

  function instruct() {
    if (!guardDirty("поручение применяется к сохранённой версии")) return;
    void startJob("instruct", { type: "instruct", instruction }).then((okay) => okay && setInstruction(""));
  }

  const accountLabel = (aid: string) => section?.instagram.accounts.find((a) => a.id === aid)?.label ?? aid;

  function publishNow() {
    const ok = confirm(
      `Опубликовать карусель из ${total} ${plural(total, "слайда", "слайдов", "слайдов")} в Instagram (${accountLabel(accountId) || "активный аккаунт"})?\n\nПост появится в профиле сразу, отменить публикацию из Гудини нельзя.`,
    );
    if (!ok) return;
    void run("publish", () => api<View>(`/api/carousel/${id}/publish`, { method: "POST", json: { revision: car.revision, accountId } }));
  }

  const schedule = () => run("schedule", () => api<View>(`/api/carousel/${id}/schedule`, { method: "POST", json: { revision: car.revision, accountId, localTime, timeZone } }));
  const unschedule = () => {
    if (!confirm("Снять публикацию с расписания?")) return;
    void run("unschedule", () => api<View>(`/api/carousel/${id}/schedule`, { method: "DELETE" }));
  };
  const refreshSnapshot = () => run("snapshot", () => api<View>(`/api/carousel/${id}/schedule`, { method: "POST", json: { action: "refresh", revision: car.revision } }));
  const verify = () => run("verify", () => api<View>(`/api/carousel/${id}/publish`, { method: "POST", json: { action: "verify" } }));

  function retry(job: CarouselJob) {
    if (job.type === "publish") return publishNow();
    if (job.type === "verify_publish") return void verify();
    if (job.type === "generate") return void run("retry", () => api<View>(`/api/carousel/${id}/jobs`, { method: "POST", json: { type: "generate" } }));
    if (job.type === "images") return retryImages(Boolean(job.params.includeUncertain));
    void startJob("retry", { type: job.type, slideId: job.params.slideId, hint: job.params.hint, instruction: job.params.instruction, mode: job.params.mode === "edit" ? "edit" : undefined, withImage: job.params.withImage });
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
  const imagesMissing = view.images ? view.images.failed + view.images.uncertain : 0;
  const tzOffset = offsetLabel(Date.now(), timeZone);

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
            {!illustrated && <span>текстовые карточки</span>}
            <StatusBadge tone={view.status.tone} busy={view.status.busy}>
              {view.status.text}
            </StatusBadge>
            {c.cost.usd > 0 && (
              <span title={`Claude ≈ ${money(c.cost.text ?? 0)}, иллюстрации ≈ ${money(c.cost.images ?? 0)}${c.cost.uncertain ? `, запросов с неизвестным исходом: ${c.cost.uncertain} (по оценке)` : ""}`}>
                ≈ {money(c.cost.usd)}
                {c.cost.uncertain ? " (часть по оценке)" : ""}
              </span>
            )}
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
      {section && !section.config.keySet && illustrated && (
        <div className="warn-box">
          Требуется ключ OpenRouter для каруселей (<code>{section.config.keyEnv}</code>): генерация и правки через Claude недоступны, пока ключ не задан. Тексты и порядок можно править вручную.
        </div>
      )}
      {c.job && <JobPanel job={c.job} images={view.images} interrupted={view.jobInterrupted} onRetry={retry} disabled={Boolean(busy) || locked || !configOk} />}
      {!pending && imagesMissing > 0 && (
        <div className="warn-box">
          {view.images!.failed > 0 && `Без иллюстрации: ${view.images!.failed} ${plural(view.images!.failed, "слайд", "слайда", "слайдов")}. `}
          {view.images!.uncertain > 0 && `Исход генерации неизвестен у ${view.images!.uncertain} ${plural(view.images!.uncertain, "слайда", "слайдов", "слайдов")} — запрос мог быть оплачен. `}
          Остальные иллюстрации сохранены.
          <div className="actions" style={{ marginTop: 10 }}>
            {view.images!.failed > 0 && (
              <Button size="sm" onClick={() => retryImages(false)} disabled={locked || Boolean(busy) || !configOk}>
                Повторить недостающие
              </Button>
            )}
            {view.images!.uncertain > 0 && (
              <Button size="sm" variant="secondary" onClick={() => retryImages(true)} disabled={locked || Boolean(busy) || !configOk}>
                Повторить и слайды с неизвестным исходом
              </Button>
            )}
          </div>
        </div>
      )}
      {actionError && (
        <div className="error-box" role="alert">
          {actionError}
        </div>
      )}

      {total === 0 ? (
        !pending && !c.job?.error && <div className="empty" style={{ marginTop: 16 }}>Слайдов пока нет.</div>
      ) : (
        <>
          <section className="section" aria-label="Слайды">
            <div className={s.slides}>
              {c.slides.map((sl, i) => {
                const stale = view.staleSlideIds.includes(sl.id);
                const unsaved = drafts.slides[sl.id] && !sameSlide(sl, drafts.slides[sl.id]);
                const img = sl.image;
                const cur = img?.versions.find((v) => v.id === img.currentId);
                const thumb = sl.render?.file ? `/api/carousel/${id}/image/${sl.render.file}` : cur ? `/api/carousel/${id}/illustration/${cur.file}` : null;
                const imgState = img && !cur ? (img.status === "generating" ? "Рисуется…" : img.status === "uncertain" ? "Исход неизвестен" : img.status === "error" ? "Нет картинки" : "Ждёт картинку") : null;
                return (
                  <div key={sl.id} className={`${s.slideCard} ${sl.id === current?.id ? s.slideCardActive : ""}`}>
                    <button type="button" className={`${s.slideImg} ${square ? s.slideImgSquare : ""}`} onClick={() => setSelected(sl.id)} aria-label={`Открыть слайд ${i + 1}`}>
                      {thumb ? <img src={thumb} alt={`Слайд ${i + 1}`} loading="lazy" /> : <span>{imgState ?? (sl.render?.error ? "Нужны правки" : "Сборка…")}</span>}
                    </button>
                    <div className={s.slideLabel}>
                      <span className={sl.render?.error || img?.status === "error" ? s.slideErr : stale || unsaved || img?.status === "uncertain" ? s.slideWarn : ""}>
                        {i + 1} · {KIND_LABEL[sl.kind]}
                        {unsaved ? " · не сохранён" : img && !cur ? ` · ${imgState?.toLowerCase()}` : stale ? " · обновится" : sl.render?.error ? " · ошибка" : ""}
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
              <span>Есть несохранённые правки. Текст меняется без новой генерации картинок.</span>
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
                          <input type="text" value={b} aria-label={`Пункт ${bi + 1}`} onChange={(e) => setSlideField("bullets", draft.bullets.map((x, k) => (k === bi ? e.target.value : x)))} disabled={locked} />
                          <button type="button" className={s.iconBtn} aria-label={`Удалить пункт ${bi + 1}`} onClick={() => setSlideField("bullets", draft.bullets.filter((_, k) => k !== bi))} disabled={locked}>
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
                      Сохранить и пересобрать карточку
                    </Button>
                    {current.render?.file && !staleCurrent && (
                      <a className="btn btn-secondary" href={`/api/carousel/${id}/image/${current.render.file}?download=1`}>
                        Скачать JPG
                      </a>
                    )}
                  </div>

                  {illustrated && currentImage && (
                    <div className="section">
                      <h2 style={{ fontSize: 17, marginBottom: 8 }}>Иллюстрация</h2>
                      {currentImage.status === "error" && currentImage.error && <div className="error-box plain">{currentImage.error}</div>}
                      {currentImage.status === "uncertain" && currentImage.error && <div className="warn-box">{currentImage.error}</div>}
                      {currentImage.versions.length > 0 && (
                        <div className="field">
                          <span>
                            Версии ({currentImage.versions.length}) — нажмите, чтобы вернуть предыдущую
                          </span>
                          <div className={s.versions}>
                            {currentImage.versions
                              .slice()
                              .reverse()
                              .map((v, k) => (
                                <button
                                  type="button"
                                  key={v.id}
                                  className={s.versionBtn}
                                  aria-pressed={v.id === currentImage.currentId}
                                  title={`${v.kind === "edit" ? `Правка: ${v.instruction ?? ""}` : "Генерация"} · ${new Date(v.at).toLocaleString("ru-RU")} · ${money(v.cost)}${v.estimated ? " (оценка)" : ""}`}
                                  onClick={() => v.id !== currentImage.currentId && guardDirty("выбор версии пересоберёт карточку") && void patchNow("version", { slides: [{ id: current.id, imageVersionId: v.id }] })}
                                  disabled={locked || Boolean(busy)}
                                >
                                  <img src={`/api/carousel/${id}/illustration/${v.file}`} alt="" loading="lazy" />
                                  <span className={s.versionTag}>{currentImage.versions.length - k}</span>
                                </button>
                              ))}
                          </div>
                        </div>
                      )}
                      <div className="field">
                        <span>Где текст на карточке</span>
                        <div className={s.segmented} role="group" aria-label="Место текста">
                          {(["bottom", "top"] as const).map((pl) => (
                            <button
                              type="button"
                              key={pl}
                              aria-pressed={currentImage.textPlacement === pl}
                              onClick={() => currentImage.textPlacement !== pl && guardDirty("смена места текста пересоберёт карточку") && void patchNow("placement", { slides: [{ id: current.id, textPlacement: pl }] })}
                              disabled={locked || Boolean(busy)}
                            >
                              {pl === "bottom" ? "Внизу" : "Вверху"}
                            </button>
                          ))}
                        </div>
                        <div className="field-note">Меняет только наложение текста — картинка не перерисовывается.</div>
                      </div>
                      <Field label="Описание иллюстрации для генератора" note="По-английски, что изображено именно на этом слайде. Сохраняется вместе с текстом; действует при следующей генерации.">
                        <textarea rows={3} value={draft.brief} onChange={(e) => setSlideField("brief", e.target.value)} disabled={locked} />
                      </Field>
                      <div className="field">
                        <span>Новая иллюстрация</span>
                        <div className={s.inline}>
                          <input type="text" placeholder="Пожелание, необязательно: другой ракурс, больше воздуха…" value={imageHint} maxLength={CAROUSEL_LIMITS.hintMax} onChange={(e) => setImageHint(e.target.value)} disabled={locked} />
                          <Button variant="secondary" onClick={() => regenerateImage(current)} busy={busy === "image"} disabled={locked || Boolean(busy) || !configOk}>
                            Перерисовать
                          </Button>
                        </div>
                        <div className="field-note">Только этот слайд; предыдущие версии останутся. ≈ {money(section?.models.find((m) => m.id === (c.imageModel ?? section.config.imageModel))?.perImageUsd ?? 0)}.</div>
                      </div>
                      {currentVersion && (
                        <div className="field">
                          <span>Поправить текущую картинку</span>
                          <div className={s.inline}>
                            <input type="text" placeholder="Например: сделай светлее" value={imageEdit} maxLength={CAROUSEL_LIMITS.instructionMax} onChange={(e) => setImageEdit(e.target.value)} disabled={locked} />
                            <Button variant="secondary" onClick={() => editImage(current)} busy={busy === "image-edit"} disabled={locked || Boolean(busy) || imageEdit.trim().length < 3 || !configOk}>
                              Поправить
                            </Button>
                          </div>
                          <div className={s.chips}>
                            {IMAGE_EXAMPLES.map((x) => (
                              <button type="button" key={x} className={s.chip} onClick={() => setImageEdit(x)} disabled={locked}>
                                {x}
                              </button>
                            ))}
                          </div>
                          <div className="field-note">Текущая картинка уходит генератору референсом; другие слайды не меняются.</div>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="field">
                    <span>Переписать содержание слайда через Claude</span>
                    <div className={s.inline}>
                      <input type="text" placeholder="Пожелание, необязательно: проще, с примером…" value={hint} maxLength={CAROUSEL_LIMITS.hintMax} onChange={(e) => setHint(e.target.value)} disabled={locked} />
                      <Button variant="secondary" onClick={() => regenerate(current)} busy={busy === "regenerate"} disabled={locked || Boolean(busy) || !configOk}>
                        Переписать
                      </Button>
                    </div>
                    {illustrated && (
                      <label className="check" style={{ marginTop: 8 }}>
                        <input type="checkbox" checked={withImage} onChange={(e) => setWithImage(e.target.checked)} disabled={locked} /> И нарисовать новую иллюстрацию
                      </label>
                    )}
                  </div>
                </div>
              )}

              <div className="card">
                <h2>Поручение Claude</h2>
                <p className="hint">Опишите правку словами — Claude изменит только то, о чём попросили; готовые иллюстрации остаются, новые слайды получат свои.</p>
                <textarea rows={2} style={{ marginTop: 10 }} value={instruction} maxLength={CAROUSEL_LIMITS.instructionMax} placeholder="Например: сократи третий слайд" onChange={(e) => setInstruction(e.target.value)} disabled={locked} />
                <div className={s.chips}>
                  {EXAMPLES.map((x) => (
                    <button type="button" key={x} className={s.chip} onClick={() => setInstruction(x)} disabled={locked}>
                      {x}
                    </button>
                  ))}
                </div>
                <div className="actions">
                  <Button onClick={instruct} busy={busy === "instruct"} disabled={locked || Boolean(busy) || instruction.trim().length < 3 || !configOk}>
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
                {illustrated ? (
                  <>
                    <p className="hint">
                      Карусель хранит копию оформления аккаунта на момент создания. Изменили{" "}
                      <Link href="/carousel/settings" className="link-btn">
                        оформление
                      </Link>{" "}
                      — примените его сюда, карточки пересоберутся без новых иллюстраций.
                    </p>
                    {section && (
                      <Field label="Модель иллюстраций для этой карусели">
                        <select value={c.imageModel ?? section.config.imageModel ?? ""} onChange={(e) => void patchNow("model", { imageModel: e.target.value })} disabled={locked || Boolean(busy)}>
                          {section.models.map((m) => (
                            <option key={m.id} value={m.id} disabled={m.available === false}>
                              {m.label}
                              {m.available === false ? ` — недоступна: ${m.reason}` : ` · ≈ ${money(m.perImageUsd)}`}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                    <div className="actions">
                      <Button variant="secondary" onClick={() => guardDirty("оформление пересоберёт карточки") && void patchNow("design", { applyDesign: true })} disabled={locked || Boolean(busy)}>
                        Применить текущее оформление
                      </Button>
                      <Button variant="ghost" onClick={() => void startJob("render", { type: "render" })} disabled={locked || Boolean(busy)}>
                        Пересобрать карточки
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
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
                      <input type="text" value={drafts.footer ?? c.footer} maxLength={CAROUSEL_LIMITS.footerMax} onChange={(e) => setDrafts((d) => ({ ...d, footer: e.target.value }))} disabled={locked} />
                    </Field>
                    <div className="actions">
                      <Button variant="secondary" onClick={() => void save()} disabled={!dirty || locked} busy={busy === "save"}>
                        Сохранить
                      </Button>
                      <Button variant="ghost" onClick={() => void startJob("render", { type: "render" })} disabled={locked || Boolean(busy)}>
                        Повторить рендер
                      </Button>
                    </div>
                  </>
                )}
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

              {(c.story.length > 0 || c.visual) && (
                <TechDetails summary="Структура истории, визуальная концепция и исходная идея">
                  {c.story.length > 0 && (
                    <ol className={s.story}>
                      {c.story.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ol>
                  )}
                  {c.visual && (
                    <p className="hint" style={{ marginTop: 10 }}>
                      Визуальная концепция: {c.visual.idea} · Стиль: {c.visual.style} · Палитра: {c.visual.palette} · Свет: {c.visual.lighting}
                      {c.visual.characters.length > 0 && ` · Персонажи: ${c.visual.characters.map((ch) => `${ch.name} — ${ch.look}`).join("; ")}`}
                    </p>
                  )}
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
                  ) : currentVersion ? (
                    <img className={s.previewImg} src={`/api/carousel/${id}/illustration/${currentVersion.file}`} alt={`Иллюстрация слайда ${index + 1}`} />
                  ) : (
                    <div className={`${s.slideImg} ${square ? s.slideImgSquare : ""}`} style={{ cursor: "default", padding: 16 }}>
                      {current.render?.error ?? currentImage?.error ?? "Карточка ещё не собрана"}
                    </div>
                  )}
                  {staleCurrent && <div className="hint" style={{ marginTop: 8 }}>Картинка показывает прошлую версию — карточка пересоберётся.</div>}
                  {!current.render?.file && currentVersion && <div className="hint" style={{ marginTop: 8 }}>Показана иллюстрация без текста — карточка собирается.</div>}
                  {!staleCurrent && current.render?.scale !== undefined && current.render.scale < 1 && (
                    <div className="hint" style={{ marginTop: 8 }}>Кегль уменьшен до {Math.round(current.render.scale * 100)}%, чтобы текст поместился.</div>
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
                {p.status === "published" && (
                  <div className="success-box">
                    Опубликовано{p.publishedAt ? ` ${formatDate(p.publishedAt, true)}` : ""}
                    {p.account?.label ? ` в ${p.account.label}` : ""}.{" "}
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

                {sched && sched.status !== "canceled" && (
                  <div className={sched.status === "missed" || sched.status === "failed" ? "warn-box" : "state-box"}>
                    <strong>
                      {sched.status === "scheduled" && "Запланировано"}
                      {sched.status === "queued" && "Отправляется по расписанию"}
                      {sched.status === "publishing" && "Публикуется по расписанию"}
                      {sched.status === "published" && "Опубликовано по расписанию"}
                      {sched.status === "failed" && "Публикация по расписанию не удалась"}
                      {sched.status === "uncertain" && "Исход публикации по расписанию не подтверждён"}
                      {sched.status === "missed" && "Публикация просрочена"}
                    </strong>
                    <div style={{ marginTop: 4 }}>
                      {sched.when} · {sched.account.label ?? sched.account.igUserId}
                    </div>
                    {sched.error && <div style={{ marginTop: 4 }}>{sched.error}</div>}
                    {sched.stale && (
                      <div style={{ marginTop: 6 }}>
                        Карусель изменилась после назначения: в расписании стоит прежняя версия.
                        <div className="actions" style={{ marginTop: 8 }}>
                          <Button size="sm" onClick={() => void refreshSnapshot()} busy={busy === "snapshot"} disabled={locked || blockers.length > 0}>
                            Обновить версию в расписании
                          </Button>
                          <Button size="sm" variant="ghost" onClick={unschedule} disabled={locked}>
                            Снять с расписания
                          </Button>
                        </div>
                      </div>
                    )}
                    {(sched.status === "scheduled" || sched.status === "missed" || sched.status === "failed") && !sched.stale && (
                      <div className="actions" style={{ marginTop: 8 }}>
                        <Button size="sm" variant="ghost" onClick={unschedule} disabled={locked}>
                          Снять с расписания
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {p.status !== "published" && p.status !== "uncertain" && !publishing && !scheduleBusy && (
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
                          {illustrated ? ", все с иллюстрациями" : ""}
                        </li>
                        <li className={s.checkOk}>Подпись в пределах Instagram</li>
                        <li className={s.checkOk}>Аккаунт подключён</li>
                      </ul>
                    )}
                    {section && section.instagram.accounts.length > 1 && (
                      <Field label="Аккаунт Instagram" note="Закрепляется за этой публикацией: смена активного аккаунта в Настройках её не перенаправит.">
                        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={locked}>
                          {section.instagram.accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label ?? a.igUserId}
                              {a.active ? " (активный)" : ""}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                    <div className={s.segmented} role="group" aria-label="Когда публиковать" style={{ margin: "10px 0" }}>
                      <button type="button" aria-pressed={publishMode === "now"} onClick={() => setPublishMode("now")}>
                        Сейчас
                      </button>
                      <button type="button" aria-pressed={publishMode === "later"} onClick={() => setPublishMode("later")}>
                        По расписанию
                      </button>
                    </div>
                    {publishMode === "now" ? (
                      <Button block onClick={publishNow} busy={busy === "publish"} disabled={blockers.length > 0 || locked || Boolean(busy)}>
                        {p.status === "failed" ? "Повторить публикацию" : "Опубликовать сейчас"}
                      </Button>
                    ) : (
                      <>
                        <div className={s.scheduleGrid}>
                          <Field label="Дата и время">
                            <input type="datetime-local" value={localTime} onChange={(e) => setLocalTime(e.target.value)} disabled={locked} />
                          </Field>
                          <Field label={`Часовой пояс (${tzOffset})`}>
                            <select value={timeZone} onChange={(e) => setTimeZone(e.target.value)} disabled={locked}>
                              {(section?.timeZones ?? [DEFAULT_TIME_ZONE]).map((tz) => (
                                <option key={tz} value={tz}>
                                  {tz}
                                </option>
                              ))}
                            </select>
                          </Field>
                        </div>
                        <div className="hint" style={{ margin: "6px 0 10px" }}>
                          Публикуется просмотренная версия карточек и подписи. Контейнеры Instagram создаются в момент отправки. Если сервер не работал в назначенное время, пост выйдет при
                          запуске, но не позже чем через час; иначе публикация станет «просроченной» и будет ждать вашего решения.
                        </div>
                        <Button block onClick={() => void schedule()} busy={busy === "schedule"} disabled={blockers.length > 0 || locked || Boolean(busy) || !localTime}>
                          {scheduledActive ? "Перенести публикацию" : "Запланировать"}
                        </Button>
                      </>
                    )}
                    {igProblems.length > 0 && (
                      <p className="hint" style={{ marginTop: 8 }}>
                        <Link href="/settings" className="link-btn">
                          Открыть Настройки
                        </Link>
                      </p>
                    )}
                  </>
                )}
                {(p.log.length > 0 || (sched && sched.history.length > 0)) && (
                  <TechDetails summary="Журнал публикации">
                    <ul className={s.log}>
                      {[...(sched?.history ?? []).map((l) => ({ ...l, src: "расписание" })), ...p.log.map((l) => ({ ...l, src: "публикация" }))]
                        .sort((a, b) => b.at.localeCompare(a.at))
                        .map((line, i) => (
                          <li key={i}>
                            {new Date(line.at).toLocaleString("ru-RU")} · {line.src} — {line.text}
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
