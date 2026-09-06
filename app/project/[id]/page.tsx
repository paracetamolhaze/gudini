"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";

type Meta = { title: string; description: string; hashtags: string[] };
type Publication = { platform: string; status: string; url?: string; message?: string; at: string };
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
  brollCount?: number;
  meta: Meta | null;
  publications: Publication[];
};

const PLATFORMS = [
  { key: "tiktok", name: "TikTok", icon: "🎵" },
  { key: "youtube", name: "YouTube Shorts", icon: "▶️" },
  { key: "instagram", name: "Instagram Reels", icon: "📸" },
] as const;

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const res = await fetch(`/api/projects/${id}`);
    if (res.ok) {
      const p: Project = await res.json();
      setProject(p);
      return p;
    }
    return null;
  }, [id]);

  useEffect(() => {
    reload().then((p) => {
      if (!p) return;
      if (p.processedVideo) setStep(3);
      else if (p.processing.state === "running") setStep(2);
      else if (p.rawVideo) setStep(2);
      else if (p.script) setStep(0);
    });
  }, [reload]);

  if (!project) return <p className="hint">Загрузка…</p>;

  const stepsDone = [
    Boolean(project.script),
    Boolean(project.rawVideo),
    Boolean(project.processedVideo),
    project.publications.length > 0,
  ];

  return (
    <main>
      <h1 className="project-title">{project.topic}</h1>
      <p className="hint" style={{ marginBottom: 18 }}>
        Проект #{project.id.slice(0, 6)}
      </p>

      <div className="steps">
        {["1. Сценарий", "2. Съёмка", "3. Монтаж", "4. Публикация"].map((label, i) => (
          <button
            key={label}
            className={`step ${step === i ? "active" : ""} ${step !== i && stepsDone[i] ? "done" : ""}`}
            onClick={() => setStep(i)}
          >
            {label} {step !== i && stepsDone[i] ? "✓" : ""}
          </button>
        ))}
      </div>

      {error && <div className="error-box">{error}</div>}

      {step === 0 && <ScriptStep project={project} setProject={setProject} setError={setError} onNext={() => setStep(1)} />}
      {step === 1 && <RecordStep project={project} reload={reload} setError={setError} onNext={() => setStep(2)} />}
      {step === 2 && <ProcessStep project={project} reload={reload} setError={setError} onNext={() => setStep(3)} />}
      {step === 3 && <PublishStep project={project} setProject={setProject} reload={reload} setError={setError} />}
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
  const [busy, setBusy] = useState(false);
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  const seconds = Math.round(words / 2.5);

  async function regenerate() {
    setBusy(true);
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
      setBusy(false);
    }
  }

  async function saveAndNext() {
    setBusy(true);
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
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>📝 Сценарий на минуту</h2>
      {project.scriptDemo && (
        <p className="hint" style={{ marginBottom: 10 }}>
          ⚡ Демо-режим: сценарий сгенерирован по шаблону. Добавь ключ Anthropic в Настройках — и ИИ будет писать
          уникальные сценарии под каждую тему.
        </p>
      )}
      <textarea rows={14} value={script} onChange={(e) => setScript(e.target.value)} />
      <p className="hint" style={{ margin: "8px 0 14px" }}>
        {words} слов ≈ {seconds} сек чтения {seconds > 75 ? "— длинновато, сократи" : seconds < 40 && words > 0 ? "— коротковато" : "✓"}
      </p>
      <div className="row">
        <button className="btn btn-secondary" onClick={regenerate} disabled={busy}>
          {busy ? <span className="spin" /> : "🔄"} Перегенерировать
        </button>
        <div className="spacer" />
        <button className="btn" onClick={saveAndNext} disabled={busy || !script.trim()}>
          Сохранить и к съёмке →
        </button>
      </div>
    </div>
  );
}

