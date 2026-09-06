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

export type PortraitCapture = { stream: MediaStream; isLive: () => boolean; dispose: () => void };

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
  const useVideoFrames = typeof video.requestVideoFrameCallback === "function";
  const draw = () => {
    const crop = portraitCrop(video.videoWidth, video.videoHeight);
    // No CSS mirroring: these exact, unmirrored pixels are shown and recorded.
    context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  };
  draw(); // Fail before enabling Record if the first frame cannot be drawn.
  const stream = canvas.captureStream(PORTRAIT_FRAME.fps);
  source.getAudioTracks().forEach((track) => stream.addTrack(track));
  const tick = (now: number) => {
    if (disposed) return;
    try {
      if (video.readyState >= 2 && (useVideoFrames || now - last >= 1000 / PORTRAIT_FRAME.fps - 1)) {
        draw();
        last = now;
      }
      callback = useVideoFrames ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    } catch (error) {
      disposed = true;
      stream.getVideoTracks().forEach((track) => track.stop());
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  callback = useVideoFrames ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  return {
    stream,
    isLive: () => !disposed && [...source.getTracks(), ...stream.getTracks()].every((track) => track.readyState === "live" && !track.muted),
    dispose() {
      disposed = true;
      if (useVideoFrames) video.cancelVideoFrameCallback(callback);
      else cancelAnimationFrame(callback);
      // The owner releases camera + microphone; only this track belongs to us.
      stream.getVideoTracks().forEach((track) => track.stop());
    },
  };
}
