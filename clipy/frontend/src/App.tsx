import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API, del, getJSON, postJSON, upload, RequestError, type ApiError, type Face, type Identity, type Job, type Source, type Stage, type SystemInfo } from "./api";

type Quality = "fast" | "balanced" | "best";

function errorOf(e: unknown): ApiError {
  if (e instanceof RequestError) return e.error;
  return { code: "UNKNOWN", message: e instanceof Error ? e.message : String(e) };
}

function Alert({ error, kind = "err" }: { error: ApiError | null | undefined; kind?: "err" | "warn" | "ok" }) {
  if (!error) return null;
  return (
    <div className={`alert ${kind}`}>
      <b>{error.message}</b>
      {error.hint && <span>{error.hint}</span>}
    </div>
  );
}

function fmtDuration(s?: number) {
  if (!s && s !== 0) return "";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m}:${String(r).padStart(2, "0")}` : `${r}s`;
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
      {sub && <div className="muted">{sub}</div>}
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
          <span>
            {s.label}
            {s.note && <span className="note"> · {s.note}</span>}
          </span>
          <span className="note">{s.status === "running" ? `${s.progress}%` : s.status === "done" ? "✓" : s.status === "skipped" ? "skipped" : s.status === "failed" ? "failed" : ""}</span>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [systemErr, setSystemErr] = useState<ApiError | null>(null);

  // source
  const [url, setUrl] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [sourceErr, setSourceErr] = useState<ApiError | null>(null);

  // identity
  const [faces, setFaces] = useState<Face[]>([]);
  const [faceBusy, setFaceBusy] = useState(false);
  const [faceErr, setFaceErr] = useState<ApiError | null>(null);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [identityId, setIdentityId] = useState<string>("");
  const [profileName, setProfileName] = useState("MY FACE");

  // options
  const [faceSwap, setFaceSwap] = useState(true);
  const [target, setTarget] = useState<string>("auto");
  const [bgEnabled, setBgEnabled] = useState(false);
  const [bg, setBg] = useState<{ background_id: string; kind: string; preview_url: string; filename: string } | null>(null);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgErr, setBgErr] = useState<ApiError | null>(null);
  const [quality, setQuality] = useState<Quality>("balanced");

  // job
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
      const r = await getJSON<{ faces: Face[] }>("/faces");
      setFaces(r.faces);
    } catch {
      /* ignore */
    }
  }, []);
  const loadIdentities = useCallback(async () => {
    try {
      const r = await getJSON<{ identities: Identity[] }>("/identities");
      setIdentities(r.identities);
    } catch {
      /* ignore */
    }
  }, []);
  const loadHistory = useCallback(async () => {
    try {
      const r = await getJSON<{ jobs: Job[] }>("/jobs");
      setHistory(r.jobs);
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

  // poll source analysis
  useEffect(() => {
    if (!source || (source.status !== "queued" && source.status !== "processing")) return;
    const t = setInterval(async () => {
      try {
        const s = await getJSON<Source>(`/sources/${source.id}`);
        setSource(s);
        if (s.status === "ready" && s.persons.length) setTarget((cur) => (cur === "auto" || s.persons.some((p) => p.id === cur) ? cur : "auto"));
      } catch {
        /* keep polling */
      }
    }, 1000);
    return () => clearInterval(t);
  }, [source]);

  // poll job
  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "processing")) return;
    const t = setInterval(async () => {
      try {
        const j = await getJSON<Job>(`/jobs/${job.id}`);
        setJob(j);
        if (showLogs) {
          const l = await getJSON<{ lines: string[] }>(`/jobs/${job.id}/logs?n=300`);
          setLogs(l.lines);
        }
        if (j.status !== "queued" && j.status !== "processing") {
          void loadHistory();
          const l = await getJSON<{ lines: string[] }>(`/jobs/${job.id}/logs?n=300`);
          setLogs(l.lines);
        }
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

  // ---------------- source actions
  async function addUrl() {
    if (!url.trim()) return;
    setSourceBusy(true);
    setSourceErr(null);
    try {
      const s = await postJSON<Source>("/sources", { url: url.trim() });
      setSource(s);
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
      const s = await postJSON<Source>("/sources", { upload_id: up.upload_id });
      setSource(s);
      setTarget("auto");
    } catch (e) {
      setSourceErr(errorOf(e));
    } finally {
      setSourceBusy(false);
      setUploadPct(null);
    }
  }

  // ---------------- identity actions
  const [selectedFaceIds, setSelectedFaceIds] = useState<string[]>([]);
  useEffect(() => {
    // keep only faces that still exist
    setSelectedFaceIds((ids) => ids.filter((id) => faces.some((f) => f.id === id)));
  }, [faces]);
  useEffect(() => {
    if (!identityId) return;
    const ident = identities.find((i) => i.id === identityId);
    if (ident) setSelectedFaceIds(ident.face_ids);
  }, [identityId, identities]);

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
    try {
      await del(`/faces/${id}`);
      setFaces((prev) => prev.filter((f) => f.id !== id));
      setSelectedFaceIds((ids) => ids.filter((x) => x !== id));
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
    try {
      await del(`/identities/${id}`);
      setIdentities((prev) => prev.filter((i) => i.id !== id));
      if (identityId === id) setIdentityId("");
    } catch (e) {
      setFaceErr(errorOf(e));
    }
  }

  // ---------------- background
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

  // ---------------- job
  const sourceReady = source?.status === "ready";
  const canGenerate = sourceReady && ((faceSwap && selectedFaceIds.length > 0 && (source?.persons.length ?? 0) > 0) || (bgEnabled && !!bg)) && !(job && (job.status === "queued" || job.status === "processing"));

  async function generate() {
    if (!source) return;
    setJobErr(null);
    setLogs([]);
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
      const s = await getJSON<Source>(`/sources/${j.source_id}`);
      setSource(s);
    } catch {
      /* source may have been deleted */
    }
  }

  const hw = system?.hardware;
  const backendChip = hw ? (hw.backend === "cuda" ? "ok" : hw.backend === "directml" ? "warn" : "warn") : "";
  const running = !!job && (job.status === "queued" || job.status === "processing");
  const readyPersons = source?.persons ?? [];
  const selectedFaces = useMemo(() => selectedFaceIds.map((id) => faces.find((f) => f.id === id)).filter(Boolean) as Face[], [selectedFaceIds, faces]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          AI REELS REMAKER
          <small>CLIPY · LOCAL FACE SWAP</small>
        </div>
        <div className="sysbadge">
          {system ? (
            <>
              <span className={`chip ${backendChip}`}>GPU: {hw?.gpu_name || "none"}</span>
              <span className={`chip ${backendChip}`}>Backend: {hw?.backend.toUpperCase()}</span>
              <span className={`chip ${system.engine.installed ? "ok" : "err"}`}>FaceFusion {system.engine.version}</span>
              <span className={`chip ${system.ffmpeg ? "ok" : "err"}`}>FFmpeg {system.ffmpeg ? "✓" : "missing"}</span>
              {system.cookies.present && <span className="chip ok">cookies.txt</span>}
            </>
          ) : systemErr ? (
            <span className="chip err">Backend offline</span>
          ) : (
            <span className="chip"><span className="spin" /> detecting hardware…</span>
          )}
        </div>
      </header>
      {hw?.notes?.length ? <div className="alert warn">{hw.notes.join(" · ")}</div> : null}

      <div className="grid">
        {/* ------------------------------------------------ left column */}
        <div>
          <section className="panel">
            <h2>SOURCE VIDEO</h2>
            <div className="row">
              <div style={{ flex: 1, minWidth: 200 }}>
                <input type="url" placeholder="TikTok / Instagram / Shorts URL" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addUrl()} disabled={sourceBusy || running} />
              </div>
              <button className="btn" onClick={addUrl} disabled={sourceBusy || running || !url.trim()}>
                {sourceBusy && !uploadPct ? <span className="spin" /> : null} Add link
              </button>
            </div>
            <div className="or">OR</div>
            <Drop accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" onFile={addFile} label={uploadPct !== null ? `Uploading ${uploadPct}%` : "Upload MP4 / MOV / WebM"} sub="drop a file here or click" disabled={sourceBusy || running} />
            {uploadPct !== null && <div className="progress"><div style={{ width: `${uploadPct}%` }} /></div>}
            <Alert error={sourceErr} />
            {source && (
              <div style={{ marginTop: 12 }}>
                {(source.status === "queued" || source.status === "processing") && (
                  <>
                    <div className="row"><span className="spin" /> <span>{source.job?.status === "queued" ? "Waiting for the queue…" : source.job?.stage_label || "Preparing…"}</span> <span className="muted">{source.job?.progress ?? 0}%</span></div>
                    <div className="progress"><div style={{ width: `${source.job?.progress ?? 0}%` }} /></div>
                    {source.job?.stages && <StageList stages={source.job.stages} />}
                  </>
                )}
                {source.status === "failed" && <Alert error={source.error} />}
                {source.status === "ready" && source.info && (
                  <>
                    <video className="preview-video" src={source.video_url ?? undefined} poster={source.poster_url ?? undefined} controls playsInline preload="metadata" />
                    <div className="kv" style={{ marginTop: 6 }}>
                      <b>{source.info.width}×{source.info.height}</b> · {source.info.fps} fps · {fmtDuration(source.info.duration)} · {source.info.has_audio ? "audio ✓" : "no audio"}
                      {source.url && <> · <a href={source.url} target="_blank" rel="noreferrer">link</a></>}
                    </div>
                  </>
                )}
              </div>
            )}
          </section>

          <section className="panel" style={{ marginTop: 16 }}>
            <h2>IDENTITY</h2>
            <div className="row" style={{ marginBottom: 10 }}>
              <select value={identityId} onChange={(e) => setIdentityId(e.target.value)} disabled={running}>
                <option value="">— saved profiles —</option>
                {identities.map((i) => (
                  <option key={i.id} value={i.id}>{i.name} ({i.face_ids.length} photo{i.face_ids.length === 1 ? "" : "s"})</option>
                ))}
              </select>
              {identityId && <button className="btn small danger" onClick={() => deleteProfile(identityId)} disabled={running}>Delete profile</button>}
            </div>
            <Drop accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" onFile={addFace} label={faceBusy ? "Checking the photo…" : "Upload my face photo"} sub="one clearly visible face · up to 10 photos per profile" disabled={faceBusy || running} />
            <Alert error={faceErr} kind={faceErr?.code === "WARN" ? "warn" : "err"} />
            {selectedFaces.length > 0 && (
              <>
                <div className="muted" style={{ margin: "10px 0 6px" }}>Photos used for this run ({selectedFaces.length}):</div>
                <div className="faces">
                  {selectedFaces.map((f) => (
                    <div className="face" key={f.id}>
                      <img src={f.thumb_url} alt="" />
                      <button className="x" title="Remove from this run" onClick={() => setSelectedFaceIds((ids) => ids.filter((x) => x !== f.id))} disabled={running}>×</button>
                    </div>
                  ))}
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <input type="text" value={profileName} onChange={(e) => setProfileName(e.target.value)} style={{ maxWidth: 200 }} disabled={running} />
                  <button className="btn small" onClick={saveProfile} disabled={running}>Save as profile</button>
                </div>
              </>
            )}
            {faces.filter((f) => !selectedFaceIds.includes(f.id)).length > 0 && (
              <>
                <div className="muted" style={{ margin: "12px 0 6px" }}>Other uploaded photos (click to add):</div>
                <div className="faces">
                  {faces.filter((f) => !selectedFaceIds.includes(f.id)).map((f) => (
                    <div className="face" key={f.id} onClick={() => setSelectedFaceIds((ids) => (ids.length >= 10 ? ids : [...ids, f.id]))} style={{ cursor: "pointer" }}>
                      <img src={f.thumb_url} alt="" />
                      <button className="x" title="Delete photo" onClick={(e) => { e.stopPropagation(); void removeFace(f.id); }} disabled={running}>×</button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>

        {/* ------------------------------------------------ right column */}
        <div>
          <section className="panel">
            <h2>FACE REPLACEMENT</h2>
            <label className="check">
              <input type="checkbox" checked={faceSwap} onChange={(e) => setFaceSwap(e.target.checked)} disabled={running} /> Replace face
            </label>
            {faceSwap && (
              <div style={{ marginTop: 10 }}>
                <div className="muted">Target person:</div>
                {!sourceReady && <div className="muted">Add a source video to see the people in it.</div>}
                {sourceReady && readyPersons.length === 0 && <div className="alert warn"><b>No face was found in this video.</b>Face replacement is not possible; background replacement still works.</div>}
                {sourceReady && readyPersons.length > 0 && (
                  <div className="persons">
                    <div className={`person ${target === "auto" ? "selected" : ""}`} onClick={() => !running && setTarget("auto")}>
                      <img src={readyPersons[0].thumbnail_url} alt="" />
                      Auto (main person)
                    </div>
                    {readyPersons.map((p, i) => (
                      <div key={p.id} className={`person ${target === p.id ? "selected" : ""}`} onClick={() => !running && setTarget(p.id)}>
                        <img src={p.thumbnail_url} alt="" />
                        Person {i + 1}
                        <div className="muted">{Math.round(p.coverage * 100)}% of frames</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel" style={{ marginTop: 16 }}>
            <h2>BACKGROUND</h2>
            <label className="check">
              <input type="checkbox" checked={bgEnabled} onChange={(e) => setBgEnabled(e.target.checked)} disabled={running} /> Replace background
            </label>
            {bgEnabled && (
              <div style={{ marginTop: 10 }}>
                <Drop accept="image/jpeg,image/png,video/mp4,.jpg,.jpeg,.png,.mp4" onFile={addBackground} label={bgBusy ? "Uploading…" : bg ? `Background: ${bg.filename}` : "Upload image/video background"} sub="JPEG, PNG or MP4" disabled={bgBusy || running} />
                <Alert error={bgErr} />
                {bg && (bg.kind === "image" ? <img className="preview-img" src={bg.preview_url} alt="" style={{ marginTop: 8 }} /> : <video className="preview-video" src={bg.preview_url} muted controls style={{ marginTop: 8, maxHeight: 200 }} />)}
              </div>
            )}
          </section>

          <section className="panel" style={{ marginTop: 16 }}>
            <h2>QUALITY</h2>
            <div className="seg">
              {(["fast", "balanced", "best"] as Quality[]).map((q) => (
                <button key={q} className={quality === q ? "active" : ""} onClick={() => setQuality(q)} disabled={running}>{q.toUpperCase()}</button>
              ))}
            </div>
            <div className="muted" style={{ marginTop: 8 }}>
              {quality === "fast" && "inswapper 128, no enhancer, box mask · quick preview"}
              {quality === "balanced" && "hyperswap 256, GFPGAN 50%, occlusion mask · good for most clips"}
              {quality === "best" && "hyperswap 512 pixel boost, GFPGAN 70%, occlusion + region masks · slowest"}
              {hw?.backend === "cpu" && " · CPU backend: expect minutes per second of video"}
            </div>
          </section>

          <section className="panel" style={{ marginTop: 16 }}>
            {!running ? (
              <button className="btn primary big" onClick={generate} disabled={!canGenerate}>GENERATE</button>
            ) : (
              <button className="btn danger big" onClick={cancel}>CANCEL</button>
            )}
            {!canGenerate && !running && (
              <div className="muted" style={{ marginTop: 8 }}>
                {!sourceReady ? "Waiting for a source video." : faceSwap && !selectedFaceIds.length ? "Upload your face photo." : faceSwap && !readyPersons.length && !(bgEnabled && bg) ? "No face in the video." : bgEnabled && !bg && !faceSwap ? "Upload a background." : ""}
              </div>
            )}
            <Alert error={jobErr} />
            {job && (
              <div style={{ marginTop: 14 }}>
                <div className="row">
                  <span className={`status ${job.status}`}>{job.status.toUpperCase()}</span>
                  {job.status === "queued" && job.queue_position > 0 && <span className="muted">queue position {job.queue_position}</span>}
                  <span className="muted">{job.stage_label}</span>
                  <span className="spacer" />
                  <span className="muted">{job.progress}%</span>
                </div>
                <div className="progress"><div style={{ width: `${job.progress}%` }} /></div>
                <StageList stages={job.stages} />
                {job.status === "failed" && <Alert error={job.error} />}
                {job.status === "cancelled" && <div className="alert warn"><b>Cancelled.</b></div>}
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn small" onClick={() => setShowLogs((v) => !v)}>{showLogs ? "Hide log" : "Show log"}</button>
                  {job.engine?.swapper && <span className="muted">{job.engine.swapper}{job.engine.enhancer ? ` + ${job.engine.enhancer}` : ""}</span>}
                </div>
                {showLogs && <div className="logs" style={{ marginTop: 8 }}>{logs.join("\n") || "…"}</div>}
              </div>
            )}
          </section>
        </div>
      </div>

      {job?.status === "completed" && job.result && (
        <section className="panel" style={{ marginTop: 16 }}>
          <h2>RESULT</h2>
          <div className="compare">
            <div>
              <h3>BEFORE</h3>
              <video className="preview-video" src={source?.video_url ?? undefined} controls playsInline preload="metadata" />
            </div>
            <div>
              <h3>AFTER</h3>
              <video className="preview-video" src={job.result.video_url} poster={job.result.poster_url} controls playsInline preload="metadata" />
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <a className="btn primary" href={job.result.video_url} download={`clipy-${job.id}.mp4`}>Download MP4</a>
            <span className="kv"><b>{job.result.width}×{job.result.height}</b> · {job.result.fps} fps · {fmtDuration(job.result.duration)} · {job.result.has_audio ? "audio ✓" : "no audio"}</span>
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="panel" style={{ marginTop: 16 }}>
          <h2>HISTORY</h2>
          <div className="history">
            {history.slice(0, 12).map((h) => (
              <div key={h.id} className={`hist ${job?.id === h.id ? "active" : ""}`} onClick={() => openJob(h)}>
                {h.result?.poster_url ? <img src={h.result.poster_url} alt="" /> : <div style={{ width: 56, height: 80, background: "#000", borderRadius: 6 }} />}
                <div>
                  <div>{h.source?.url ? h.source.url.slice(0, 60) : "uploaded video"} · {h.quality}</div>
                  <div className="muted">{new Date(h.created_at).toLocaleString()} · {h.face_swap ? `face ${h.target_person}` : "no face swap"}{h.background ? " · background" : ""}</div>
                </div>
                <span className={`status ${h.status}`}>{h.status}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="muted" style={{ marginTop: 20, textAlign: "center" }}>
        API: {API} · logs: data/logs/clipy.log · cookies: data/cookies.txt
      </div>
    </div>
  );
}
