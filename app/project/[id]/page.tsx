"use client";

import { use, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import Teleprompter from "./Teleprompter";
import { saveRecording, loadRecording, deleteRecording, shareOrDownload, type StoredRecording } from "@/lib/recordingStore";
import { BackLink, Button, ErrorState, Field, StatusBadge, TechDetails, VideoPreview, type StatusTone } from "@/app/components/ui";

type Meta = { title: string; description: string; hashtags: string[] };
type Publication = { platform: string; status: string; url?: string; message?: string; at: string };
type MontageStyle = "cards" | "ai_film";
type Project = {
  id: string;
  topic: string;
  script: string | null;
  scriptDemo?: boolean;
  rawVideo: string | null;
  processedVideo: string | null;
  processing: { state: "idle" | "running" | "done" | "error"; step: string; progress: number; error?: string };
  subtitlesSource?: string;
  cover?: string | null;
  coverStatus?: "ok" | "failed" | "headline_failed";
  coverReason?: string;
  brollCount?: number;
  meta: Meta | null;
  publications: Publication[];
  montageStyle?: MontageStyle;
  outputs?: Partial<Record<MontageStyle, { file: string; at: string; brollCount?: number; subtitlesSource?: string }>>;
  aiFilm?: {
    request?: "plan" | "generate";
    status?: "planned" | "generated" | "failed";
    spent?: number;
    generatedAt?: string;
    error?: string;
    plan?: AiFilmPlanView;
  };
};

type AiFilmPlanView = {
  version?: number;
  duration: number;
  character?: { id: string; name: string; referenceCount: number };
  universeId?: string;
  universe?: { id: string; name: string; hash: string };
  bible: {
    visualStyle: string;
    mood: string;
    storyArc?: { understand: string; gudiniRole: string; beginning: string; development: string; conflict: string; climax: string; meaning: string };
    supportingCharacters?: { name: string; function: string }[];
  };
  beats: {
    id: string; start: number; end: number; meaning: string; storyBeat?: string;
    displayMode: "author" | "full_ai" | "hybrid"; purpose: string; priority: string;
    universeAdaptation?: string;
    visualAction: string; location: string; continuityGroup: string | null; reduced?: string;
  }[];
  groups: { id: string; start: number; end: number; shotIds: string[]; chain: boolean; displayMode: string }[];
  shots: { id: string; groupId: string; mode: string; veoSeconds: number; usedSeconds: number; model: string; generationProfile: string; cost: number; useReferences: boolean; beatIds: string[] }[];
  pricing?: { model: string; pricePerSec: number; source: string };
  budgetUsd?: number;
  stats: {
    speechSeconds: number; aiSeconds: number; generatedSeconds: number; overheadSeconds?: number; generationEfficiency?: number; coverage: number; calls: number;
    groups: number; independentGroups: number; chains: number; estimatedCost: number; estimatedWallMinutes: number; concurrency: number;
  };
  warnings?: string[];
};

const AI_FILM_PLAN_VERSION = 3;
/** Режимы кадра словами автора; технические имена — только в «Технических сведениях». */
const MODE_RU: Record<string, string> = { author: "Автор", full_ai: "Сцена на весь экран", hybrid: "Автор + сцена" };
const MODE_TECH: Record<string, string> = { author: "AUTHOR", full_ai: "FULL_AI", hybrid: "HYBRID" };
const STYLE_NAME: Record<MontageStyle, string> = { cards: "С картинками", ai_film: "AI-фильм" };
const STYLE_SUB: Record<MontageStyle, string> = { cards: "Иллюстрации над автором", ai_film: "Видеосцены Google Veo" };

const PLATFORMS = [
  { key: "tiktok", name: "TikTok" },
  { key: "youtube", name: "YouTube Shorts" },
  { key: "instagram", name: "Instagram Reels" },
] as const;

const STEPS = ["Сценарий", "Запись", "Монтаж", "Публикация"];

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const fmtDuration = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m} мин ${s} с` : `${s} с`;
};
const usd = (n: number) => `$${n.toFixed(2)}`;

/** Итог стиля: у старых проектов без outputs последний монтаж — всегда карточки. */
function styleOutput(project: Project, style: MontageStyle) {
  const out = project.outputs?.[style];
  if (out) return { src: `/api/projects/${project.id}/video?which=processed&style=${style}&t=${encodeURIComponent(out.at)}`, legacy: false, info: out };
  const hasOutputs = Object.keys(project.outputs ?? {}).length > 0;
  if (!hasOutputs && project.processedVideo && style === "cards") {
    return { src: `/api/projects/${project.id}/video?which=processed&t=legacy`, legacy: true, info: { at: "", brollCount: project.brollCount, subtitlesSource: project.subtitlesSource } };
  }
  return null;
}
const hasAnyVideo = (p: Project) => Boolean(p.processedVideo || p.outputs?.cards || p.outputs?.ai_film);

const subtitlesLabel = (src?: string) => (src === "scribe" ? "субтитры по речи" : src === "whisper" ? "субтитры по речи" : "субтитры по тексту сценария");

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState("");
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}`);
      if (res.ok) {
        const p: Project = await res.json();
        setProject(p);
        setLoadError("");
        return p;
      }
      const j = await res.json().catch(() => ({}));
      setLoadError(res.status === 404 ? "Проект не найден" : j.error ?? `ответ ${res.status}`);
    } catch (e: any) {
      setLoadError(String(e?.message ?? e));
    }
    return null;
  }, [id]);

  useEffect(() => {
    reload().then((p) => {
      if (!p) return;
      if (hasAnyVideo(p)) setStep(3);
      else if (p.processing.state === "running") setStep(2);
      else if (p.rawVideo) setStep(2);
      else if (p.script) setStep(0);
    });
  }, [reload]);

  // ошибка одного шага не тянется на следующий
  const goStep = (i: number) => {
    setError("");
    setStep(i);
  };

  if (!project) {
    return (
      <main>
        <BackLink href="/">Проекты</BackLink>
        {loadError ? (
          <ErrorState title="Не удалось загрузить проект" text={loadError} onRetry={() => void reload()} />
        ) : (
          <div className="skeleton" style={{ height: 240 }} aria-busy="true" />
        )}
      </main>
    );
  }

  // галочка — реально выполненная работа этого этапа
  const stepsDone = [
    Boolean(project.script),
    Boolean(project.rawVideo),
    hasAnyVideo(project),
    project.publications.some((p) => p.status === "published"),
  ];

  return (
    <main>
      <BackLink href="/">Проекты</BackLink>
      <h1 className="page-title">{project.topic}</h1>

      <nav className="steps" aria-label="Этапы проекта">
        {STEPS.map((label, i) => (
          <button
            key={label}
            type="button"
            className={`step ${step === i ? "active" : ""} ${stepsDone[i] ? "done" : ""}`}
            aria-current={step === i ? "step" : undefined}
            onClick={() => goStep(i)}
          >
            <span className="step-n" aria-hidden>{stepsDone[i] && step !== i ? "✓" : i + 1}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {error && <div className="error-box">{error}</div>}

      {step === 0 && <ScriptStep project={project} setProject={setProject} setError={setError} onNext={() => goStep(1)} />}
      {step === 1 && <RecordStep project={project} reload={reload} setError={setError} onNext={() => goStep(2)} />}
      {step === 2 && <ProcessStep project={project} reload={reload} setError={setError} onNext={() => goStep(3)} onBack={() => goStep(1)} />}
      {step === 3 && <PublishStep project={project} setProject={setProject} reload={reload} setError={setError} onBack={() => goStep(2)} />}
    </main>
  );
}

/* ================== Шаг 1: Сценарий ================== */

function ScriptStep({
  project,
  setProject,
  setError,
  onNext,
}: {
  project: Project;
  setProject: (p: Project) => void;
  setError: (e: string) => void;
  onNext: () => void;
}) {
  const [script, setScript] = useState(project.script ?? "");
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const busy = saving || regenerating;
  const dirty = script !== (project.script ?? "");
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  const seconds = Math.round(words / 2.5);

  async function regenerate() {
    setRegenerating(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ what: "script" }),
      });
      const p = await res.json();
      if (!res.ok) throw new Error(p.error);
      setProject(p);
      setScript(p.script ?? "");
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRegenerating(false);
    }
  }

  async function saveAndNext() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      });
      const p = await res.json();
      if (!res.ok) throw new Error(p.error ?? "Не удалось сохранить сценарий");
      setProject(p);
      onNext();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Сценарий</h2>
        <span className="spacer" />
        {saving ? (
          <StatusBadge tone="accent" busy>Сохраняем</StatusBadge>
        ) : dirty ? (
          <StatusBadge tone="warn">Не сохранено</StatusBadge>
        ) : project.script ? (
          <StatusBadge tone="success">Сохранено</StatusBadge>
        ) : null}
      </div>
      {project.scriptDemo && (
        <div className="state-box">
          Сценарий составлен по шаблону: ключ Anthropic не задан. Добавьте его в разделе «Настройки», и следующий вариант напишет модель.
        </div>
      )}
      <textarea rows={14} value={script} onChange={(e) => setScript(e.target.value)} disabled={regenerating} aria-label="Текст сценария" />
      <p className="hint" style={{ margin: "8px 0 0" }}>
        {words} слов · около {fmtDuration(seconds)} чтения
        {seconds > 75 ? " · длинновато для короткого ролика" : ""}
      </p>
      <div className="actions">
        <Button onClick={saveAndNext} busy={saving} disabled={busy || !script.trim()}>
          Сохранить и продолжить
        </Button>
        <Button variant="secondary" onClick={regenerate} busy={regenerating} disabled={busy}>
          Другой вариант
        </Button>
      </div>
    </div>
  );
}

