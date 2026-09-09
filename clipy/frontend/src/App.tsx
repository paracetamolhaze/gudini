import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { del, getJSON, patchJSON, postJSON, upload, RequestError, type ApiError, type Face, type Identity, type Job, type Source, type Stage, type SystemInfo } from "./api";

const STATUS_RU: Record<string, { text: string; tone: string; busy?: boolean }> = {
  queued: { text: "В очереди", tone: "accent", busy: true },
  processing: { text: "Выполняется", tone: "accent", busy: true },
  completed: { text: "Готово", tone: "success" },
  failed: { text: "Ошибка", tone: "error" },
  cancelled: { text: "Отменено", tone: "warn" },
};
const NONE = "";

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

function photoWord(n: number) {
  const t = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && t === 1) return "фото";
  return "фото";
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

/** Плитка «плюс» внутри карточки человека: добавить ему ещё одно фото. */
function PhotoAdd({ onFile, disabled, busy }: { onFile: (f: File) => void; disabled?: boolean; busy?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <button type="button" className="photo-add" onClick={() => !disabled && input.current?.click()} disabled={disabled} title="Добавить фото этому человеку">
      {busy ? <span className="spin" /> : "+"}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </button>
  );
}

type Ask = { title: string; text?: string; ok?: string; run: () => Promise<void> | void };

/** Своё окно подтверждения: системное confirm() выглядит как окно браузера и пугает адресом сайта. */
function Confirm({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ask) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [ask, onClose]);
  if (!ask) return null;
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{ask.title}</h3>
        {ask.text && <p className="hint">{ask.text}</p>}
        <div className="actions">
          <button
            className="btn btn-danger-solid"
            autoFocus
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await ask.run();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <span className="spin" /> : null} {ask.ok ?? "Удалить"}
          </button>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Отмена</button>
        </div>
      </div>
    </div>
  );
}

