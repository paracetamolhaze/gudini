/** The visible canvas is also the recording source: no second preview crop. */
export const PORTRAIT_FRAME = { width: 1080, height: 1920, fps: 30 } as const;

export function portraitCrop(width: number, height: number) {
  if (!(width > 0 && height > 0)) throw new Error("Размер кадра камеры не определён");
  const ratio = PORTRAIT_FRAME.width / PORTRAIT_FRAME.height;
  const w = Math.min(width, height * ratio);
  const h = Math.min(height, width / ratio);
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

/** Wait for a decoded frame, not just sensor settings or metadata. */
export function attachCamera(video: HTMLVideoElement, stream: MediaStream, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const events = ["loadeddata", "canplay", "playing", "resize"];
    const finish = (error?: Error) => {
      clearTimeout(timer);
      events.forEach((event) => video.removeEventListener(event, check));
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) finish();
    };
    const abort = () => finish(new DOMException("Камера закрыта", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Камера не передала изображение. Откройте её заново.")), 8000);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    events.forEach((event) => video.addEventListener(event, check));
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    void video.play().then(check, (error: Error) => finish(error));
  });
}

export type PortraitCapture = {
  stream: MediaStream;
  isLive: () => boolean;
  /** Кадров нарисовано за последнюю секунду: 0 — камера не отдаёт кадры. */
  fps: () => number;
  dispose: () => void;
};

/** Если кадры камеры не приходят дольше этого, камера считается остановившейся (запись прерывается). */
export const FRAME_STALL_MS = 3000;

export type CaptureHealth = { stalled: boolean; switchToRaf: boolean };

/**
 * Решение сторожа. Кадром камеры считается только НОВЫЙ кадр (вызов
 * requestVideoFrameCallback или рост currentTime), а не перерисовка холста:
 * холст, рисующий один и тот же застывший кадр, исправности камеры не подтверждает.
 */
export function captureHealth(
  now: number,
  s: { lastCameraFrameAt: number; lastTickAt: number; useVideoFrames: boolean },
  stallMs = FRAME_STALL_MS,
  fps: number = PORTRAIT_FRAME.fps,
): CaptureHealth {
  return {
    stalled: now - s.lastCameraFrameAt > stallMs,
    switchToRaf: s.useVideoFrames && now - s.lastTickAt > (1000 / fps) * 4,
  };
}

export function createPortraitCapture(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  source: MediaStream,
  onError: (error: Error) => void,
): PortraitCapture {
  if (typeof canvas.captureStream !== "function") throw new Error("Этот браузер не поддерживает запись кадра 9:16.");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Не удалось подготовить кадр записи");
  canvas.width = PORTRAIT_FRAME.width;
  canvas.height = PORTRAIT_FRAME.height;
  let disposed = false;
  let callback = 0;
  let last = -Infinity;
  // Safari на iPhone перестал отдавать кадры через 8 с записи (в файле 255 кадров при
  // 87 с звука). Что именно замолчало — requestVideoFrameCallback, поток камеры или
  // захват холста — журналы не показывают, поэтому сторож считает только НОВЫЕ кадры
  // камеры: rVFC вызывается на каждый новый кадр, без rVFC растёт currentTime.
  // Если rVFC замолчал, а поток жив — цикл насовсем переводится на requestAnimationFrame.
  // Если новых кадров нет FRAME_STALL_MS — захват останавливается с ошибкой, и
  // телесуфлёр сохраняет записанную часть, а не пишет звук без видео.
  let useVideoFrames = typeof video.requestVideoFrameCallback === "function";
  let lastCameraFrameAt = performance.now();
  let lastTickAt = performance.now();
  let lastMediaTime = video.currentTime;
  const cameraFrames: number[] = [];
  const noteCameraFrame = (now: number) => {
    lastCameraFrameAt = now;
    cameraFrames.push(now);
    while (cameraFrames.length && cameraFrames[0] < now - 1000) cameraFrames.shift();
  };
  const draw = () => {
    const crop = portraitCrop(video.videoWidth, video.videoHeight);
    // No CSS mirroring: these exact, unmirrored pixels are shown and recorded.
    context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  };
  draw(); // Fail before enabling Record if the first frame cannot be drawn.
  const stream = canvas.captureStream(PORTRAIT_FRAME.fps);
  source.getAudioTracks().forEach((track) => stream.addTrack(track));
  const fail = (error: unknown) => {
    if (disposed) return;
    disposed = true;
    clearInterval(watchdog);
    stream.getVideoTracks().forEach((track) => track.stop());
    onError(error instanceof Error ? error : new Error(String(error)));
  };
  const schedule = () => {
    callback = useVideoFrames ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  };
  const tick = (now: number, metadata?: VideoFrameCallbackMetadata) => {
    if (disposed) return;
    try {
      lastTickAt = now;
      const t = video.currentTime;
      if (metadata || t !== lastMediaTime) {
        lastMediaTime = t;
        noteCameraFrame(now);
      }
      if (video.readyState >= 2 && (useVideoFrames || now - last >= 1000 / PORTRAIT_FRAME.fps - 1)) {
        draw();
        last = now;
      }
      schedule();
    } catch (error) {
      fail(error);
    }
  };
  schedule();
  const watchdog = setInterval(() => {
    if (disposed) return;
    try {
      const now = performance.now();
      if (video.paused && !video.ended) void video.play().catch(() => {});
      const t = video.currentTime;
      if (t !== lastMediaTime) {
        lastMediaTime = t;
        noteCameraFrame(now);
      }
      const health = captureHealth(now, { lastCameraFrameAt, lastTickAt, useVideoFrames });
      if (health.switchToRaf) {
        video.cancelVideoFrameCallback(callback);
        useVideoFrames = false;
        schedule();
      }
      if (health.stalled) {
        fail(new Error("Камера перестала отдавать кадры. Запись остановлена — проверьте дубль или откройте камеру заново."));
      }
    } catch (error) {
      fail(error);
    }
  }, 100);
  return {
    stream,
    isLive: () => !disposed && [...source.getTracks(), ...stream.getTracks()].every((track) => track.readyState === "live" && !track.muted),
    fps: () => (disposed ? 0 : cameraFrames.filter((t) => t >= performance.now() - 1000).length),
    dispose() {
      disposed = true;
      clearInterval(watchdog);
      if (useVideoFrames) video.cancelVideoFrameCallback(callback);
      else cancelAnimationFrame(callback);
      // The owner releases camera + microphone; only this track belongs to us.
      stream.getVideoTracks().forEach((track) => track.stop());
    },
  };
}