/* ================== Шаг 2: Запись / загрузка ================== */

function RecordStep({
  project,
  reload,
  setError,
  onNext,
}: {
  project: Project;
  reload: () => Promise<Project | null>;
  setError: (e: string) => void;
  onNext: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadNote, setUploadNote] = useState("");
  const [drag, setDrag] = useState(false);
  const [prompterOpen, setPrompterOpen] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [rawDuration, setRawDuration] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Файл и место обрыва держатся в памяти: после ошибки загрузку можно продолжить,
  // а не записывать дубль заново.
  const pendingRef = useRef<{ file: File; offset: number } | null>(null);
  const [pendingSize, setPendingSize] = useState<number | null>(null);
  // Копия записи в хранилище телефона (IndexedDB): переживает ошибку сети и перезагрузку.
  const [stored, setStored] = useState<StoredRecording | null>(null);
  useEffect(() => {
    let alive = true;
    void loadRecording(project.id).then((r) => { if (alive) setStored(r); });
    return () => { alive = false; };
  }, [project.id]);

  // Потоковая отправка: куски записи уходят на сервер во время съёмки, «стоп» лишь
  // закрывает файл. Раньше запись сначала целиком лежала в памяти страницы, потом
  // грузилась минуту, и обрыв сети на 80 МБ уносил её без следа.
  const streamRef = useRef<{ name: string; sent: number; total: number; chain: Promise<void>; failed: string | null; last: Blob | null } | null>(null);
  const [streamNote, setStreamNote] = useState("");
  const mbOf = (n: number) => Math.round(n / 1048576);

  async function putChunk(name: string, chunk: Blob, offset: number, total: number): Promise<any> {
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await fetch(`/api/projects/${project.id}/upload`, {
          method: "PUT",
          headers: { "x-filename": encodeURIComponent(name), "x-file-size": String(total), "x-offset": String(offset) },
          body: chunk,
        });
      } catch (e: any) {
        if (++attempt >= 6) throw new Error(`сеть: ${String(e?.message ?? e)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      const json: any = await res.json().catch(() => ({}));
      if (res.ok) return json;
      if (res.status === 409 && typeof json.received === "number") {
        if (json.received >= offset + chunk.size) return json; // уже на сервере (дубль после обрыва)
        throw new Error(`рассинхрон: на сервере ${mbOf(json.received)} МБ, ожидалось ${mbOf(offset)} МБ`);
      }
      if (++attempt >= 5) throw new Error(json.error ?? `HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  function startStream(mimeType: string) {
    const name = mimeType.startsWith("video/mp4") ? "record.mp4" : "record.webm";
    streamRef.current = { name, sent: 0, total: 0, chain: Promise.resolve(), failed: null, last: null };
    setStreamNote("");
  }

  function pushChunk(chunk: Blob) {
    const st = streamRef.current;
    if (!st || st.failed) return;
    const offset = st.total;
    st.total += chunk.size;
    st.last = chunk;
    st.chain = st.chain.then(async () => {
      if (st.failed) return;
      try {
        await putChunk(st.name, chunk, offset, 0);
        st.sent = offset + chunk.size;
        setStreamNote(`${mbOf(st.sent)} МБ`);
      } catch (e: any) {
        st.failed = String(e?.message ?? e);
        setStreamNote("связь прервалась, дошлём после записи");
      }
    });
  }

  /** Закрыть файл на сервере: последний кусок повторно с общим размером — сервер видит дубль и финализирует. */
  async function finishStream(): Promise<boolean> {
    const st = streamRef.current;
    if (!st) return false;
    await st.chain;
    if (st.failed || st.sent !== st.total || !st.last || st.total === 0) return false;
    const json = await putChunk(st.name, st.last, st.total - st.last.size, st.total);
    return Boolean(json?.uploadedSize || json?.done || json?.rawVideo);
  }

  async function acceptTake(blob: Blob) {
    const name = blob.type.startsWith("video/mp4") ? "record.mp4" : "record.webm";
    const file = new File([blob], name, { type: blob.type });
    setError("");
    setUploading(true);
    setUploadPct(99);
    setUploadNote("Завершаем загрузку…");
    let ok = false;
    try {
      ok = await finishStream();
    } catch {
      ok = false;
    }
    if (ok) {
      await deleteRecording(project.id);
      setStored(null);
      streamRef.current = null;
      setUploadNote("");
      setUploading(false);
      setReplacing(false);
      await reload();
      onNext();
      return;
    }
    // поток не дошёл до конца: докачиваем обычным путём с места, до которого он дошёл
    const from = streamRef.current?.sent ?? 0;
    streamRef.current = null;
    await upload(file, from);
  }

  async function uploadStored() {
    if (!stored) return;
    const file = new File([stored.blob], stored.name, { type: stored.blob.type });
    await upload(file, 0);
  }

  async function upload(file: File, startOffset = 0) {
    setError("");
    setUploading(true);
    setUploadPct(Math.round((startOffset / file.size) * 100));
    // грузим кусками по 4 МБ: большие тела запросов режутся прокси хостинга
    const CHUNK = 4 * 1024 * 1024;
    const name = file.name || "record.webm";
    let offset = startOffset;
    pendingRef.current = { file, offset };
    setPendingSize(file.size);
    // Телефон гасит экран посреди загрузки, Safari уходит в фон, и соединение рвётся
    // (у сайта в журнале ECONNRESET на 80-м мегабайте). Пока идёт загрузка — экран не гаснет.
    let wakeLock: { release: () => Promise<void> } | null = null;
    try {
      wakeLock = (await (navigator as any).wakeLock?.request?.("screen")) ?? null;
    } catch {}
    const mb = (n: number) => Math.round(n / 1048576);
    try {
      while (offset < file.size) {
        const chunk = file.slice(offset, Math.min(offset + CHUNK, file.size));
        let attempt = 0;
        for (;;) {
          let res: Response;
          try {
            res = await fetch(`/api/projects/${project.id}/upload`, {
              method: "PUT",
              headers: {
                // кириллица в имени файла роняла fetch: заголовки только latin-1
                "x-filename": encodeURIComponent(name),
                "x-file-size": String(file.size),
                "x-offset": String(offset),
              },
              body: chunk,
            });
          } catch (e: any) {
            // сеть оборвалась (экран, фон, Wi-Fi): тот же кусок повторяется, сервер
            // отличит дубль от продолжения по x-offset
            if (++attempt >= 6) throw new Error(`связь прервалась на ${mb(offset)} МБ из ${mb(file.size)} — ${String(e?.message ?? e)}`);
            setUploadNote(`связь прервалась, повтор ${attempt}…`);
            await new Promise((r) => setTimeout(r, 2000 * attempt));
            continue;
          }
          const json: any = await res.json().catch(() => ({}));
          if (res.ok) {
            offset = typeof json.received === "number" ? json.received : offset + chunk.size;
            if (json.uploadedSize) offset = file.size;
            break;
          }
          if (res.status === 409 && typeof json.received === "number") {
            offset = json.received; // продолжаем с фактического места
            break;
          }
          if (++attempt >= 5) throw new Error(json.error ?? `HTTP ${res.status}`);
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
        pendingRef.current = { file, offset };
        setUploadPct(Math.round((offset / file.size) * 100));
        setUploadNote(`${mb(offset)} из ${mb(file.size)} МБ`);
      }
      pendingRef.current = null;
      setPendingSize(null);
      await deleteRecording(project.id);
      setStored(null);
      setUploadNote("");
      setUploading(false);
      setReplacing(false);
      await reload();
      onNext();
    } catch (e: any) {
      setUploading(false);
      setUploadNote("");
      setError(`Не удалось загрузить запись: ${String(e?.message ?? e)}. Файл остался в памяти страницы, нажмите «Продолжить загрузку».`);
    } finally {
      try {
        await wakeLock?.release();
      } catch {}
    }
  }

  function resumeUpload() {
    const pending = pendingRef.current;
    if (!pending) return;
    void upload(pending.file, pending.offset);
  }

  const pending = !uploading && pendingRef.current ? pendingRef.current : null;
  const showChooser = !project.rawVideo || replacing;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Запись</h2>
          <span className="spacer" />
          {project.rawVideo && !uploading && <StatusBadge tone="success">Запись загружена</StatusBadge>}
          {uploading && <StatusBadge tone="accent" busy>Загружается</StatusBadge>}
        </div>

        {pending && (
          <div className="state-box">
            Загрузка прервалась на {mbOf(pending.offset)} МБ из {mbOf(pendingSize ?? pending.file.size)} МБ. Файл остался в памяти страницы.
            <div className="actions">
              <Button onClick={resumeUpload}>Продолжить загрузку</Button>
            </div>
          </div>
        )}

        {stored && !uploading && !pending && (
          <div className="state-box">
            <div style={{ fontWeight: 600, color: "var(--text)" }}>Запись сохранена на устройстве</div>
            <div className="hint">
              {new Date(stored.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} · {mbOf(stored.blob.size)} МБ · ещё не загружена на сервер
            </div>
            <div className="actions">
              <Button onClick={() => void uploadStored()}>Продолжить загрузку</Button>
              <Button variant="secondary" onClick={() => void shareOrDownload(stored.blob, stored.name)}>Скачать</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  if (!confirm("Удалить сохранённую запись с этого устройства?")) return;
                  void deleteRecording(project.id);
                  setStored(null);
                }}
              >
                Удалить
              </Button>
            </div>
          </div>
        )}

        {uploading && (
          <div className="state-box" aria-live="polite">
            Загружаем запись: {uploadPct}%{uploadNote ? ` · ${uploadNote}` : ""}
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${uploadPct}%` }} />
            </div>
            <div className="hint">Не закрывайте страницу до конца загрузки.</div>
          </div>
        )}

        {!uploading && showChooser && (
          <>
            <p className="hint" style={{ marginBottom: 14 }}>
              Снимайте вертикально, при хорошем свете и звуке.
            </p>
            <div className="choice-grid">
              <button type="button" className="choice-card" onClick={() => setPrompterOpen(true)} disabled={!project.script}>
                <div className="choice-title">Записать с телесуфлёром</div>
                <div className="choice-sub">{project.script ? "Текст сценария плывёт по экрану, пока камера пишет" : "Сначала сохраните сценарий"}</div>
              </button>
              <button
                type="button"
                className={`choice-card ${drag ? "drag" : ""}`}
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) upload(file);
                }}
              >
                <div className="choice-title">Загрузить видео</div>
                <div className="choice-sub">MP4, MOV или WebM. Можно перетащить файл сюда</div>
              </button>
            </div>
            {replacing && (
              <div className="actions">
                <Button variant="ghost" onClick={() => setReplacing(false)}>Оставить текущую запись</Button>
              </div>
            )}
          </>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
          }}
        />

        {project.rawVideo && !uploading && !replacing && (
          <div className="workspace" style={{ marginTop: 8 }}>
            <div>
              <p className="hint">
                Запись загружена{rawDuration ? ` · ${fmtDuration(rawDuration)}` : ""}. Дальше монтаж: субтитры, картинки или AI-сцены.
              </p>
              <div className="actions">
                <Button onClick={onNext}>К монтажу</Button>
                <Button variant="secondary" onClick={() => setReplacing(true)}>Заменить запись</Button>
              </div>
            </div>
            <div className="preview-col">
              <div className="preview-box">
                <video
                  className="video-preview"
                  src={`/api/projects/${project.id}/video?which=raw`}
                  controls
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration;
                    if (Number.isFinite(d) && d > 0) setRawDuration(d);
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {prompterOpen && (
        <Teleprompter
          script={project.script ?? ""}
          onClose={() => setPrompterOpen(false)}
          onRecordingStart={startStream}
          onChunk={pushChunk}
          uploadNote={streamNote}
          onTakeReady={(blob) => {
            const name = blob.type.startsWith("video/mp4") ? "record.mp4" : "record.webm";
            void saveRecording(project.id, blob, name).then((saved) => { if (saved) setStored({ projectId: project.id, blob, name, at: new Date().toISOString() }); });
          }}
          onSave={(blob) => void shareOrDownload(blob, blob.type.startsWith("video/mp4") ? "record.mp4" : "record.webm")}
          onRecorded={(blob) => {
            setPrompterOpen(false);
            void acceptTake(blob);
          }}
        />
      )}
    </>
  );
}

/* ================== Шаг 3: Монтаж ================== */

function StylePicker({ value, onChange, disabled, outputs }: { value: MontageStyle; onChange: (s: MontageStyle) => void; disabled?: boolean; outputs: Record<MontageStyle, boolean> }) {
  return (
    <div className="style-picker" role="group" aria-label="Стиль монтажа">
      {(["cards", "ai_film"] as const).map((s) => (
        <button key={s} type="button" className="style-card" aria-pressed={value === s} onClick={() => onChange(s)} disabled={disabled}>
          <div className="style-scheme" aria-hidden>
            {s === "cards" ? (
              <>
                <div className="s-top" />
                <div className="s-author" />
              </>
            ) : (
              <div className="s-top full" />
            )}
          </div>
          <div>
            <div className="style-name">{STYLE_NAME[s]}</div>
            <div className="style-sub">{STYLE_SUB[s]}</div>
            {outputs[s] && <div className="style-sub" style={{ color: "var(--success)" }}>Версия готова</div>}
          </div>
        </button>
      ))}
    </div>
  );
}

function ProcessStep({
  project,
  reload,
  setError,
  onNext,
  onBack,
}: {
  project: Project;
  reload: () => Promise<Project | null>;
  setError: (e: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const processing = project.processing;
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (processing.state !== "running") return;
    const timer = setInterval(reload, 1500);
    return () => clearInterval(timer);
  }, [processing.state, reload]);

  const style: MontageStyle = project.montageStyle ?? "cards";
  const otherStyle: MontageStyle = style === "cards" ? "ai_film" : "cards";
  const current = styleOutput(project, style);
  const other = styleOutput(project, otherStyle);
  const filmPlan = project.aiFilm?.plan;
  const planStale = Boolean(filmPlan && filmPlan.version !== AI_FILM_PLAN_VERSION);
  const running = processing.state === "running";

  async function start(request?: "plan" | "generate") {
    setError("");
    setStarting(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request ? { request } : {}),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Не удалось запустить монтаж");
        return;
      }
      await reload();
    } finally {
      setStarting(false);
    }
  }

  async function chooseStyle(next: MontageStyle) {
    if (next === style) return;
    setError("");
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ montageStyle: next }),
    });
    if (!res.ok) setError("Не удалось переключить стиль");
    await reload();
  }

  // после ошибки: карточки — тот же монтаж; AI-фильм — та же фаза, но устаревший план сначала обновляется
  const retryRequest = style === "ai_film" ? (planStale || !filmPlan ? "plan" : (project.aiFilm?.request ?? "plan")) : undefined;

  const previewStatus: ReactNode = running ? (
    <StatusBadge tone="accent" busy>Монтируется</StatusBadge>
  ) : current ? (
    <StatusBadge tone="success">Видео готово</StatusBadge>
  ) : (
    <StatusBadge>Ещё не создана</StatusBadge>
  );
  const previewCaption = current
    ? [subtitlesLabel(current.info.subtitlesSource), current.info.brollCount ? `перебивок: ${current.info.brollCount}` : null, current.legacy ? "последний монтаж до разделения версий" : null]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  return (
    <div className="workspace">
      <div>
        <div className="card">
          <div className="card-head">
            <h2>Монтаж</h2>
          </div>
          <StylePicker value={style} onChange={(s) => void chooseStyle(s)} disabled={running} outputs={{ cards: Boolean(styleOutput(project, "cards")), ai_film: Boolean(styleOutput(project, "ai_film")) }} />

          {!project.rawVideo && (
            <div className="state-box">
              Сначала нужна запись: без неё монтировать нечего.
              <div className="actions">
                <Button variant="secondary" onClick={onBack}>К записи</Button>
              </div>
            </div>
          )}

          {running && (
            <div className="state-box" aria-live="polite">
              <div className="row">
                <span className="spin" aria-hidden />
                <b>{processing.step || "Монтаж"}</b>
                <span className="spacer" />
                <span className="hint">{processing.progress}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${processing.progress}%` }} />
              </div>
              <div className="hint">Версия «{STYLE_NAME[project.montageStyle ?? "cards"]}». Страницу можно закрыть, монтаж продолжится на сервере.</div>
            </div>
          )}

          {!running && processing.state === "error" && (
            <ErrorState
              title="Монтаж не завершился"
              text={processing.error || project.aiFilm?.error || "Причина не названа"}
              onRetry={project.rawVideo ? () => void start(retryRequest) : undefined}
              retryLabel="Повторить"
              busy={starting}
            />
          )}

          {!running && project.rawVideo && !current && other && (
            <div className="state-box">
              Эта версия ещё не создана. Есть готовая версия «{STYLE_NAME[otherStyle]}».
              <div className="actions">
                <button type="button" className="link-btn" onClick={() => void chooseStyle(otherStyle)}>
                  Посмотреть {otherStyle === "ai_film" ? "AI-фильм" : "версию с картинками"}
                </button>
              </div>
            </div>
          )}

          {!running && project.rawVideo && style === "cards" && (
            <>
              <p className="hint">Кадр 9:16, выровненная громкость, крупные субтитры по словам и картинки-иллюстрации над автором. Заголовок, описание и хэштеги подбираются автоматически.</p>
              {current && !project.cover && (
                <div className="warn-box">Видео готово, но обложки нет. Создать её можно на шаге «Публикация».</div>
              )}
              <div className="actions">
                {current ? (
                  <>
                    <Button onClick={onNext}>К публикации</Button>
                    <Button variant="secondary" onClick={() => void start()} busy={starting}>Смонтировать заново</Button>
                  </>
                ) : (
                  <Button onClick={() => void start()} busy={starting}>Смонтировать</Button>
                )}
              </div>
            </>
          )}

          {!running && project.rawVideo && style === "ai_film" && (
            <AiFilmPanel project={project} plan={filmPlan} stale={planStale} hasOutput={Boolean(current)} starting={starting} onStart={start} onNext={onNext} />
          )}
        </div>
      </div>

      <div className="preview-col">
        <VideoPreview
          key={style}
          src={running ? null : current?.src}
          title={
            <>
              {previewStatus}
              <span>{STYLE_NAME[style]}</span>
            </>
          }
          caption={previewCaption}
          empty={running ? "Превью появится после монтажа" : `Здесь появится версия «${STYLE_NAME[style]}»`}
        />
      </div>
    </div>
  );
}