function StageList({ stages }: { stages: Stage[] }) {
  return (
    <div className="stages">
      {stages.map((s) => (
        <div key={s.key} className={`stage ${s.status}`}>
          <span className="dot" />
          <span>{s.label}{s.status === "running" && s.note ? ` · ${s.note}` : ""}</span>
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

  // люди для замены: у каждого своё имя и свои фото
  const [faces, setFaces] = useState<Face[]>([]);
  const [people, setPeople] = useState<Identity[]>([]);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [busyPerson, setBusyPerson] = useState<string | null>(null);
  const [faceErr, setFaceErr] = useState<ApiError | null>(null);
  const migrated = useRef(false);

  // человек в видео -> кем заменить (id человека из шага 2)
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [quality, setQuality] = useState<string>("fast");
  const [bgEnabled, setBgEnabled] = useState(false);
  const [bg, setBg] = useState<{ background_id: string; kind: string; preview_url: string; filename: string } | null>(null);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgErr, setBgErr] = useState<ApiError | null>(null);

  const [job, setJob] = useState<Job | null>(null);
  const [jobErr, setJobErr] = useState<ApiError | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [history, setHistory] = useState<Job[]>([]);
  const [ask, setAsk] = useState<Ask | null>(null);

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
      const r = await getJSON<{ faces: Face[] }>("/faces");
      setFaces(r.faces);
      return r.faces;
    } catch {
      return [] as Face[];
    }
  }, []);
  const loadPeople = useCallback(async () => {
    try {
      const r = await getJSON<{ identities: Identity[] }>("/identities");
      setPeople(r.identities);
      return r.identities;
    } catch {
      return [] as Identity[];
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
    void loadHistory();
    // фото из старой версии не принадлежат никому: заводим по человеку на каждое, дальше их можно переименовать
    (async () => {
      const [fs, ids] = await Promise.all([loadFaces(), loadPeople()]);
      if (migrated.current) return;
      migrated.current = true;
      const used = new Set(ids.flatMap((i) => i.face_ids));
      const orphans = fs.filter((f) => !used.has(f.id));
      if (!orphans.length) return;
      for (let i = 0; i < orphans.length; i++) {
        try {
          await postJSON<{ identity: Identity }>("/identities", { name: `Лицо ${ids.length + i + 1}`, face_ids: [orphans[i].id] });
        } catch {
          /* ignore */
        }
      }
      await loadPeople();
    })();
  }, [loadSystem, loadFaces, loadPeople, loadHistory]);

  // сколько видеопамяти свободно, меняется постоянно: открыли OBS или игру — оценка времени должна это знать
  useEffect(() => {
    if (job && (job.status === "queued" || job.status === "processing")) return;
    const t = setInterval(() => void loadSystem(), 15000);
    return () => clearInterval(t);
  }, [job, loadSystem]);

  useEffect(() => {
    if (!source || (source.status !== "queued" && source.status !== "processing")) return;
    const t = setInterval(async () => {
      try {
        setSource(await getJSON<Source>(`/sources/${source.id}`));
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

  const running = !!job && (job.status === "queued" || job.status === "processing");
  const sourceReady = source?.status === "ready";
  const persons = useMemo(() => source?.persons ?? [], [source]);
  const faceById = useMemo(() => new Map(faces.map((f) => [f.id, f])), [faces]);

  // первый человек из списка сам встаёт на главного человека в кадре
  useEffect(() => {
    if (!persons.length || !people.length || running) return;
    setChoice((cur) => (Object.values(cur).some(Boolean) ? cur : { ...cur, [persons[0].id]: people[0].id }));
  }, [persons, people, running]);

  // ---------------- люди
  async function addPhoto(identityId: string | "draft", file: File) {
    setBusyPerson(identityId);
    setFaceErr(null);
    try {
      const r = await upload<{ face: Face }>("/faces", file);
      setFaces((prev) => [...prev, r.face]);
      if (identityId === "draft") {
        const created = await postJSON<{ identity: Identity }>("/identities", { name: draftName?.trim() || `Человек ${people.length + 1}`, face_ids: [r.face.id] });
        setPeople((prev) => [...prev, created.identity]);
        setDraftName(null);
      } else {
        const person = people.find((p) => p.id === identityId);
        const next = [...(person?.face_ids ?? []), r.face.id];
        const upd = await patchJSON<{ identity: Identity }>(`/identities/${identityId}`, { face_ids: next });
        setPeople((prev) => prev.map((p) => (p.id === identityId ? upd.identity : p)));
      }
      if (r.face.warnings?.length) setFaceErr({ code: "WARN", message: r.face.warnings.join(" ") });
    } catch (e) {
      setFaceErr(errorOf(e));
    } finally {
      setBusyPerson(null);
    }
  }

  async function renamePerson(id: string, name: string) {
    const person = people.find((p) => p.id === id);
    if (!person || person.name === name.trim() || !name.trim()) return;
    try {
      const upd = await patchJSON<{ identity: Identity }>(`/identities/${id}`, { name: name.trim() });
      setPeople((prev) => prev.map((p) => (p.id === id ? upd.identity : p)));
    } catch (e) {
      setFaceErr(errorOf(e));
    }
  }

  async function removePhoto(identityId: string, faceId: string) {
    const person = people.find((p) => p.id === identityId);
    if (!person) return;
    if (person.face_ids.length <= 1) {
      removePerson(identityId);
      return;
    }
    setAsk({
      title: "Удалить это фото?",
      text: `У «${person.name}» останется ${person.face_ids.length - 1} фото.`,
      run: () => doRemovePhoto(identityId, faceId),
    });
  }

  async function doRemovePhoto(identityId: string, faceId: string) {
    const person = people.find((p) => p.id === identityId);
    if (!person) return;
    try {
      const upd = await patchJSON<{ identity: Identity }>(`/identities/${identityId}`, { face_ids: person.face_ids.filter((f) => f !== faceId) });
      setPeople((prev) => prev.map((p) => (p.id === identityId ? upd.identity : p)));
      await del(`/faces/${faceId}`);
      setFaces((prev) => prev.filter((f) => f.id !== faceId));
    } catch (e) {
      setFaceErr(errorOf(e));
    }
  }

  function removePerson(id: string) {
    const person = people.find((p) => p.id === id);
    if (!person) return;
    setAsk({
      title: `Удалить «${person.name}»?`,
      text: `Вместе с ним удалятся его фото: ${person.face_ids.length}.`,
      run: () => doRemovePerson(id),
    });
  }

  async function doRemovePerson(id: string) {
    const person = people.find((p) => p.id === id);
    if (!person) return;
    try {
      await del(`/identities/${id}`);
      for (const fid of person.face_ids) {
        await del(`/faces/${fid}`).catch(() => {});
      }
      setPeople((prev) => prev.filter((p) => p.id !== id));
      setFaces((prev) => prev.filter((f) => !person.face_ids.includes(f.id)));
      setChoice((cur) => Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, v === id ? NONE : v])));
    } catch (e) {
      setFaceErr(errorOf(e));
    }
  }

  // ---------------- источник и фон
  async function addUrl() {
    if (!url.trim()) return;
    setSourceBusy(true);
    setSourceErr(null);
    try {
      setSource(await postJSON<Source>("/sources", { url: url.trim() }));
      setChoice({});
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
      setChoice({});
    } catch (e) {
      setSourceErr(errorOf(e));
    } finally {
      setSourceBusy(false);
      setUploadPct(null);
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

  // ---------------- задача
  const assignments = useMemo(
    () =>
      persons
        .map((p) => ({ person: p.id, identity_id: choice[p.id] || NONE }))
        .filter((a) => a.identity_id),
    [persons, choice],
  );
  // Оценка времени. Секунды на кадр замерены на этой машине и приходят с сервера,
  // плюс ~25 с на проход: разбор, поиск лиц и сборка видео.
  const presets = system?.presets ?? [];
  const preset = presets.find((p) => p.id === quality) ?? presets[0];
  const frames = source?.info ? Math.round(source.info.duration * source.info.fps) : 0;
  const passes = Math.max(1, assignments.length);
  function estimate(p: { sec_per_frame: number }): string {
    if (!frames) return "";
    const sec = frames * p.sec_per_frame * passes + 25 * passes;
    if (sec < 90) return `≈ ${Math.round(sec / 10) * 10} с`;
    return `≈ ${Math.round(sec / 60)} мин`;
  }
  const freeVram = system?.gpu_free_vram_mb ?? 0;
  const gpuTight = !!preset && freeVram > 0 && freeVram < preset.vram_mb;

  const canGenerate = sourceReady && (assignments.length > 0 || (bgEnabled && !!bg)) && !running;
  const whyDisabled = !sourceReady
    ? "Сначала добавьте видео."
    : !people.length
      ? "Добавьте человека и его фото на шаге 2."
      : !persons.length
        ? "В этом видео нет лица. Можно заменить только фон."
        : assignments.length === 0 && !(bgEnabled && bg)
          ? "Выберите, чьё лицо заменить."
          : "";

  async function generate() {
    if (!source) return;
    setJobErr(null);
    setLogs([]);
    setShowLogs(false);
    try {
      const r = await postJSON<{ job_id: string; job: Job }>("/jobs", {
        source_id: source.id,
        assignments,
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
      /* видео могли удалить */
    }
  }
  function removeJob(j: Job) {
    setAsk({
      title: "Удалить это видео?",
      text: "Готовый ролик и журнал задачи будут удалены без возможности вернуть." + (source?.id !== j.source_id ? " Исходник тоже удалится, если он больше нигде не нужен." : ""),
      run: () => doRemoveJob(j),
    });
  }

  async function doRemoveJob(j: Job) {
    try {
      await del(`/jobs/${j.id}${source?.id !== j.source_id ? "?with_source=true" : ""}`);
      setHistory((prev) => prev.filter((x) => x.id !== j.id));
      if (job?.id === j.id) setJob(null);
    } catch (e) {
      setJobErr(errorOf(e));
    }
  }

  async function reuseResult() {
    if (!job?.result) return;
    setSourceBusy(true);
    setSourceErr(null);
    try {
      const res = await fetch(job.result.video_url);
      const blob = await res.blob();
      await addFile(new File([blob], `clipy-${job.id}.mp4`, { type: "video/mp4" }));
      setJob(null);
    } catch (e) {
      setSourceErr(errorOf(e));
    } finally {
      setSourceBusy(false);
    }
  }

  const hw = system?.hardware;
  const st = job ? STATUS_RU[job.status] : null;

  return (
    <div className="app">
      <Confirm ask={ask} onClose={() => setAsk(null)} />
      <header className="topbar">
        <a href="/" className="back-btn">
          <span className="arrow">←</span> Вернуться в Гудини
        </a>
        <div className="sys">
          {systemErr ? "Сервер недоступен" : system && hw?.backend === "cpu" ? "Считает процессор, будет медленно" : ""}
        </div>
      </header>
      <h1 className="page-title">Clipy</h1>
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
              {source.info.width}×{source.info.height} · {fmtDuration(source.info.duration)} · {source.info.has_audio ? "со звуком" : "без звука"} · людей в кадре: {persons.length}
            </p>
          </div>
        )}
      </section>

      {/* 2. Люди */}
      <section className="card">
        <div className="card-head">
          <span className="step-n">2</span>
          <h2>Люди для замены</h2>
          <span className="spacer" />
          {people.length > 0 && <span className="status success">Людей: {people.length}</span>}
        </div>
        <Msg error={faceErr} kind={faceErr?.code === "WARN" ? "warn" : "err"} />
        <div className="people">
          {people.map((p) => (
            <div className="person-card" key={p.id}>
              <div className="person-head">
                <input
                  type="text"
                  defaultValue={p.name}
                  onBlur={(e) => renamePerson(p.id, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  disabled={running}
                  aria-label="Имя человека"
                />
                <span className="kv">{p.face_ids.length} {photoWord(p.face_ids.length)}</span>
                <span className="spacer" />
                <button className="link-btn" onClick={() => removePerson(p.id)} disabled={running}>Удалить</button>
              </div>
              <div className="faces">
                {p.face_ids.map((fid) => {
                  const f = faceById.get(fid);
                  return (
                    <div className="face" key={fid}>
                      {f ? <img src={f.thumb_url} alt="" /> : <div className="face-missing">?</div>}
                      <button className="x" title="Удалить фото" onClick={() => void removePhoto(p.id, fid)} disabled={running}>×</button>
                    </div>
                  );
                })}
                <PhotoAdd onFile={(file) => addPhoto(p.id, file)} disabled={running || busyPerson !== null} busy={busyPerson === p.id} />
              </div>
            </div>
          ))}
          {draftName !== null && (
            <div className="person-card">
              <div className="person-head">
                <input type="text" value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Имя, например «Я»" autoFocus disabled={running} aria-label="Имя нового человека" />
                <span className="spacer" />
                <button className="link-btn" onClick={() => setDraftName(null)} disabled={running}>Отмена</button>
              </div>
              <div className="faces">
                <PhotoAdd onFile={(file) => addPhoto("draft", file)} disabled={running || busyPerson !== null} busy={busyPerson === "draft"} />
                <span className="hint" style={{ alignSelf: "center" }}>Добавьте первое фото</span>
              </div>
            </div>
          )}
        </div>
        {draftName === null && (
          <div className="actions">
            <button className="btn btn-secondary" onClick={() => setDraftName("")} disabled={running}>Добавить человека</button>
          </div>
        )}
      </section>

      {/* 3. Кого на кого меняем */}
      <section className="card">
        <div className="card-head">
          <span className="step-n">3</span>
          <h2>Кого на кого меняем</h2>
          <span className="spacer" />
          {assignments.length > 0 && <span className="status success">Замен: {assignments.length}</span>}
        </div>
        {!sourceReady && <p className="hint">Сначала добавьте видео.</p>}
        {sourceReady && persons.length === 0 && (
          <div className="box warn">
            <b>В этом видео не найдено лицо, пригодное для замены.</b>
            {source?.skipped_faces ? "Детектор находил похожие на лицо места, но это не лица человека или они слишком мелкие: так бывает с игровым видео, рисунками и людьми на заднем плане. " : "Лицо должно быть видно и занимать заметную часть кадра. "}
            Заменить фон при этом можно.
          </div>
        )}
        {sourceReady && persons.length > 0 && (
          <>
            <p className="hint" style={{ marginBottom: 10 }}>Кого не выбрали, останется без изменений.</p>
            <div className="assign">
              {persons.map((p, i) => {
                const value = choice[p.id] || NONE;
                const chosen = people.find((x) => x.id === value);
                const preview = chosen ? faceById.get(chosen.face_ids[0]) : undefined;
                return (
                  <div className="assign-row" key={p.id}>
                    <img className="assign-face" src={p.thumbnail_url} alt="" />
                    <div className="assign-info">
                      <b>Человек {i + 1}</b>
                      <span className="kv">{i === 0 ? "чаще всех в кадре · " : ""}в {Math.round(p.coverage * 100)}% кадров</span>
                    </div>
                    <span className="assign-arrow" aria-hidden>→</span>
                    {preview ? <img className="assign-face" src={preview.thumb_url} alt="" /> : <div className="assign-face empty">нет</div>}
                    <select value={value} onChange={(e) => setChoice((c) => ({ ...c, [p.id]: e.target.value }))} disabled={running} aria-label={`Чем заменить человека ${i + 1}`}>
                      <option value={NONE}>Не менять</option>
                      {people.map((x) => (
                        <option key={x.id} value={x.id}>{x.name} · {x.face_ids.length} {photoWord(x.face_ids.length)}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            {!people.length && <p className="hint" style={{ marginTop: 10 }}>Сначала добавьте человека на шаге 2.</p>}
          </>
        )}
        <label className="check" style={{ marginTop: 18 }}>
          <input type="checkbox" checked={bgEnabled} onChange={(e) => setBgEnabled(e.target.checked)} disabled={running} /> Заменить фон
        </label>
        {bgEnabled && (
          <div style={{ marginTop: 10 }}>
            <Drop accept="image/jpeg,image/png,video/mp4,.jpg,.jpeg,.png,.mp4" onFile={addBackground} label={bgBusy ? "Загружаем…" : bg ? `Фон: ${bg.filename}` : "Загрузить фон"} sub="картинка JPEG или PNG, либо видео MP4" disabled={bgBusy || running} />
            <Msg error={bgErr} />
            {bg && (bg.kind === "image" ? <img className="preview-img" src={bg.preview_url} alt="" /> : <video className="video" src={bg.preview_url} muted controls style={{ marginTop: 10, maxHeight: 200 }} />)}
          </div>
        )}
      </section>

      {/* 4. Запуск */}
      <section className="card">
        {presets.length > 1 && !running && (
          <div className="quality">
            {presets.map((p) => (
              <button key={p.id} className={`qual ${quality === p.id ? "on" : ""}`} onClick={() => setQuality(p.id)} type="button">
                <b>{p.label}</b>
                <span className="qual-time">{estimate(p) || "—"}</span>
                <span className="qual-note">{p.note}</span>
              </button>
            ))}
          </div>
        )}
        {!running ? (
          <button className="btn btn-big" onClick={generate} disabled={!canGenerate}>Создать видео</button>
        ) : (
          <button className="btn btn-danger btn-big" onClick={cancel}>Отменить</button>
        )}
        {!running && !canGenerate && whyDisabled && <p className="hint" style={{ marginTop: 8 }}>{whyDisabled}</p>}
        {!running && canGenerate && assignments.length > 1 && <p className="hint" style={{ marginTop: 8 }}>Замен {assignments.length}: каждая считается отдельным проходом, поэтому времени уйдёт больше.</p>}
        {!running && gpuTight && (
          <div className="box warn" style={{ marginTop: 10 }}>
            <b>Видеокарта занята другим приложением.</b> Свободно {freeVram} МБ, режиму нужно около {preset!.vram_mb} МБ.
            Закройте OBS, игру или лишние окна браузера, иначе замена пойдёт в разы дольше.
          </div>
        )}
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
            <button className="btn btn-secondary" onClick={reuseResult} disabled={sourceBusy}>Продолжить с этим результатом</button>
            <span className="spacer" />
            <button className="btn btn-danger" onClick={() => removeJob(job)}>Удалить видео</button>
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
              const n = (h.assignments ?? []).length;
              return (
                <div key={h.id} className={`hist ${job?.id === h.id ? "active" : ""}`} onClick={() => openJob(h)}>
                  {h.result?.poster_url ? <img src={h.result.poster_url} alt="" /> : <div className="noimg" />}
                  <div>
                    <div>{h.source?.url ? h.source.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48) : "Загруженное видео"}</div>
                    <div className="kv">{new Date(h.created_at).toLocaleString("ru-RU")} · замен: {n || (h.face_swap ? 1 : 0)}{h.background ? " · с фоном" : ""}</div>
                  </div>
                  <span className={`status ${hs.tone}`}>{hs.text}</span>
                  <button
                    className="btn btn-ghost btn-sm"
                    title="Удалить видео"
                    onClick={(e) => { e.stopPropagation(); removeJob(h); }}
                    disabled={h.status === "queued" || h.status === "processing"}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