/* ================== Шаг 2: Съёмка / загрузка ================== */

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
  const [drag, setDrag] = useState(false);
  const [prompterOpen, setPrompterOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setError("");
    setUploading(true);
    setUploadPct(0);
    // грузим кусками по 4 МБ: большие тела запросов режутся прокси хостинга
    const CHUNK = 4 * 1024 * 1024;
    const name = file.name || "record.webm";
    let offset = 0;
    try {
      while (offset < file.size) {
        const chunk = file.slice(offset, Math.min(offset + CHUNK, file.size));
        let attempt = 0;
        for (;;) {
          const res = await fetch(`/api/projects/${project.id}/upload`, {
            method: "PUT",
            headers: {
              // кириллица в имени файла роняла fetch: заголовки только latin-1
              "x-filename": encodeURIComponent(name),
              "x-file-size": String(file.size),
              "x-offset": String(offset),
            },
            body: chunk,
          });
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
          if (++attempt >= 3) throw new Error(json.error ?? `HTTP ${res.status}`);
          await new Promise((r) => setTimeout(r, 1500));
        }
        setUploadPct(Math.round((offset / file.size) * 100));
      }
      setUploading(false);
      await reload();
      onNext();
    } catch (e: any) {
      setUploading(false);
      setError(`Ошибка загрузки: ${String(e?.message ?? e)}`);
    }
  }

  return (
    <>
      <div className="card">
        <h2>🎥 Запиши себя, читая сценарий</h2>
        <p className="hint" style={{ marginBottom: 16 }}>
          Снимай вертикально (9:16), в хорошем свете, с хорошим звуком. Можно записать прямо здесь с телесуфлёром —
          текст будет плыть по экрану, пока камера пишет.
        </p>
        <div className="row">
          <button className="btn" onClick={() => setPrompterOpen(true)}>
            🎙 Записать с телесуфлёром
          </button>
          <span className="hint or">или</span>
          <button className="btn btn-secondary" onClick={() => fileInput.current?.click()}>
            📁 Загрузить готовый файл
          </button>
        </div>

        <div
          className={`dropzone ${drag ? "drag" : ""}`}
          style={{ marginTop: 16 }}
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
          Перетащи видеофайл сюда (MP4, MOV, WebM…)
          {project.rawVideo && <div style={{ marginTop: 8, color: "var(--success)" }}>✓ Видео уже загружено — можно заменить</div>}
        </div>
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

        {uploading && (
          <>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${uploadPct}%` }} />
            </div>
            <p className="hint">Загрузка: {uploadPct}%</p>
          </>
        )}

        {project.rawVideo && !uploading && (
          <div className="row" style={{ marginTop: 16 }}>
            <video className="video-preview" src={`/api/projects/${project.id}/video?which=raw`} controls playsInline style={{ margin: 0, maxWidth: 220 }} />
            <div className="spacer" />
            <button className="btn" onClick={onNext}>
              К монтажу →
            </button>
          </div>
        )}
      </div>

      {prompterOpen && (
        <Teleprompter
          script={project.script ?? ""}
          onClose={() => setPrompterOpen(false)}
          onRecorded={(blob) => {
            setPrompterOpen(false);
            upload(new File([blob], "record.webm", { type: blob.type }));
          }}
        />
      )}
    </>
  );
}

/* ================== Телесуфлёр с записью ================== */

function Teleprompter({
  script,
  onClose,
  onRecorded,
}: {
  script: string;
  onClose: () => void;
  onRecorded: (blob: Blob) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const scrollRef = useRef({ offset: 0, raf: 0, last: 0 });
  const [recording, setRecording] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [speed, setSpeed] = useState(55); // px/сек
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const [camError, setCamError] = useState("");

  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({
        video: { width: { ideal: 1080 }, height: { ideal: 1920 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      .then((stream) => {
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch((e) => setCamError(`Камера недоступна: ${e.message}. Можно загрузить файл, снятый на телефон.`));
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(scrollRef.current.raf);
    };
  }, []);

  useEffect(() => {
    if (!scrolling) {
      cancelAnimationFrame(scrollRef.current.raf);
      return;
    }
    scrollRef.current.last = performance.now();
    const tick = (now: number) => {
      const dt = (now - scrollRef.current.last) / 1000;
      scrollRef.current.last = now;
      scrollRef.current.offset += speedRef.current * dt;
      if (textRef.current) textRef.current.style.transform = `translateY(-${scrollRef.current.offset}px)`;
      scrollRef.current.raf = requestAnimationFrame(tick);
    };
    scrollRef.current.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(scrollRef.current.raf);
  }, [scrolling]);

  function start() {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
    recorder.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" });
      onRecorded(blob);
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    setRecording(true);
    setScrolling(true);
  }

  function stop() {
    setScrolling(false);
    setRecording(false);
    recorderRef.current?.stop();
  }

  return (
    <div className="teleprompter-overlay">
      <div className="row" style={{ maxWidth: 700, margin: "0 auto", width: "100%" }}>
        {recording ? (
          <span>
            <span className="rec-dot" />
            ЗАПИСЬ
          </span>
        ) : (
          <span className="hint">Готов к записи</span>
        )}
        <div className="spacer" />
        <label style={{ margin: 0 }}>Скорость</label>
        <input
          type="range"
          min={20}
          max={120}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          style={{ width: 120 }}
        />
        <button className="btn btn-secondary btn-sm" onClick={() => setScrolling((s) => !s)}>
          {scrolling ? "⏸ Пауза текста" : "▶ Текст"}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => {
            scrollRef.current.offset = 0;
            if (textRef.current) textRef.current.style.transform = "translateY(0)";
          }}
        >
          ⏮ Сначала
        </button>
      </div>

      {camError && <div className="error-box">{camError}</div>}

      <div className="teleprompter-text">
        <div className="teleprompter-inner" ref={textRef}>
          {script || "Сценарий пуст — вернись на шаг 1"}
        </div>
      </div>

      <video ref={videoRef} className="camera-pip" autoPlay muted playsInline />

      <div className="row" style={{ justifyContent: "center", paddingBottom: 8 }}>
        {!recording ? (
          <>
            <button className="btn" onClick={start} disabled={!streamRef.current && !camError}>
              ⏺ Начать запись
            </button>
            <button className="btn btn-secondary" onClick={onClose}>
              Закрыть
            </button>
          </>
        ) : (
          <button className="btn" onClick={stop}>
            ⏹ Стоп и использовать запись
          </button>
        )}
      </div>
    </div>
  );
}

/* ================== Шаг 3: Монтаж ================== */

function ProcessStep({
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
  const processing = project.processing;

  useEffect(() => {
    if (processing.state !== "running") return;
    const timer = setInterval(reload, 1500);
    return () => clearInterval(timer);
  }, [processing.state, reload]);

  async function start() {
    setError("");
    const res = await fetch(`/api/projects/${project.id}/process`, { method: "POST" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "Ошибка запуска монтажа");
      return;
    }
    await reload();
  }

  return (
    <div className="card">
      <h2>✂️ Автомонтаж</h2>
      <p className="hint" style={{ marginBottom: 14 }}>
        Гудини кадрирует видео в 9:16 (1080×1920), нормализует громкость, добавит крупные «горящие» субтитры по
        словам и сгенерирует описание с хэштегами.
      </p>

      {!project.rawVideo && <div className="error-box">Сначала загрузи видео на шаге «Съёмка»</div>}

      {processing.state === "running" ? (
        <>
          <div className="row">
            <span className="spin" />
            <b>{processing.step}</b>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${processing.progress}%` }} />
          </div>
          <p className="hint">{processing.progress}%</p>
        </>
      ) : (
        <div className="row">
          <button className="btn" onClick={start} disabled={!project.rawVideo}>
            🪄 Смонтировать видео
          </button>
          {project.processedVideo && (
            <>
              <span className="badge success">Готово ✓</span>
              <button className="btn btn-secondary" onClick={onNext}>
                К публикации →
              </button>
            </>
          )}
        </div>
      )}

      {processing.state === "error" && <div className="error-box">Ошибка монтажа: {processing.error}</div>}

      {project.processedVideo && processing.state !== "running" && (
        <div style={{ marginTop: 18 }}>
          <video className="video-preview" src={`/api/projects/${project.id}/video?which=processed&t=${Date.now()}`} controls playsInline />
          <p className="hint" style={{ textAlign: "center", marginTop: 8 }}>
            Субтитры:{" "}
            {project.subtitlesSource === "scribe"
              ? "по речи (ElevenLabs Scribe)"
              : project.subtitlesSource === "whisper"
                ? "по речи (Whisper)"
                : "по тексту сценария"}
            {project.brollCount ? ` · перебивок: ${project.brollCount}` : ""}
          </p>
          <CoverBlock project={project} reload={reload} />
        </div>
      )}
    </div>
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
      if (!res.ok) throw new Error(data?.error ?? "Не удалось перегенерировать");
      await reload();
      setEditing(false);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (busy) {
    return (
      <div style={{ textAlign: "center", marginTop: 12 }}>
        <p className="hint">Генерирую обложку и проверяю качество…</p>
      </div>
    );
  }

  if (project.cover) {
    return (
      <div style={{ textAlign: "center", marginTop: 10 }}>
        <img
          src={`/api/projects/${project.id}/video?which=cover&t=${Date.now()}`}
          alt="Обложка"
          style={{ maxWidth: 160, borderRadius: 10, border: "1px solid var(--border)" }}
        />
        <p className="hint">Обложка (ИИ, прошла контроль качества)</p>
        <button className="btn btn-secondary" onClick={() => regenerate()} style={{ marginTop: 6 }}>
          Перегенерировать обложку
        </button>
        {error && <p className="hint" style={{ color: "var(--danger, #e5484d)" }}>{error}</p>}
      </div>
    );
  }

  if (project.coverStatus !== "failed" && project.coverStatus !== "headline_failed") return null;

  const headlineFailed = project.coverStatus === "headline_failed";
  return (
    <div style={{ textAlign: "center", marginTop: 12 }}>
      <p className="hint" style={{ color: "var(--danger, #e5484d)" }}>
        {headlineFailed
          ? "Не удалось подобрать заголовок, сохраняющий тему ролика. Картинка не генерировалась — деньги не потрачены."
          : "Не удалось сгенерировать качественную обложку."}
      </p>
      {editing ? (
        <div style={{ maxWidth: 320, margin: "8px auto 0" }}>
          <input
            className="input"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            placeholder="Короткий заголовок, 2–4 слова"
            maxLength={40}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 6, justifyContent: "center" }}>
            <button className="btn" disabled={!headline.trim()} onClick={() => regenerate(headline)}>
              Сгенерировать
            </button>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 6, justifyContent: "center" }}>
          <button className="btn" onClick={() => regenerate()}>
            {headlineFailed ? "Сгенерировать заголовок заново" : "Перегенерировать"}
          </button>
          <button className="btn btn-secondary" onClick={() => setEditing(true)}>
            Изменить заголовок
          </button>
        </div>
      )}
      {error && <p className="hint" style={{ color: "var(--danger, #e5484d)" }}>{error}</p>}
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
}: {
  project: Project;
  screen: TikTokScreen;
  busy: boolean;
  onPublish: (opts: Record<string, unknown>) => Promise<void>;
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
        <h2>🎵 Публикация в TikTok</h2>
        <div className="error-box">{screen.error ?? "Аккаунт TikTok не подключён — подключите его в Настройках."}</div>
      </div>
    );
  }

  return (
    <div className="card tiktok-panel">
      <h2>🎵 Публикация в TikTok</h2>
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
          <video className="video-preview" src={`/api/projects/${project.id}/video?which=processed`} controls playsInline />
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
          <p className="hint">TikTok берёт обложку только из кадра видео, свою картинку через API он не принимает.</p>

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

function PublishStep({
  project,
  setProject,
  reload,
  setError,
}: {
  project: Project;
  setProject: (p: Project) => void;
  reload: () => Promise<Project | null>;
  setError: (e: string) => void;
}) {
  const meta = project.meta ?? { title: "", description: "", hashtags: [] };
  const [title, setTitle] = useState(meta.title);
  const [description, setDescription] = useState(meta.description);
  const [hashtags, setHashtags] = useState(meta.hashtags.join(" "));
  const [busy, setBusy] = useState<string | null>(null);
  const [captionCopied, setCaptionCopied] = useState(false);
  const [connected, setConnected] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setConnected(s.connected ?? {}))
      .catch(() => {});
  }, []);

  async function saveMeta() {
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
      setError(p.error ?? "Не удалось сохранить описание");
      return false;
    }
    setProject(p);
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
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const [tiktokScreen, setTiktokScreen] = useState<TikTokScreen | null>(null);
  const [tiktokOpen, setTiktokOpen] = useState(false);
  const [batchNote, setBatchNote] = useState("");
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
        body: JSON.stringify({ platform, ...extra }),
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
    setBatchNote("");
    const notes: string[] = [];
    try {
      if (!(await saveMeta())) return;
      for (const { key, name } of PLATFORMS) {
        if (!connected[key]) {
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
          body: JSON.stringify({ platform: key, mode }),
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
      setBatchNote(notes.join(" · "));
      setBusy(null);
    }
  }

  if (!project.processedVideo) {
    return (
      <div className="card">
        <h2>🚀 Публикация</h2>
        <div className="error-box">Сначала смонтируй видео на шаге 3</div>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>📋 Описание для публикации</h2>
        <label>Заголовок</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveMeta} />
        <label>Описание</label>
        <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} onBlur={saveMeta} />
        <label>Хэштеги (через пробел)</label>
        <input type="text" value={hashtags} onChange={(e) => setHashtags(e.target.value)} onBlur={saveMeta} />
        <div className="hashtags">
          {hashtags
            .split(/\s+/)
            .filter(Boolean)
            .map((h, i) => (
              <span className="hashtag" key={i}>
                {h.startsWith("#") ? h : `#${h}`}
              </span>
            ))}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn btn-secondary btn-sm" onClick={regenMeta} disabled={busy === "meta"}>
            {busy === "meta" ? <span className="spin" /> : "🔄"} Перегенерировать описание
          </button>
        </div>
      </div>

      <div className="card">
        <h2>🚀 Куда публикуем</h2>
        <div className="row" style={{ marginBottom: 14 }}>
          <button className="btn" onClick={() => publishAll("live")} disabled={busy !== null}>
            {busy === "all" ? <span className="spin" /> : "🚀"} Опубликовать во все
          </button>
          <button className="btn btn-secondary" onClick={() => publishAll("draft")} disabled={busy !== null}>
            {busy === "all" ? <span className="spin" /> : "📝"} Отправить в черновики
          </button>
        </div>
        <p className="hint" style={{ marginBottom: 12 }}>
          «Во все»: YouTube в общий доступ, Instagram сразу, TikTok через форму ниже. «Черновики»: YouTube приватным
          черновиком в Studio, TikTok в «Уведомления → Загрузки», Instagram пропускается — черновиков у него нет.
        </p>
        {batchNote && <div className="success-box">{batchNote}</div>}
        <div className="platform-grid">
          {PLATFORMS.map(({ key, name, icon }) => {
            const pub = project.publications.find((p) => p.platform === key);
            return (
              <div className="platform-card" key={key}>
                <h3>
                  {icon} {name}
                </h3>
                <div className="platform-status">
                  {pub?.status === "published" && (
                    <span style={{ color: "var(--success)" }}>
                      ✓ Опубликовано{" "}
                      {pub.url && (
                        <a href={pub.url} target="_blank" style={{ textDecoration: "underline" }}>
                          открыть
                        </a>
                      )}
                      {pub.message && <div>{pub.message}</div>}
                    </span>
                  )}
                  {pub?.status === "demo" && <span style={{ color: "var(--warn)" }}>{pub.message}</span>}
                  {pub?.status === "skipped" && <span>{pub.message}</span>}
                  {pub?.status === "error" && <span style={{ color: "var(--error)" }}>{pub.message}</span>}
                  {!pub && (connected[key] ? "Аккаунт подключён" : "Аккаунт не подключён — сработает демо-режим")}
                </div>
                {key === "tiktok" && tiktokScreen?.direct ? (
                  <button className="btn btn-sm" onClick={() => setTiktokOpen((o) => !o)} disabled={busy !== null}>
                    {tiktokOpen ? "Скрыть экран публикации" : pub ? "Опубликовать снова" : "Настроить и опубликовать"}
                  </button>
                ) : (
                  <button className="btn btn-sm" onClick={() => publishTo(key)} disabled={busy !== null}>
                    {busy === key ? <span className="spin" /> : pub ? "Опубликовать снова" : "Опубликовать"}
                  </button>
                )}
                {key === "tiktok" && project.meta && !tiktokScreen?.direct && (
                  <button
                    className="btn btn-secondary btn-sm"
                    style={{ marginTop: 8 }}
                    onClick={copyCaption}
                    title="TikTok не принимает подпись через API при заливке в черновики — вставьте её в приложении"
                  >
                    {captionCopied ? "Скопировано ✓" : "📋 Скопировать подпись"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {tiktokOpen && tiktokScreen && (
          <TikTokPanel
            project={project}
            screen={tiktokScreen}
            busy={busy === "tiktok"}
            onPublish={async (opts) => {
              await publishTo("tiktok", { tiktok: opts });
              setTiktokOpen(false);
            }}
          />
        )}
        <div className="row" style={{ marginTop: 18 }}>
          <a className="btn btn-secondary" href={`/api/projects/${project.id}/video?which=processed`} download={`gudini-${project.id}.mp4`}>
            ⬇ Скачать готовое видео
          </a>
          {project.cover && (
            <a className="btn btn-secondary" href={`/api/projects/${project.id}/video?which=cover`} download={`gudini-${project.id}-cover.jpg`}>
              ⬇ Обложка
            </a>
          )}
          <span className="hint">Готовый MP4 можно опубликовать вручную из приложения платформы</span>
        </div>
      </div>
    </>
  );
}