/* ================== План и генерация AI-фильма ================== */

function AiFilmPanel({
  project,
  plan,
  stale,
  hasOutput,
  starting,
  onStart,
  onNext,
}: {
  project: Project;
  plan?: AiFilmPlanView;
  stale: boolean;
  hasOutput: boolean;
  starting: boolean;
  onStart: (request: "plan" | "generate") => Promise<void>;
  onNext: () => void;
}) {
  const intro = <p className="hint">Голос и субтитры идут непрерывно, а картинка переключается между вами и сценами, которые Google Veo рисует по вашей истории. Главный герой сцен всегда один и тот же.</p>;

  if (!plan || stale) {
    return (
      <>
        {intro}
        {stale ? (
          <div className="warn-box">План собран старой версией. Обновите план перед генерацией, цена и сцены будут пересчитаны.</div>
        ) : (
          <p className="hint">Сначала план: разбор истории и раскадровка без генерации видео. Цена генерации будет видна в плане до запуска.</p>
        )}
        <div className="actions">
          <Button onClick={() => void onStart("plan")} busy={starting}>{stale ? "Обновить план" : "Подготовить план"}</Button>
          {hasOutput && <Button variant="secondary" onClick={onNext}>К публикации</Button>}
        </div>
      </>
    );
  }

  const st = plan.stats;
  const aiBeats = plan.beats.filter((b) => b.displayMode !== "author");
  const noScenes = st.calls === 0;
  const generated = project.aiFilm?.status === "generated";
  const price = usd(st.estimatedCost);

  return (
    <>
      {intro}
      <div className="plan-summary">
        <div className="tile">
          <div className="tile-label">Длительность</div>
          <div className="tile-value">{fmtTime(st.speechSeconds)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">AI-сцены</div>
          <div className="tile-value">{aiBeats.length}</div>
          <div className="tile-sub">{st.aiSeconds} с из {st.speechSeconds} с на экране</div>
        </div>
        <div className="tile">
          <div className="tile-label">Генерация</div>
          <div className="tile-value">≈ {price}</div>
          <div className="tile-sub">оценка до запуска</div>
        </div>
        <div className="tile">
          <div className="tile-label">Время</div>
          <div className="tile-value">≈ {st.estimatedWallMinutes} мин</div>
        </div>
      </div>

      {plan.warnings?.map((w, i) => (
        <div key={i} className="warn-box">{w}</div>
      ))}

      {noScenes && (
        <div className="state-box">
          В плане нет AI-сцен: {plan.warnings?.length ? "см. замечания выше" : "разбор истории не выделил эпизодов для генерации"}. Обновите план или измените сценарий.
        </div>
      )}

      {generated && (
        <div className="success-box">
          Видео создано{typeof project.aiFilm?.spent === "number" ? `. Фактически потрачено в последнем запуске: ${usd(project.aiFilm.spent)}` : ""}. Повторный запуск возьмёт готовые сцены из кэша и заплатит только за новые.
        </div>
      )}

      <div className="actions">
        {hasOutput ? (
          <>
            <Button onClick={onNext}>К публикации</Button>
            <Button variant="secondary" onClick={() => void onStart("generate")} busy={starting} disabled={noScenes}>Создать заново · ≈ {price}</Button>
          </>
        ) : (
          <Button onClick={() => void onStart("generate")} busy={starting} disabled={noScenes}>Создать видео · ≈ {price}</Button>
        )}
        <button type="button" className="link-btn" onClick={() => void onStart("plan")} disabled={starting}>Обновить план</button>
      </div>

      <h3 className="h-block" style={{ fontSize: 16, margin: "20px 0 8px" }}>Сцены</h3>
      <div className="scene-list">
        {plan.beats.map((b) => {
          const ai = b.displayMode !== "author";
          return (
            <div className="scene-row" key={b.id}>
              <div className="scene-time">{fmtTime(b.start)}–{fmtTime(b.end)}</div>
              <div className={`scene-mode ${b.displayMode === "full_ai" ? "ai" : b.displayMode === "hybrid" ? "hybrid" : ""}`}>{MODE_RU[b.displayMode] ?? b.displayMode}</div>
              <div className="scene-text">
                {ai ? b.universeAdaptation || b.visualAction : b.meaning}
                {ai && <div className="scene-note">{b.meaning}</div>}
                {b.reduced && <div className="scene-note" style={{ color: "var(--warn)" }}>{b.reduced}</div>}
              </div>
            </div>
          );
        })}
      </div>

      <TechDetails>
        <p>
          Персонаж: {plan.character?.name ?? "Gudini"}{plan.character ? ` (${plan.character.id}, эталонов ${plan.character.referenceCount})` : ""} ·
          мир: {plan.universe?.name ?? plan.universeId ?? "—"}{plan.universe?.hash ? ` · ${plan.universe.hash}` : ""} · план v{plan.version ?? "?"}
        </p>
        <p>
          Стиль: {plan.bible.visualStyle} · настроение: {plan.bible.mood}
          {plan.bible.storyArc?.gudiniRole ? ` · роль героя: ${plan.bible.storyArc.gudiniRole}` : ""}
        </p>
        {plan.bible.storyArc && (
          <p>
            История: {plan.bible.storyArc.beginning} → {plan.bible.storyArc.development} → {plan.bible.storyArc.conflict} → {plan.bible.storyArc.climax}. Смысл: {plan.bible.storyArc.meaning}
          </p>
        )}
        <p>
          Покрытие {Math.round(st.coverage * 100)}% · Veo-секунд {st.generatedSeconds}
          {typeof st.overheadSeconds === "number" ? ` (сверх экрана ${st.overheadSeconds} с, эффективность ${Math.round((st.generationEfficiency ?? 0) * 100)}%)` : ""} ·
          вызовов API {st.calls} · групп {st.groups} (независимых {st.independentGroups}, цепочек {st.chains}) · параллельно {st.concurrency}
          {plan.pricing ? ` · ${plan.pricing.model} $${plan.pricing.pricePerSec}/с (${plan.pricing.source})` : ""}
          {plan.budgetUsd ? ` · бюджет $${plan.budgetUsd}` : ""}
        </p>
        <table className="tech-table">
          <thead>
            <tr>
              <th>Время</th>
              <th>Режим</th>
              <th>Цель · приоритет</th>
              <th>Действие · место</th>
              <th>Группа · вызовы</th>
            </tr>
          </thead>
          <tbody>
            {plan.beats.map((b) => {
              const shots = plan.shots.filter((sh) => sh.beatIds.includes(b.id));
              const group = shots[0] ? plan.groups.find((g) => g.id === shots[0].groupId) : undefined;
              const cost = shots.reduce((a, sh) => a + sh.cost, 0);
              return (
                <tr key={b.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtTime(b.start)}–{fmtTime(b.end)}<br />{(b.end - b.start).toFixed(1)} с</td>
                  <td>{MODE_TECH[b.displayMode] ?? b.displayMode}</td>
                  <td>{b.purpose} · {b.priority}</td>
                  <td>{b.displayMode === "author" ? "—" : `${b.visualAction}${b.location ? ` — ${b.location}` : ""}`}</td>
                  <td>
                    {b.displayMode === "author" ? "—" : shots.length ? (
                      <>
                        {group?.id}{group?.chain ? " (цепочка)" : ""}<br />
                        {shots.map((sh) => `${sh.mode} ${sh.veoSeconds}с`).join(" + ")}<br />
                        {shots[0].generationProfile} · {shots[0].model.replace("-generate-001", "")}{shots[0].useReferences ? " · эталоны" : ""}<br />
                        ${cost.toFixed(2)}
                      </>
                    ) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TechDetails>
    </>
  );
}

/* ================== Обложка (только Full-AI + QC) ================== */

function CoverBlock({ project, reload }: { project: Project; reload: () => Promise<Project | null> }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [headline, setHeadline] = useState("");
  const [error, setError] = useState("");

  const regenerate = async (customHeadline?: string) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/cover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(customHeadline ? { headline: customHeadline } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Не удалось создать обложку");
      await reload();
      setEditing(false);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // Автоматической проверки обложки нет: она либо нарисовалась, либо нет.
  const failed = !project.cover && project.coverStatus === "failed";
  const headlineFailed = project.coverStatus === "headline_failed";
  const status: ReactNode = busy ? (
    <StatusBadge tone="accent" busy>Создаём обложку</StatusBadge>
  ) : project.cover ? (
    <StatusBadge tone="success">Готова</StatusBadge>
  ) : headlineFailed ? (
    <StatusBadge tone="warn">Нет заголовка</StatusBadge>
  ) : failed ? (
    <StatusBadge tone="warn">Не создалась</StatusBadge>
  ) : (
    <StatusBadge>Нет обложки</StatusBadge>
  );

  const reason = failed
    ? `Обложка не нарисовалась${project.coverReason ? `: ${project.coverReason}` : ""}. Создание заново — одна платная генерация.`
    : headlineFailed
      ? "Не удалось подобрать заголовок, сохраняющий тему ролика. Картинка не создавалась, деньги не потрачены."
      : null;

  const editor = editing ? (
    <div style={{ marginTop: 10 }}>
      <Field label="Заголовок обложки, 2–4 слова">
        <input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Короткий заголовок" maxLength={40} type="text" />
      </Field>
      <div className="actions" style={{ marginTop: 10 }}>
        <Button size="sm" disabled={!headline.trim()} busy={busy} onClick={() => regenerate(headline)}>Создать с этим заголовком</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Отмена</Button>
      </div>
    </div>
  ) : (
    <div className="actions" style={{ marginTop: 10 }}>
      <Button size="sm" variant={project.cover ? "secondary" : "primary"} busy={busy} onClick={() => regenerate()}>
        {headlineFailed ? "Подобрать заголовок заново" : "Создать заново"}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>Изменить заголовок</Button>
    </div>
  );

  return (
    <div className="cover-block">
      {project.cover ? (
        <img src={`/api/projects/${project.id}/video?which=cover&t=${encodeURIComponent(project.outputs?.cards?.at ?? project.outputs?.ai_film?.at ?? "")}`} alt="Обложка" />
      ) : (
        <div className="thumb" style={{ width: 96, height: 170 }}>—</div>
      )}
      <div>
        <div className="row">
          <span className="h-block" style={{ fontSize: 16 }}>Обложка</span>
          {status}
        </div>
        {reason && <div className="hint" style={{ marginTop: 6 }}>{reason}</div>}
        {!reason && project.cover && <div className="hint" style={{ marginTop: 6 }}>Первый кадр ролика и превью на площадках. Не нравится — создайте заново.</div>}
        {!reason && !project.cover && <div className="hint" style={{ marginTop: 6 }}>Обложка создаётся при монтаже. Можно создать её отдельно.</div>}
        {editor}
        {error && <div className="error-box">{error}</div>}
      </div>
    </div>
  );
}

/* ================== Экран публикации TikTok (Direct Post) ================== */

type TikTokScreen = {
  direct: boolean;
  connected: boolean;
  creator: {
    nickname: string;
    avatarUrl: string;
    privacyOptions: string[];
    commentDisabled: boolean;
    duetDisabled: boolean;
    stitchDisabled: boolean;
    maxDurationSec: number;
  } | null;
  caption: string;
  coverSec: number;
  error?: string;
};

const PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Все",
  MUTUAL_FOLLOW_FRIENDS: "Взаимные подписчики",
  FOLLOWER_OF_CREATOR: "Подписчики",
  SELF_ONLY: "Только я",
};

/**
 * Правила TikTok для прямой публикации: автор видит, в какой аккаунт уйдёт ролик, сам
 * выбирает видимость из списка, который вернул TikTok, включает комментарии/дуэты/стичи,
 * правит подпись, помечает коммерческий контент и подтверждает согласие с правилами.
 * Без этого экрана аудит Content Posting API не проходит.
 */
function TikTokPanel({
  project,
  screen,
  busy,
  onPublish,
  videoStyle,
}: {
  project: Project;
  screen: TikTokScreen;
  busy: boolean;
  onPublish: (opts: Record<string, unknown>) => Promise<void>;
  videoStyle?: MontageStyle;
}) {
  const [title, setTitle] = useState(screen.caption);
  const [privacy, setPrivacy] = useState("");
  const [allowComment, setAllowComment] = useState(!screen.creator?.commentDisabled);
  const [allowDuet, setAllowDuet] = useState(!screen.creator?.duetDisabled);
  const [allowStitch, setAllowStitch] = useState(!screen.creator?.stitchDisabled);
  const [coverSec, setCoverSec] = useState(String(screen.coverSec));
  const [commercial, setCommercial] = useState(false);
  const [brandOrganic, setBrandOrganic] = useState(false);
  const [brandContent, setBrandContent] = useState(false);
  const [consent, setConsent] = useState(false);

  const c = screen.creator;
  const options = c?.privacyOptions ?? [];
  const brandedBlocksSelf = commercial && brandContent;
  const commercialIncomplete = commercial && !brandOrganic && !brandContent;
  const ready = Boolean(privacy) && consent && !commercialIncomplete && !(brandedBlocksSelf && privacy === "SELF_ONLY") && title.trim().length > 0;

  const consentText = commercial && brandContent
    ? (
      <>
        Публикуя, вы соглашаетесь с{" "}
        <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">Branded Content Policy</a> и{" "}
        <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a> TikTok.
      </>
    )
    : (
      <>
        Публикуя, вы соглашаетесь с{" "}
        <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a> TikTok.
      </>
    );

  if (!screen.connected || !c) {
    return (
      <div className="card tiktok-panel">
        <h2>Публикация в TikTok</h2>
        <div className="error-box">{screen.error ?? "Аккаунт TikTok не подключён. Подключите его в разделе «Настройки»."}</div>
      </div>
    );
  }

  return (
    <div className="card tiktok-panel">
      <h2>Публикация в TikTok</h2>
      <div className="tiktok-author">
        {c.avatarUrl && <img src={c.avatarUrl} alt="" />}
        <div>
          <div style={{ fontWeight: 600 }}>Ролик уйдёт в аккаунт {c.nickname ? `@${c.nickname}` : "TikTok"}</div>
          <div className="hint">
            {options.length === 1 && options[0] === "SELF_ONLY"
              ? "TikTok разрешает этому приложению только видимость «Только я»: приложение ещё не прошло аудит."
              : c.maxDurationSec
                ? `Максимальная длительность для аккаунта: ${c.maxDurationSec} с.`
                : ""}
          </div>
        </div>
      </div>

      <div className="tiktok-grid">
        <div>
          <video className="video-preview" src={`/api/projects/${project.id}/video?which=processed${videoStyle ? `&style=${videoStyle}` : ""}`} controls playsInline preload="metadata" />
          <p className="hint" style={{ textAlign: "center", marginTop: 6 }}>Так ролик увидят в TikTok</p>
        </div>
        <div>
          <label>Подпись</label>
          <textarea rows={6} value={title} maxLength={2200} onChange={(e) => setTitle(e.target.value)} />
          <p className="hint" style={{ marginTop: 4 }}>{title.length} / 2200</p>

          <label>Кто увидит видео</label>
          <select value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
            <option value="" disabled>Выберите…</option>
            {options.map((o) => (
              <option key={o} value={o} disabled={brandedBlocksSelf && o === "SELF_ONLY"}>
                {PRIVACY_LABELS[o] ?? o}
              </option>
            ))}
          </select>
          {brandedBlocksSelf && <p className="hint">Брендированный контент нельзя публиковать с видимостью «Только я».</p>}

          <label>Разрешить зрителям</label>
          <div className="tiktok-toggles">
            <label className="check">
              <input type="checkbox" checked={allowComment} disabled={c.commentDisabled} onChange={(e) => setAllowComment(e.target.checked)} />
              Комментарии{c.commentDisabled && " (выключены в настройках аккаунта)"}
            </label>
            <label className="check">
              <input type="checkbox" checked={allowDuet} disabled={c.duetDisabled} onChange={(e) => setAllowDuet(e.target.checked)} />
              Дуэты{c.duetDisabled && " (выключены в настройках аккаунта)"}
            </label>
            <label className="check">
              <input type="checkbox" checked={allowStitch} disabled={c.stitchDisabled} onChange={(e) => setAllowStitch(e.target.checked)} />
              Стичи{c.stitchDisabled && " (выключены в настройках аккаунта)"}
            </label>
          </div>

          <label>Кадр для обложки, секунда видео</label>
          <input type="text" inputMode="decimal" value={coverSec} onChange={(e) => setCoverSec(e.target.value)} style={{ maxWidth: 140 }} />
          <p className="hint">0 — ваша обложка: она стоит первым кадром ролика. Другое число — кадр из видео на этой секунде.</p>

          <label>Коммерческий контент</label>
          <div className="tiktok-toggles">
            <label className="check">
              <input type="checkbox" checked={commercial} onChange={(e) => setCommercial(e.target.checked)} />
              Видео продвигает бренд, товар или услугу
            </label>
            {commercial && (
              <>
                <label className="check" style={{ marginLeft: 22 }}>
                  <input type="checkbox" checked={brandOrganic} onChange={(e) => setBrandOrganic(e.target.checked)} />
                  Ваш бренд — вы продвигаете себя или свой бизнес
                </label>
                <label className="check" style={{ marginLeft: 22 }}>
                  <input type="checkbox" checked={brandContent} onChange={(e) => setBrandContent(e.target.checked)} />
                  Брендированный контент — вы продвигаете другой бренд или чужой продукт
                </label>
                {commercialIncomplete && <p className="hint">Отметьте хотя бы один вариант.</p>}
                {(brandOrganic || brandContent) && (
                  <p className="hint">
                    На видео появится пометка «{brandContent ? "Платное партнёрство" : "Промо-контент"}».
                  </p>
                )}
              </>
            )}
          </div>

          <label className="check" style={{ marginTop: 14 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{consentText}</span>
          </label>

          <div className="row" style={{ marginTop: 14 }}>
            <button
              className="btn"
              disabled={!ready || busy}
              onClick={() =>
                onPublish({
                  title: title.trim(),
                  privacyLevel: privacy,
                  allowComment,
                  allowDuet,
                  allowStitch,
                  coverMs: Math.max(0, Math.round((Number(coverSec.replace(",", ".")) || 0) * 1000)),
                  brandContent: commercial && brandContent,
                  brandOrganic: commercial && brandOrganic,
                  consent,
                })
              }
            >
              {busy ? <span className="spin" /> : "Опубликовать в TikTok"}
            </button>
            {!ready && <span className="hint">Нужны подпись, выбор видимости и согласие с правилами.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================== Шаг 4: Публикация ================== */

type AccountView = { id: string; label: string; at: string; active: boolean };

/** Итог публикации словами: успех, черновик, демо, пропуск и ошибка — разные состояния. */
function publicationView(pub: Publication): { tone: StatusTone; text: string } {
  if (pub.status === "published") {
    const draft = /черновик|private/i.test(pub.message ?? "");
    return draft ? { tone: "accent", text: "Черновик" } : { tone: "success", text: "Опубликовано" };
  }
  if (pub.status === "demo") return { tone: "neutral", text: "Демо-режим" };
  if (pub.status === "skipped") return { tone: "neutral", text: "Пропущено" };
  if (pub.status === "error") return { tone: "error", text: "Ошибка" };
  return { tone: "neutral", text: pub.status };
}

function PublishStep({
  project,
  setProject,
  reload,
  setError,
  onBack,
}: {
  project: Project;
  setProject: (p: Project) => void;
  reload: () => Promise<Project | null>;
  setError: (e: string) => void;
  onBack: () => void;
}) {
  const meta = project.meta ?? { title: "", description: "", hashtags: [] };
  const [title, setTitle] = useState(meta.title);
  const [description, setDescription] = useState(meta.description);
  const [hashtags, setHashtags] = useState(meta.hashtags.join(" "));
  const [busy, setBusy] = useState<string | null>(null);
  const [metaState, setMetaState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [captionCopied, setCaptionCopied] = useState(false);
  const [connected, setConnected] = useState<Record<string, boolean> | null>(null);
  const [accounts, setAccounts] = useState<Partial<Record<string, AccountView[]>>>({});
  // какой ролик публиковать: по умолчанию выбранный стиль, если у него есть итог
  const availableStyles = (["cards", "ai_film"] as const).filter((k) => styleOutput(project, k));
  const [pubStyle, setPubStyle] = useState<MontageStyle | undefined>(() => {
    const cur = project.montageStyle ?? "cards";
    if (styleOutput(project, cur)) return cur;
    return availableStyles[0];
  });
  const chosen = pubStyle ? styleOutput(project, pubStyle) : null;

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        setConnected(s.connected ?? {});
        setAccounts(s.accounts ?? {});
      })
      .catch(() => setConnected({}));
  }, []);

  async function saveMeta() {
    setMetaState("saving");
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        meta: { title, description, hashtags: hashtags.split(/\s+/).filter(Boolean) },
      }),
    });
    // ответ с ошибкой раньше записывался в проект как есть, и страница ломалась
    const p = await res.json();
    if (!res.ok) {
      setMetaState("error");
      setError(p.error ?? "Не удалось сохранить описание");
      return false;
    }
    setProject(p);
    setMetaState("saved");
    return true;
  }

  async function regenMeta() {
    setBusy("meta");
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ what: "meta" }),
      });
      const p = await res.json();
      if (!res.ok) throw new Error(p.error);
      setProject(p);
      setTitle(p.meta?.title ?? "");
      setDescription(p.meta?.description ?? "");
      setHashtags((p.meta?.hashtags ?? []).join(" "));
      setMetaState("saved");
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const [tiktokScreen, setTiktokScreen] = useState<TikTokScreen | null>(null);
  const [tiktokOpen, setTiktokOpen] = useState(false);
  const [batchNote, setBatchNote] = useState<string[]>([]);
  useEffect(() => {
    fetch(`/api/projects/${project.id}/tiktok`)
      .then((r) => r.json())
      .then((j) => setTiktokScreen(j))
      .catch(() => setTiktokScreen(null));
  }, [project.id]);

  /** Подпись для TikTok: в черновики API её не передаёт, автор вставляет вручную. */
  async function copyCaption() {
    const meta = project?.meta;
    if (!meta) return;
    const caption = [meta.title, meta.description, (meta.hashtags ?? []).join(" ")]
      .filter(Boolean)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(caption);
      setCaptionCopied(true);
      setTimeout(() => setCaptionCopied(false), 2000);
    } catch {
      window.prompt("Скопируйте подпись вручную:", caption);
    }
  }

  async function publishTo(platform: string, extra: Record<string, unknown> = {}) {
    setBusy(platform);
    setError("");
    try {
      if (!(await saveMeta())) return;
      const res = await fetch(`/api/projects/${project.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, ...(pubStyle ? { style: pubStyle } : {}), ...extra }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      await reload();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Во все подключённые платформы по очереди. live: YouTube и Instagram сразу, TikTok через
   * форму — TikTok требует, чтобы видимость выбрал сам автор. draft: YouTube приватным
   * черновиком, TikTok в черновики приложения, Instagram пропускается (черновиков у API нет).
   */
  async function publishAll(mode: "live" | "draft") {
    setBusy("all");
    setError("");
    setBatchNote([]);
    const notes: string[] = [];
    try {
      if (!(await saveMeta())) return;
      for (const { key, name } of PLATFORMS) {
        if (!connected?.[key]) {
          notes.push(`${name}: не подключён, пропущен`);
          continue;
        }
        if (key === "tiktok" && mode === "live" && tiktokScreen?.direct) {
          notes.push("TikTok: откройте форму ниже, выберите видимость и опубликуйте");
          setTiktokOpen(true);
          continue;
        }
        const res = await fetch(`/api/projects/${project.id}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: key, mode, ...(pubStyle ? { style: pubStyle } : {}) }),
        });
        const j = await res.json();
        const pub = j.publication;
        if (!res.ok) notes.push(`${name}: ошибка — ${j.error}`);
        else if (pub?.status === "published") notes.push(`${name}: готово`);
        else notes.push(`${name}: ${pub?.message ?? pub?.status ?? "без ответа"}`);
      }
      await reload();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBatchNote(notes);
      setBusy(null);
    }
  }

  if (!hasAnyVideo(project)) {
    return (
      <div className="card">
        <h2>Публикация</h2>
        <div className="state-box">
          Сначала нужно смонтировать видео.
          <div className="actions">
            <Button variant="secondary" onClick={onBack}>К монтажу</Button>
          </div>
        </div>
      </div>
    );
  }

  const anyConnected = Boolean(connected && PLATFORMS.some((p) => connected[p.key]));
  const metaBadge: ReactNode =
    metaState === "saving" ? <StatusBadge tone="accent" busy>Сохраняем</StatusBadge>
    : metaState === "saved" ? <StatusBadge tone="success">Сохранено</StatusBadge>
    : metaState === "error" ? <StatusBadge tone="error">Не сохранено</StatusBadge>
    : null;

  return (
    <div className="workspace">
      <div>
        <div className="card">
          <div className="card-head">
            <h2>Публикация</h2>
            <span className="spacer" />
            {availableStyles.length > 1 ? (
              <div className="version-picker" role="group" aria-label="Какую версию публиковать">
                {availableStyles.map((s) => (
                  <button key={s} type="button" aria-pressed={pubStyle === s} onClick={() => setPubStyle(s)} disabled={busy !== null}>
                    {STYLE_NAME[s]}
                  </button>
                ))}
              </div>
            ) : (
              <span className="hint">Версия: {pubStyle ? STYLE_NAME[pubStyle] : "последний монтаж"}</span>
            )}
          </div>
          {availableStyles.length > 1 && <p className="hint" style={{ marginBottom: 14 }}>Готовы обе версии. Опубликовать можно каждую по очереди.</p>}
          <CoverBlock project={project} reload={reload} />
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Описание</h2>
            <span className="spacer" />
            {metaBadge}
          </div>
          <Field label="Заголовок">
            <input type="text" value={title} onChange={(e) => { setTitle(e.target.value); setMetaState("idle"); }} onBlur={saveMeta} />
          </Field>
          <Field label="Описание">
            <textarea rows={4} value={description} onChange={(e) => { setDescription(e.target.value); setMetaState("idle"); }} onBlur={saveMeta} />
          </Field>
          <Field label="Хэштеги" note="Через пробел, решётка не обязательна">
            <input type="text" value={hashtags} onChange={(e) => { setHashtags(e.target.value); setMetaState("idle"); }} onBlur={saveMeta} />
          </Field>
          <div className="actions" style={{ marginTop: 14 }}>
            <Button variant="secondary" size="sm" onClick={regenMeta} busy={busy === "meta"} disabled={busy !== null && busy !== "meta"}>
              Другой вариант описания
            </Button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Платформы</h2>
          </div>
          <div className="platform-list">
            {PLATFORMS.map(({ key, name }) => {
              const pub = project.publications.find((p) => p.platform === key);
              const isConnected = connected?.[key] ?? false;
              const active = accounts[key]?.find((a) => a.active)?.label;
              const view = pub ? publicationView(pub) : null;
              return (
                <div className="platform-row" key={key}>
                  <div style={{ minWidth: 0 }}>
                    <div className="platform-name">{name}</div>
                    <div className="platform-account">
                      {connected === null ? "Проверяем подключение…" : isConnected ? (active ? `Аккаунт: ${active}` : "Аккаунт подключён") : "Аккаунт не подключён"}
                    </div>
                    {pub && view && (
                      <div className="platform-result">
                        <StatusBadge tone={view.tone}>{view.text}</StatusBadge>{" "}
                        {pub.url && (
                          <a href={pub.url} target="_blank" rel="noreferrer" className="link-btn" style={{ marginLeft: 6 }}>
                            Открыть
                          </a>
                        )}
                        {pub.message && <div className="hint" style={{ marginTop: 4 }}>{pub.message}</div>}
                      </div>
                    )}
                  </div>
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    {isConnected ? (
                      <>
                        {key === "tiktok" && tiktokScreen?.direct ? (
                          <Button size="sm" onClick={() => setTiktokOpen((o) => !o)} disabled={busy !== null}>
                            {tiktokOpen ? "Скрыть форму" : pub ? "Опубликовать снова" : "Опубликовать"}
                          </Button>
                        ) : (
                          <Button size="sm" onClick={() => publishTo(key)} busy={busy === key} disabled={busy !== null}>
                            {pub ? "Опубликовать снова" : "Опубликовать"}
                          </Button>
                        )}
                        {key !== "instagram" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => publishTo(key, { mode: "draft" })}
                            disabled={busy !== null}
                            title={key === "youtube" ? "Приватный черновик в YouTube Studio" : "Черновик в TikTok: Уведомления → Загрузки"}
                          >
                            В черновики
                          </Button>
                        )}
                        {key === "tiktok" && project.meta && !tiktokScreen?.direct && (
                          <Button size="sm" variant="ghost" onClick={copyCaption} title="TikTok не принимает подпись через API при заливке в черновики — вставьте её в приложении">
                            {captionCopied ? "Скопировано" : "Скопировать подпись"}
                          </Button>
                        )}
                      </>
                    ) : (
                      <Link href="/settings" className="btn btn-secondary btn-sm">
                        Подключить
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {tiktokOpen && tiktokScreen && (
            <TikTokPanel
              project={project}
              screen={tiktokScreen}
              videoStyle={pubStyle}
              busy={busy === "tiktok"}
              onPublish={async (opts) => {
                await publishTo("tiktok", { tiktok: opts });
                setTiktokOpen(false);
              }}
            />
          )}

          {batchNote.length > 0 && (
            <div className="state-box">
              {batchNote.map((n, i) => (
                <div key={i}>{n}</div>
              ))}
            </div>
          )}

          <div className="actions">
            <Button variant="secondary" onClick={() => publishAll("live")} busy={busy === "all"} disabled={busy !== null || !anyConnected}>
              Опубликовать во все подключённые
            </Button>
            <Button variant="secondary" onClick={() => publishAll("draft")} disabled={busy !== null || !anyConnected}>
              Во все черновики
            </Button>
          </div>
          {connected && !anyConnected && <p className="hint" style={{ marginTop: 8 }}>Ни один аккаунт не подключён. Подключите платформы в разделе «Настройки».</p>}
        </div>

        <div className="actions" style={{ marginTop: 0 }}>
          <a className="btn btn-secondary" href={`/api/projects/${project.id}/video?which=processed${pubStyle ? `&style=${pubStyle}` : ""}`} download={`gudini-${project.id}${pubStyle ? `-${pubStyle}` : ""}.mp4`}>
            Скачать видео
          </a>
          {project.cover && (
            <a className="btn btn-ghost" href={`/api/projects/${project.id}/video?which=cover`} download={`gudini-${project.id}-cover.jpg`}>
              Скачать обложку
            </a>
          )}
        </div>
      </div>

      <div className="preview-col">
        <VideoPreview
          key={pubStyle ?? "any"}
          src={chosen?.src ?? (project.processedVideo ? `/api/projects/${project.id}/video?which=processed` : null)}
          title={
            <>
              <StatusBadge tone="accent">Для публикации</StatusBadge>
              <span>{pubStyle ? STYLE_NAME[pubStyle] : "Последний монтаж"}</span>
            </>
          }
          caption={chosen ? subtitlesLabel(chosen.info.subtitlesSource) : undefined}
        />
      </div>
    </div>
  );
}
