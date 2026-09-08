import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { del, getJSON, postJSON, upload, RequestError, type ApiError, type Face, type Identity, type Job, type Source, type Stage, type SystemInfo } from "./api";

type Quality = "fast" | "balanced" | "best";

const QUALITY: { key: Quality; title: string; sub: string }[] = [
  { key: "fast", title: "Быстро", sub: "черновик за минуту" },
  { key: "balanced", title: "Обычно", sub: "хорошо для большинства роликов" },
  { key: "best", title: "Лучшее", sub: "максимум деталей, дольше" },
];
const QUALITY_TITLE: Record<string, string> = { fast: "Быстро", balanced: "Обычно", best: "Лучшее" };
const STATUS_RU: Record<string, { text: string; tone: string; busy?: boolean }> = {
  queued: { text: "В очереди", tone: "accent", busy: true },
  processing: { text: "Выполняется", tone: "accent", busy: true },
  completed: { text: "Готово", tone: "success" },
  failed: { text: "Ошибка", tone: "error" },
  cancelled: { text: "Отменено", tone: "warn" },
};

function errorOf(e: unknown): ApiError {
  if (e instanceof RequestError) return e.error;
  return { code: "UNKNOWN", message: e instanceof Error ? e.message : String(e) };
}

function Msg({ error, kind = "err" }: { error: ApiError | null | undefined; kind?: "err" | "warn" | "ok" }) {
  if (!error) return null;
  return (
    <div className={`box ${kind}`}>
      <b>{error.message}</b>
      {error.hint && <span>{error.hint}</span>}
    </div>
  );
}

