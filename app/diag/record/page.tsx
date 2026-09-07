"use client";

import { useRef, useState } from "react";

/**
 * Диагностика записи с камеры в браузере. Ничего не загружает и не платит:
 * несколько коротких записей подряд с разными настройками, по каждой — сколько
 * секунд кодировщик реально писал видео (размер кусков по секундам: живое видео
 * 1080p — сотни килобайт в секунду, мёртвое — только звук, ~25 КБ).
 *
 * Появилась после двух дублей с iPhone, где Safari через 8 и 13 секунд переставал
 * писать видео, а звук шёл до конца. Отчёт копируется и присылается разработчику.
 */

type Scenario = {
  name: string;
  video: MediaTrackConstraints;
  bitrate?: number;
  preview: boolean;
  analyser: boolean;
};

const CAM = (w: number, h: number): MediaTrackConstraints => ({
  facingMode: "user",
  width: { ideal: w },
  height: { ideal: h },
  frameRate: { ideal: 30, max: 30 },
});

const SCENARIOS: Scenario[] = [
  { name: "как в телесуфлёре: 1080p, 12 Мбит/с, превью, анализатор звука", video: CAM(1920, 1080), bitrate: 12_000_000, preview: true, analyser: true },
  { name: "без заданного битрейта", video: CAM(1920, 1080), preview: true, analyser: true },
  { name: "720p, 6 Мбит/с", video: CAM(1280, 720), bitrate: 6_000_000, preview: true, analyser: true },
  { name: "без превью (дорожка только в рекордер)", video: CAM(1920, 1080), bitrate: 12_000_000, preview: false, analyser: true },
  { name: "без анализатора звука", video: CAM(1920, 1080), bitrate: 12_000_000, preview: true, analyser: false },
];

type Result = {
  name: string;
  mime: string;
  track: string;
  chunksKB: number[];
  videoAliveSec: number;
  diedAtSec: number | null;
  previewFrames: number;
  error?: string;
};

const SECONDS = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function judge(chunksKB: number[]): { alive: number; diedAt: number | null } {
  // первый кусок содержит заголовок; живое видео — от ~100 КБ/с, мёртвое — десятки
  let alive = 0;
  let diedAt: number | null = null;
  let seenAlive = false;
  chunksKB.forEach((kb, i) => {
    if (kb >= 100) {
      alive++;
      seenAlive = true;
    } else if (seenAlive && diedAt === null) {
      diedAt = i;
    }
  });
  return { alive, diedAt };
}

export default function RecordDiagnostics() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [results, setResults] = useState<Result[]>([]);

  async function runScenario(sc: Scenario, index: number): Promise<Result> {
    const base: Result = { name: sc.name, mime: "", track: "", chunksKB: [], videoAliveSec: 0, diedAtSec: null, previewFrames: 0 };
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    const video = videoRef.current;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: sc.video,
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
      const st = stream.getVideoTracks()[0]?.getSettings() ?? {};
      base.track = `${st.width ?? "?"}×${st.height ?? "?"} @${st.frameRate ?? "?"}`;
      let frames = 0;
      if (sc.preview && video) {
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play().catch(() => {});
        if (typeof video.requestVideoFrameCallback === "function") {
          const cb = () => {
            frames++;
            if (video.srcObject) video.requestVideoFrameCallback(cb);
          };
          video.requestVideoFrameCallback(cb);
        }
      }
      if (sc.analyser) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AC) {
          ctx = new AC();
          const an = ctx.createAnalyser();
          ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(an);
          await ctx.resume().catch(() => {});
        }
      }
      const mime = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
      if (!mime) throw new Error("MediaRecorder не поддерживает mp4/webm");
      base.mime = mime;
      const rec = new MediaRecorder(stream, {
        mimeType: mime,
        ...(sc.bitrate ? { videoBitsPerSecond: sc.bitrate } : {}),
        audioBitsPerSecond: 192_000,
      });
      const sizes: number[] = [];
      rec.ondataavailable = (e) => sizes.push(Math.round(e.data.size / 1024));
      rec.start(1000);
      for (let s = 1; s <= SECONDS; s++) {
        await sleep(1000);
        setStatus(`Сценарий ${index + 1}/${SCENARIOS.length}: ${sc.name} — ${s} с, кусков ${sizes.length}, последний ${sizes[sizes.length - 1] ?? 0} КБ`);
      }
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.stop();
      });
      base.chunksKB = sizes;
      const j = judge(sizes);
      base.videoAliveSec = j.alive;
      base.diedAtSec = j.diedAt;
      base.previewFrames = frames;
      return base;
    } catch (e) {
      return { ...base, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
      void ctx?.close().catch(() => {});
    }
  }

  async function run() {
    setRunning(true);
    setResults([]);
    const out: Result[] = [];
    for (const [i, sc] of SCENARIOS.entries()) {
      const r = await runScenario(sc, i);
      out.push(r);
      setResults([...out]);
      await sleep(800);
    }
    setStatus("Готово. Скопируйте отчёт и пришлите разработчику.");
    setRunning(false);
  }

  const report = JSON.stringify(
    {
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      seconds: SECONDS,
      results: results.map((r) => ({ ...r, chunksKB: r.chunksKB.join(" ") })),
    },
    null,
    2,
  );

  return (
    <main className="container" style={{ maxWidth: 820 }}>
      <h1>Диагностика записи</h1>
      <p className="hint">
        Пять коротких записей по {SECONDS} секунд с разными настройками. Ничего не загружается и не оплачивается.
        Держите телефон как при съёмке и говорите, чтобы был звук. Экран не гасите.
      </p>
      <video ref={videoRef} muted playsInline style={{ width: 160, aspectRatio: "9 / 16", background: "#000", borderRadius: 8 }} />
      <div style={{ margin: "12px 0" }}>
        <button className="btn" disabled={running} onClick={run}>{running ? "Идёт диагностика…" : "▶ Запустить диагностику"}</button>
      </div>
      {status && <p className="hint" role="status">{status}</p>}
      {results.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 6 }}>Сценарий</th>
                <th style={{ padding: 6 }}>Дорожка</th>
                <th style={{ padding: 6 }}>Видео жило, с</th>
                <th style={{ padding: 6 }}>Умерло на, с</th>
                <th style={{ padding: 6 }}>Кадров превью</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.name} style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
                  <td style={{ padding: 6 }}>{r.name}{r.error ? ` — ошибка: ${r.error}` : ""}</td>
                  <td style={{ padding: 6, textAlign: "center" }}>{r.track}</td>
                  <td style={{ padding: 6, textAlign: "center", color: r.videoAliveSec >= SECONDS - 1 ? "#7ee787" : "#f87171" }}>{r.videoAliveSec}</td>
                  <td style={{ padding: 6, textAlign: "center" }}>{r.diedAtSec ?? "—"}</td>
                  <td style={{ padding: 6, textAlign: "center" }}>{r.previewFrames}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {results.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard?.writeText(report).catch(() => {})}>Скопировать отчёт</button>
          <textarea readOnly value={report} style={{ width: "100%", height: 200, marginTop: 8, fontSize: 11, fontFamily: "monospace" }} />
        </div>
      )}
    </main>
  );
}
