"use client";

import { useEffect, useRef, useState } from "react";
import { attachCamera, createPortraitCapture, PORTRAIT_FRAME, type PortraitCapture } from "@/lib/portraitCapture";

export default function Teleprompter({ script, onClose, onRecorded }: {
  script: string;
  onClose: () => void;
  onRecorded: (blob: Blob) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const captureRef = useRef<PortraitCapture | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const scrollRef = useRef({ offset: 0, raf: 0 });
  const [recording, setRecording] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [ready, setReady] = useState(false);
  const [speed, setSpeed] = useState(55);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [review, setReview] = useState<{ blob: Blob; url: string } | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number }>();
  // Уровень микрофона (пик за последние 4 с, дБFS) и предупреждение: дубль с iPhone
  // пришёл на −57 дБ, и это выяснилось только после платного монтажа.
  const [micDb, setMicDb] = useState<number | null>(null);
  const [micWarn, setMicWarn] = useState("");
  // Кадров камеры в секунду: iPhone Safari может перестать отдавать кадры молча.
  const [camFps, setCamFps] = useState<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.min(entry.contentRect.width, entry.contentRect.height * 9 / 16);
      setFrameSize({ width, height: width * 16 / 9 });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  function stop() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    setScrolling(false);
    setStopping(true);
    recorder.stop();
  }

  useEffect(() => {
    if (review) return;
    const abort = new AbortController();
    let source: MediaStream | null = null;
    let capture: PortraitCapture | null = null;
    let removeTrackListeners = () => {};
    let meterTimer = 0;
    let fpsTimer = 0;
    setReady(false);
    setError("");
    setMicDb(null);
    setMicWarn("");
    setCamFps(null);

    const interrupt = (message: string) => {
      if (abort.signal.aborted) return;
      setReady(false);
      setError(message);
      stop(); // Preserve the recorded part for review instead of uploading a frozen take.
    };
    const onVisibility = () => {
      if (document.hidden && recorderRef.current?.state === "recording") {
        interrupt("Запись остановлена при уходе со страницы. Проверьте сохранённый дубль.");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
          throw new Error("Запись недоступна в этом браузере. Откройте сайт в Safari или Chrome по HTTPS.");
        }
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas) return;
        if (typeof canvas.captureStream !== "function") throw new Error("Этот браузер не поддерживает запись кадра 9:16.");
        const mobile = /iPhone|iPad|Android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
        // Constraints use the camera's primary orientation; the decoded video can be portrait.
        // Prefer an uncropped source and do the ONE visible crop on our recording canvas.
        const nativeSize: MediaTrackConstraints = {
          facingMode: "user",
          width: { ideal: mobile ? 1920 : 3840 },
          height: { ideal: mobile ? 1080 : 2160 },
          frameRate: { ideal: 30, max: 30 },
          ...((navigator.mediaDevices.getSupportedConstraints() as Record<string, boolean>).resizeMode
            ? { resizeMode: { ideal: "none" } } : {}),
        };
        let lastError: unknown;
        for (const constraints of [nativeSize, { facingMode: "user" }]) {
          try {
            source = await navigator.mediaDevices.getUserMedia({
              video: constraints,
              // echoCancellation:false — на iPhone «обработка голоса» Safari (эхоподавление)
              // отдаёт микрофон на 25–30 дБ тише, чем камера телефона; страница ничего не
              // воспроизводит, подавлять эхо нечего. Уровень виден в индикаторе микрофона.
              audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
            });
            if (abort.signal.aborted) {
              source.getTracks().forEach((track) => track.stop());
              return;
            }
            await attachCamera(video, source, abort.signal);
            break;
          } catch (err) {
            source?.getTracks().forEach((track) => track.stop());
            source = null;
            lastError = err;
            if (abort.signal.aborted) return;
            if (err instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(err.name)) throw err;
          }
        }
        if (!source) throw lastError ?? new Error("Камера недоступна");
        if (abort.signal.aborted) return;
        capture = createPortraitCapture(video, canvas, source, (err) => {
          captureRef.current = null;
          interrupt(err.message);
        });
        captureRef.current = capture;
        const onMute = () => interrupt("Камера или микрофон приостановлены. Проверьте дубль или откройте камеру заново.");
        const onEnded = () => interrupt("Камера или микрофон отключены. Откройте камеру заново.");
        const onUnmute = () => {
          if (!abort.signal.aborted && captureRef.current?.isLive()) {
            setReady(true);
          }
        };
        source.getTracks().forEach((track) => {
          track.addEventListener("mute", onMute);
          track.addEventListener("ended", onEnded);
          track.addEventListener("unmute", onUnmute);
        });
        removeTrackListeners = () => source?.getTracks().forEach((track) => {
          track.removeEventListener("mute", onMute);
          track.removeEventListener("ended", onEnded);
          track.removeEventListener("unmute", onUnmute);
        });
        setReady(capture.isLive());
        fpsTimer = window.setInterval(() => {
          const c = captureRef.current;
          setCamFps(c ? c.fps() : null);
        }, 500);
        // Индикатор уровня микрофона: анализатор слушает ту же дорожку, в запись не вмешивается.
        try {
          const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          const audioTracks = source.getAudioTracks();
          if (AC && audioTracks.length) {
            const ctx = new AC();
            audioCtxRef.current = ctx;
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            ctx.createMediaStreamSource(new MediaStream(audioTracks)).connect(analyser);
            const buf = new Float32Array(analyser.fftSize);
            const recent: number[] = [];
            let quietSince = 0;
            let silentSince = 0;
            meterTimer = window.setInterval(() => {
              if (ctx.state === "suspended") { void ctx.resume().catch(() => {}); return; }
              analyser.getFloatTimeDomainData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
              const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-6);
              recent.push(db);
              if (recent.length > 27) recent.shift(); // ~4 с
              const peak = Math.max(...recent);
              setMicDb(peak);
              const now = Date.now();
              const rec = recorderRef.current?.state === "recording";
              if (!rec) { quietSince = 0; silentSince = 0; setMicWarn(""); return; }
              if (peak > -40) { quietSince = 0; silentSince = 0; setMicWarn(""); return; }
              if (peak > -60) {
                silentSince = 0;
                quietSince ||= now;
                if (now - quietSince > 3000) setMicWarn(`Микрофон пишет очень тихо (${peak.toFixed(0)} дБ, норма −20…−30): монтаж такую запись отклонит. Говорите ближе или проверьте микрофон.`);
                return;
              }
              quietSince = 0;
              silentSince ||= now;
              if (now - silentSince > 10000) setMicWarn(`Микрофон молчит уже ${Math.round((now - silentSince) / 1000)} с. Если вы говорите — микрофон не пишет звук.`);
            }, 150);
          }
        } catch {
          setMicDb(null);
        }
      } catch (err) {
        capture?.dispose();
        captureRef.current = null;
        source?.getTracks().forEach((track) => track.stop());
        if (videoRef.current) videoRef.current.srcObject = null;
        if (!abort.signal.aborted) setError(`Не удалось открыть запись: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();

    return () => {
      abort.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      removeTrackListeners();
      window.clearInterval(meterTimer);
      window.clearInterval(fpsTimer);
      void audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      recorderRef.current = null;
      capture?.dispose();
      captureRef.current = null;
      source?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [review]);

  useEffect(() => () => { if (review) URL.revokeObjectURL(review.url); }, [review]);

  useEffect(() => {
    if (!scrolling) return;
    let last = performance.now();
    const tick = (now: number) => {
      scrollRef.current.offset += speedRef.current * (now - last) / 1000;
      last = now;
      if (textRef.current) textRef.current.style.transform = `translateY(-${scrollRef.current.offset}px)`;
      scrollRef.current.raf = requestAnimationFrame(tick);
    };
    scrollRef.current.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(scrollRef.current.raf);
  }, [scrolling]);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [recording]);

  function start() {
    const capture = captureRef.current;
    if (!ready || !capture?.isLive() || recorderRef.current?.state === "recording" || stopping) return;
    setError("");
    setMicWarn("");
    void audioCtxRef.current?.resume().catch(() => {}); // iOS запускает анализатор только по жесту
    const chunks: Blob[] = [];
    try {
      const mimeType = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].find(
        (mime) => MediaRecorder.isTypeSupported(mime),
      );
      if (!mimeType) throw new Error("Браузер не поддерживает формат записи. Попробуйте Safari или Chrome.");
      const recorder = new MediaRecorder(capture.stream, {
        mimeType, videoBitsPerSecond: 12_000_000, audioBitsPerSecond: 192_000,
      });
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => {
        setError("Браузер прервал запись. Проверьте сохранённый дубль.");
        stop();
      };
      recorder.onstop = () => {
        recorderRef.current = null;
        setRecording(false);
        setScrolling(false);
        setStopping(false);
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (!blob.size) {
          setError("Браузер не сохранил кадры. Попробуйте записать дубль ещё раз.");
          return;
        }
        setReview({ blob, url: URL.createObjectURL(blob) });
      };
      // Safari (mp4) нельзя резать на куски по секунде: склейка фрагментов даёт контейнер
      // с мусорной длительностью, и монтаж падает. Один блок на стоп; webm в Chrome — по секунде.
      if (mimeType.startsWith("video/mp4")) recorder.start();
      else recorder.start(1000);
      recorderRef.current = recorder;
      setSeconds(0);
      setRecording(true);
      setScrolling(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function resetText() {
    scrollRef.current.offset = 0;
    if (textRef.current) textRef.current.style.transform = "translateY(0)";
  }
  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className="tp" role="dialog" aria-modal="true" aria-label="Запись видео 9:16">
      <div className="tp-bar tp-top">
        <span className={recording ? "tp-rec" : "hint"}>
          {review ? "Просмотр записи" : recording ? <><span className="rec-dot" />{mmss}</> : ready ? "Готов к записи" : "Подключение камеры…"}
        </span>
        <span className="tp-format">9:16 · 1080×1920</span>
        {!review && micDb !== null && (
          <span className={`tp-mic ${micDb > -40 ? "tp-mic--ok" : micDb > -60 ? "tp-mic--quiet" : "tp-mic--silent"}`} title="Уровень микрофона, пик за 4 с">
            🎤 {micDb.toFixed(0)} дБ
          </span>
        )}
        {!review && camFps !== null && ready && (
          <span className={`tp-mic ${camFps >= 20 ? "tp-mic--ok" : camFps >= 10 ? "tp-mic--quiet" : "tp-mic--silent"}`} title="Кадров камеры в секунду">
            🎥 {camFps} к/с
          </span>
        )}
        {!review && <>
          <label className="tp-speed">
            <span>Скорость</span>
            <input aria-label="Скорость текста" type="range" min={20} max={120} value={speed} onChange={(event) => setSpeed(Number(event.target.value))} />
          </label>
          <button className="btn btn-secondary btn-sm" onClick={() => setScrolling((value) => !value)}>{scrolling ? "⏸ Текст" : "▶ Текст"}</button>
          <button aria-label="Текст сначала" className="btn btn-secondary btn-sm" onClick={resetText}>⏮</button>
        </>}
      </div>
      <div className="tp-stage" ref={stageRef}>
        <div className="tp-frame" style={frameSize}>
          {review ? <video className="tp-playback" src={review.url} controls playsInline /> : <>
            <video ref={videoRef} className="tp-source" autoPlay muted playsInline aria-hidden />
            <canvas ref={canvasRef} className="tp-canvas" width={PORTRAIT_FRAME.width} height={PORTRAIT_FRAME.height} aria-label="Кадр, который попадёт в запись" />
            <div className="tp-text"><div className="tp-text-inner" ref={textRef}>{script || "Сценарий пуст"}</div></div>
          </>}
        </div>
      </div>
      {error && <div className="error-box tp-error" role="alert">{error}</div>}
      {!error && micWarn && <div className="tp-warn" role="status">{micWarn}</div>}
      {!error && !micWarn && recording && camFps !== null && camFps < 10 && (
        <div className="tp-warn" role="status">Камера отдаёт {camFps} кадров/с — ролик будет дёрганым. Если счётчик на нуле, остановите запись и откройте камеру заново.</div>
      )}
      <div className="tp-bar tp-bottom">
        <p className="tp-frame-note">{review ? "Это сохранённый дубль. Монтаж сохранит его кадрирование." : "В запись попадёт кадр внутри рамки. Текст и кнопки не записываются."}</p>
        {review ? <>
          <button className="btn" onClick={() => onRecorded(review.blob)}>Использовать запись</button>
          <button className="btn btn-secondary" onClick={() => { resetText(); setReview(null); }}>Перезаписать</button>
          <button className="btn btn-secondary" onClick={onClose}>Закрыть</button>
        </> : recording ? <button className="btn" disabled={stopping} onClick={stop}>{stopping ? "Сохранение…" : "⏹ Остановить запись"}</button> : <>
          <button className="btn" disabled={!ready || stopping} onClick={start}>⏺ Начать запись</button>
          <button className="btn btn-secondary" onClick={onClose}>Закрыть</button>
        </>}
      </div>
    </div>
  );
}