function fmtDuration(s?: number) {
  if (!s && s !== 0) return "";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m} мин ${r} с` : `${r} с`;
}

function Drop({ accept, onFile, label, sub, disabled }: { accept: string; onFile: (f: File) => void; label: string; sub?: string; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`drop ${over ? "over" : ""}`}
      onClick={() => !disabled && input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !disabled) onFile(f);
      }}
    >
      <div>{label}</div>
      {sub && <div className="sub">{sub}</div>}
      <input ref={input} type="file" accept={accept} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </div>
  );
}

function StageList({ stages }: { stages: Stage[] }) {
  return (
    <div className="stages">
      {stages.map((s) => (
        <div key={s.key} className={`stage ${s.status}`}>
          <span className="dot" />
          <span>{s.label}</span>
          <span className="kv">{s.status === "running" ? `${s.progress}%` : s.status === "done" ? "✓" : s.status === "skipped" ? "пропущено" : s.status === "failed" ? "ошибка" : ""}</span>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [systemErr, setSystemErr] = useState<ApiError | null>(null);

  const [url, setUrl] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [sourceErr, setSourceErr] = useState<ApiError | null>(null);

  const [faces, setFaces] = useState<Face[]>([]);
  const [faceBusy, setFaceBusy] = useState(false);
  const [faceErr, setFaceErr] = useState<ApiError | null>(null);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [identityId, setIdentityId] = useState<string>("");
  const [profileName, setProfileName] = useState("Моё лицо");
  const [selectedFaceIds, setSelectedFaceIds] = useState<string[]>([]);

  const [faceSwap, setFaceSwap] = useState(true);
  const [target, setTarget] = useState<string>("auto");
  const [bgEnabled, setBgEnabled] = useState(false);
  const [bg, setBg] = useState<{ background_id: string; kind: string; preview_url: string; filename: string } | null>(null);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgErr, setBgErr] = useState<ApiError | null>(null);
  const [quality, setQuality] = useState<Quality>("balanced");

  const [job, setJob] = useState<Job | null>(null);
  const [jobErr, setJobErr] = useState<ApiError | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [history, setHistory] = useState<Job[]>([]);

  const loadSystem = useCallback(async () => {
    try {
      setSystem(await getJSON<SystemInfo>("/system"));
      setSystemErr(null);
    } catch (e) {
      setSystemErr(errorOf(e));
    }
  }, []);
  const loadFaces = useCallback(async () => {
    try {
      setFaces((await getJSON<{ faces: Face[] }>("/faces")).faces);
    } catch {
      /* ignore */
    }
  }, []);
  const loadIdentities = useCallback(async () => {
    try {
      setIdentities((await getJSON<{ identities: Identity[] }>("/identities")).identities);
    } catch {
      /* ignore */
    }
  }, []);
  const loadHistory = useCallback(async () => {
    try {
      setHistory((await getJSON<{ jobs: Job[] }>("/jobs")).jobs);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadSystem();
    void loadFaces();
    void loadIdentities();
    void loadHistory();
  }, [loadSystem, loadFaces, loadIdentities, loadHistory]);

  useEffect(() => {
    if (!source || (source.status !== "queued" && source.status !== "processing")) return;
    const t = setInterval(async () => {
      try {
        const s = await getJSON<Source>(`/sources/${source.id}`);
        setSource(s);
      } catch {
        /* keep polling */
      }
    }, 1000);
    return () => clearInterval(t);
  }, [source]);

  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "processing")) return;
    const t = setInterval(async () => {
      try {
        const j = await getJSON<Job>(`/jobs/${job.id}`);
        setJob(j);
        if (showLogs || (j.status !== "queued" && j.status !== "processing")) {
          setLogs((await getJSON<{ lines: string[] }>(`/jobs/${job.id}/logs?n=300`)).lines);
        }
        if (j.status !== "queued" && j.status !== "processing") void loadHistory();
      } catch {
        /* keep polling */
      }
    }, 1000);
    return () => clearInterval(t);
  }, [job, showLogs, loadHistory]);

  useEffect(() => {
    if (!job || !showLogs) return;
    getJSON<{ lines: string[] }>(`/jobs/${job.id}/logs?n=300`).then((l) => setLogs(l.lines)).catch(() => {});
  }, [job?.id, showLogs]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSelectedFaceIds((ids) => ids.filter((id) => faces.some((f) => f.id === id)));
  }, [faces]);
  useEffect(() => {
    if (!identityId) return;
    const ident = identities.find((i) => i.id === identityId);
    if (ident) setSelectedFaceIds(ident.face_ids);
  }, [identityId, identities]);

  async function addUrl() {
    if (!url.trim()) return;
    setSourceBusy(true);
    setSourceErr(null);
    try {
      setSource(await postJSON<Source>("/sources", { url: url.trim() }));
      setTarget("auto");
    } catch (e) {
      setSourceErr(errorOf(e));
    } finally {
      setSourceBusy(false);
    }
  }
  async function addFile(file: File) {
    setSourceBusy(true);
    setSourceErr(null);
    setUploadPct(0);
    try {
      const up = await upload<{ upload_id: string }>("/uploads/video", file, (f) => setUploadPct(Math.round(f * 100)));
      setSource(await postJSON<Source>("/sources", { upload_id: up.upload_id }));
      setTarget("auto");
    } catch (e) {
      setSourceErr(errorOf(e));
    } finally {
      setSourceBusy(false);
      setUploadPct(null);
    }
  }
  async function addFace(file: File) {
    setFaceBusy(true);
    setFaceErr(null);
    try {
      const r = await upload<{ face: Face }>("/faces", file);
      setFaces((prev) => [r.face, ...prev]);
      setSelectedFaceIds((ids) => (ids.length >= 10 ? ids : [...ids, r.face.id]));
      setIdentityId("");
      if (r.face.warnings?.length) setFaceErr({ code: "WARN", message: r.face.warnings.join(" ") });
    } catch (e) {
      setFaceErr(errorOf(e));
    } finally {
      setFaceBusy(false);
    }
  }
  async function removeFace(id: string) {
    if (!confirm("Удалить это фото?")) return;
    try {
      await del(`/faces/${id}`);
      setFaces((prev) => prev.filter((f) => f.id !== id));
    } catch (e) {
      setFaceErr(errorOf(e));
    }
  }
  async function saveProfile() {
    if (!selectedFaceIds.length) return;
    try {
      const r = await postJSON<{ identity: Identity }>("/identities", { name: profileName, face_ids: selectedFaceIds });
      setIdentities((prev) => [r.identity, ...prev]);
      setIdentityId(r.identity.id);
    } catch (e) {
      setFaceErr(errorOf(e));
    }
  }
  async function deleteProfile(id: string) {
    if (!confirm("Удалить профиль? Сами фото останутся.")) return;
    try {
      await del(`/identities/${id}`);
      setIdentities((prev) => prev.filter((i) => i.id !== id));
      if (identityId === id) setIdentityId("");
    } catch (e) {
      setFaceErr(errorOf(e));
    }
  }
  async function addBackground(file: File) {
    setBgBusy(true);
    setBgErr(null);
    try {
      setBg(await upload("/uploads/background", file));
    } catch (e) {
      setBgErr(errorOf(e));
    } finally {
      setBgBusy(false);
    }
  }

  const running = !!job && (job.status === "queued" || job.status === "processing");
  const sourceReady = source?.status === "ready";
  const people = source?.persons ?? [];
  const canGenerate = sourceReady && ((faceSwap && selectedFaceIds.length > 0 && people.length > 0) || (bgEnabled && !!bg)) && !running;
  const selectedFaces = useMemo(() => selectedFaceIds.map((id) => faces.find((f) => f.id === id)).filter(Boolean) as Face[], [selectedFaceIds, faces]);
  const otherFaces = faces.filter((f) => !selectedFaceIds.includes(f.id));

  async function generate() {
    if (!source) return;
    setJobErr(null);
    setLogs([]);
    setShowLogs(false);
    try {
      const r = await postJSON<{ job_id: string; job: Job }>("/jobs", {
        source_id: source.id,
        face_ids: selectedFaceIds,
        identity_id: identityId || null,
        face_swap: faceSwap,
        target_person: target,
        quality,
        background: bgEnabled && bg ? { background_id: bg.background_id } : null,
      });
      setJob(r.job);
      void loadHistory();
    } catch (e) {
      setJobErr(errorOf(e));
    }
  }
  async function cancel() {
    if (!job) return;
    try {
      await postJSON(`/jobs/${job.id}/cancel`, {});
    } catch (e) {
      setJobErr(errorOf(e));
    }
  }
  async function openJob(j: Job) {
    setJob(j);
    setShowLogs(false);
    try {
      setSource(await getJSON<Source>(`/sources/${j.source_id}`));
    } catch {
      /* source may be gone */
    }
  }

  const hw = system?.hardware;
  const whyDisabled = !sourceReady
    ? "Сначала добавьте видео."
    : faceSwap && !selectedFaceIds.length
      ? "Загрузите фото своего лица."
      : faceSwap && !people.length && !(bgEnabled && bg)
        ? "В этом видео нет лица. Можно заменить только фон."
        : bgEnabled && !bg && !faceSwap
          ? "Загрузите фон."
          : "";
  const st = job ? STATUS_RU[job.status] : null;

  return (
    <div className="app">
      <header className="topbar">
        <a href="/" className="back-btn">
          <span className="arrow">←</span> Вернуться в Гудини
        </a>
        <div className="sys">
          {system ? (
            <>
              {hw?.gpu_name || "Без видеокарты"} · {hw?.backend === "cuda" ? "видеокарта NVIDIA" : hw?.backend === "directml" ? "видеокарта" : "процессор"}
            </>
          ) : systemErr ? (
            "Сервер недоступен"
          ) : (
            "Проверяем оборудование…"
          )}
        </div>
      </header>
      <h1 className="page-title">Clipy</h1>
      <p className="page-sub">Своё лицо в чужом ролике. Добавьте видео, загрузите фото лица и нажмите «Создать видео».</p>
      {hw?.notes?.length ? <div className="box warn">{hw.notes.join(" · ")}</div> : null}

      {/* 1. Видео */}
      <section className="card">
        <div className="card-head">
          <span className="step-n">1</span>
          <h2>Видео</h2>
          <span className="spacer" />
          {source?.status === "ready" && <span className="status success">Готово</span>}
          {(source?.status === "queued" || source?.status === "processing") && <span className="status accent busy">Разбираем</span>}
        </div>
        <div className="row">
          <div style={{ flex: 1, minWidth: 220 }}>
            <input type="url" placeholder="Ссылка на TikTok, Reels или Shorts" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addUrl()} disabled={sourceBusy || running} />
          </div>
          <button className="btn" onClick={addUrl} disabled={sourceBusy || running || !url.trim()}>
            {sourceBusy && uploadPct === null ? <span className="spin" /> : null} Добавить
          </button>
        </div>
        <div className="or">или</div>
        <Drop accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" onFile={addFile} label={uploadPct !== null ? `Загружаем ${uploadPct}%` : "Загрузить видео с компьютера"} sub="MP4, MOV или WebM" disabled={sourceBusy || running} />
        {uploadPct !== null && <div className="progress"><div style={{ width: `${uploadPct}%` }} /></div>}
        <Msg error={sourceErr} />
        {source && (source.status === "queued" || source.status === "processing") && (
          <div className="box">
            <div className="row"><span className="spin" /> {source.job?.status === "queued" ? "Ждём очередь" : source.job?.stage_label || "Готовим видео"}</div>
            <div className="progress"><div style={{ width: `${source.job?.progress ?? 0}%` }} /></div>
          </div>
        )}
        {source?.status === "failed" && <Msg error={source.error} />}
        {source?.status === "ready" && source.info && (
          <div style={{ marginTop: 14 }}>
            <video className="video" src={source.video_url ?? undefined} poster={source.poster_url ?? undefined} controls playsInline preload="metadata" />
            <p className="kv" style={{ marginTop: 6 }}>
              {source.info.width}×{source.info.height} · {fmtDuration(source.info.duration)} · {source.info.has_audio ? "со звуком" : "без звука"}
            </p>
            {faceSwap && (
              <div style={{ marginTop: 12 }}>
                <p className="hint">Кого заменить:</p>
                {people.length === 0 ? (
                  <div className="box warn"><b>В этом видео не найдено лицо.</b>Заменить лицо не получится, но можно заменить фон.</div>
                ) : (
                  <div className="people">
                    <div className={`person ${target === "auto" ? "selected" : ""}`} onClick={() => !running && setTarget("auto")}>
                      <img src={people[0].thumbnail_url} alt="" />
                      Главный человек
                      <small>выбирается сам</small>
                    </div>
                    {people.map((p, i) => (
                      <div key={p.id} className={`person ${target === p.id ? "selected" : ""}`} onClick={() => !running && setTarget(p.id)}>
                        <img src={p.thumbnail_url} alt="" />
                        Человек {i + 1}
                        <small>в {Math.round(p.coverage * 100)}% кадров</small>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 2. Лицо */}
      <section className="card">
        <div className="card-head">
          <span className="step-n">2</span>
          <h2>Ваше лицо</h2>
          <span className="spacer" />
          {selectedFaces.length > 0 && <span className="status success">Фото: {selectedFaces.length}</span>}
        </div>
        {identities.length > 0 && (
          <div className="row" style={{ marginBottom: 12 }}>
            <select value={identityId} onChange={(e) => setIdentityId(e.target.value)} disabled={running}>
              <option value="">Сохранённые профили</option>
              {identities.map((i) => (
                <option key={i.id} value={i.id}>{i.name} · {i.face_ids.length} фото</option>
              ))}
            </select>
            {identityId && <button className="btn btn-ghost btn-sm" onClick={() => deleteProfile(identityId)} disabled={running}>Удалить профиль</button>}
          </div>
        )}
        <Drop accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" onFile={addFace} label={faceBusy ? "Проверяем фото…" : "Загрузить фото лица"} sub="одно лицо на фото, при хорошем свете · можно несколько фото" disabled={faceBusy || running} />
        <Msg error={faceErr} kind={faceErr?.code === "WARN" ? "warn" : "err"} />
        {selectedFaces.length > 0 && (
          <>
            <div className="faces">
              {selectedFaces.map((f) => (
                <div className="face" key={f.id}>
                  <img src={f.thumb_url} alt="" />
                  <button className="x" title="Не использовать в этот раз" onClick={() => setSelectedFaceIds((ids) => ids.filter((x) => x !== f.id))} disabled={running}>×</button>
                </div>
              ))}
            </div>
            {!identityId && (
              <div className="row" style={{ marginTop: 12 }}>
                <input type="text" value={profileName} onChange={(e) => setProfileName(e.target.value)} style={{ maxWidth: 220 }} disabled={running} aria-label="Название профиля" />
                <button className="btn btn-secondary btn-sm" onClick={saveProfile} disabled={running}>Сохранить как профиль</button>
              </div>
            )}
          </>
        )}
        {otherFaces.length > 0 && (
          <>
            <p className="hint" style={{ marginTop: 12 }}>Ранее загруженные фото, нажмите, чтобы добавить:</p>
            <div className="faces">
              {otherFaces.map((f) => (
                <div className="face dim" key={f.id} onClick={() => setSelectedFaceIds((ids) => (ids.length >= 10 ? ids : [...ids, f.id]))} style={{ cursor: "pointer" }}>
                  <img src={f.thumb_url} alt="" />
                  <button className="x" title="Удалить фото" onClick={(e) => { e.stopPropagation(); void removeFace(f.id); }} disabled={running}>×</button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* 3. Настройки */}
      <section className="card">
        <div className="card-head">
          <span className="step-n">3</span>
          <h2>Настройки</h2>
        </div>
        <label className="check">
          <input type="checkbox" checked={faceSwap} onChange={(e) => setFaceSwap(e.target.checked)} disabled={running} /> Заменить лицо
        </label>
        <label className="check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={bgEnabled} onChange={(e) => setBgEnabled(e.target.checked)} disabled={running} /> Заменить фон
        </label>
        {bgEnabled && (
          <div style={{ marginTop: 10 }}>
            <Drop accept="image/jpeg,image/png,video/mp4,.jpg,.jpeg,.png,.mp4" onFile={addBackground} label={bgBusy ? "Загружаем…" : bg ? `Фон: ${bg.filename}` : "Загрузить фон"} sub="картинка JPEG или PNG, либо видео MP4" disabled={bgBusy || running} />
            <Msg error={bgErr} />
            {bg && (bg.kind === "image" ? <img className="preview-img" src={bg.preview_url} alt="" /> : <video className="video" src={bg.preview_url} muted controls style={{ marginTop: 10, maxHeight: 200 }} />)}
          </div>
        )}
        <p className="hint" style={{ margin: "18px 0 8px" }}>Качество</p>
        <div className="seg">
          {QUALITY.map((q) => (
            <button key={q.key} className={quality === q.key ? "active" : ""} onClick={() => setQuality(q.key)} disabled={running}>
              <b>{q.title}</b>
              <span>{q.sub}</span>
            </button>
          ))}
        </div>
        {hw?.backend === "cpu" && <p className="hint" style={{ marginTop: 8 }}>Без видеокарты обработка идёт на процессоре и занимает много минут.</p>}
      </section>

      {/* 4. Запуск */}
      <section className="card">
        {!running ? (
          <button className="btn btn-big" onClick={generate} disabled={!canGenerate}>Создать видео</button>
        ) : (
          <button className="btn btn-danger btn-big" onClick={cancel}>Отменить</button>
        )}
        {!running && !canGenerate && whyDisabled && <p className="hint" style={{ marginTop: 8 }}>{whyDisabled}</p>}
        <Msg error={jobErr} />
        {job && st && (
          <div style={{ marginTop: 16 }}>
            <div className="row">
              <span className={`status ${st.tone} ${st.busy ? "busy" : ""}`}>{st.text}</span>
              {job.status === "queued" && job.queue_position > 0 && <span className="kv">место в очереди: {job.queue_position}</span>}
              {running && <span className="kv">{job.stage_label}</span>}
              <span className="spacer" />
              {running && <span className="kv">{job.progress}%</span>}
            </div>
            {running && <div className="progress"><div style={{ width: `${job.progress}%` }} /></div>}
            {(running || job.status === "failed") && <StageList stages={job.stages} />}
            {job.status === "failed" && <Msg error={job.error} />}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="link-btn" onClick={() => setShowLogs((v) => !v)}>{showLogs ? "Скрыть журнал" : "Показать журнал"}</button>
            </div>
            {showLogs && <div className="logs">{logs.join("\n") || "…"}</div>}
          </div>
        )}
      </section>

      {job?.status === "completed" && job.result && (
        <section className="card">
          <div className="card-head">
            <h2>Результат</h2>
            <span className="spacer" />
            <span className="kv">{job.result.width}×{job.result.height} · {fmtDuration(job.result.duration)} · {job.result.has_audio ? "со звуком" : "без звука"}</span>
          </div>
          <div className="compare">
            <div>
              <h3>Было</h3>
              <video className="video" src={source?.video_url ?? undefined} controls playsInline preload="metadata" />
            </div>
            <div>
              <h3>Стало</h3>
              <video className="video" src={job.result.video_url} poster={job.result.poster_url} controls playsInline preload="metadata" />
            </div>
          </div>
          <div className="actions">
            <a className="btn" href={job.result.video_url} download={`clipy-${job.id}.mp4`}>Скачать видео</a>
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Прошлые задачи</h2>
          </div>
          <div className="history">
            {history.slice(0, 10).map((h) => {
              const hs = STATUS_RU[h.status] ?? { text: h.status, tone: "" };
              return (
                <div key={h.id} className={`hist ${job?.id === h.id ? "active" : ""}`} onClick={() => openJob(h)}>
                  {h.result?.poster_url ? <img src={h.result.poster_url} alt="" /> : <div className="noimg" />}
                  <div>
                    <div>{h.source?.url ? h.source.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48) : "Загруженное видео"}</div>
                    <div className="kv">{new Date(h.created_at).toLocaleString("ru-RU")} · {QUALITY_TITLE[h.quality] ?? h.quality}{h.background ? " · с фоном" : ""}</div>
                  </div>
                  <span className={`status ${hs.tone}`}>{hs.text}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
