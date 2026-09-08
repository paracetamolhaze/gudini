"""Background replacement with Robust Video Matting (ONNX, recurrent -> temporally stable alpha).

video -> RVM (fgr, pha) -> composite over image/video background -> H.264 (video only; audio is muxed by the caller).
Frames are streamed through ffmpeg pipes, nothing is held in RAM beyond a few frames.
"""
from __future__ import annotations

import subprocess
import threading
import urllib.request
from pathlib import Path
from typing import Callable, Optional

import numpy

from .. import config, ffmpeg
from ..errors import Cancelled, UserError
from ..hardware import Hardware, engine_env

Log = Callable[[str], None]
Progress = Callable[[float, str], None]


def _read_exact(stream, n: int) -> bytes:
    """Pipes hand out partial chunks; keep reading until a whole frame is there (or the stream ends)."""
    parts = []
    got = 0
    while got < n:
        chunk = stream.read(n - got)
        if not chunk:
            break
        parts.append(chunk)
        got += len(chunk)
    return b"".join(parts)


def ensure_model(log: Log) -> Path:
    path = config.RVM_MODEL_PATH
    if path.is_file() and path.stat().st_size > 1_000_000:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    log(f"downloading matting model: {config.RVM_MODEL_URL}")
    tmp = path.with_suffix(".part")
    try:
        with urllib.request.urlopen(config.RVM_MODEL_URL, timeout=60) as r, tmp.open("wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        tmp.replace(path)
    except Exception as e:
        raise UserError("MODEL_DOWNLOAD", "Could not download the background matting model.", "Check the internet connection and try again.", details=str(e), status=500)
    return path


def _session(model: Path, hw: Hardware, log: Log):
    import onnxruntime as ort

    try:
        ort.preload_dlls()  # type: ignore[attr-defined]
    except Exception:
        pass
    so = ort.SessionOptions()
    so.log_severity_level = 3
    providers: list = []
    if hw.backend == "cuda":
        providers.append(("CUDAExecutionProvider", {"device_id": 0}))
    elif hw.backend == "directml":
        providers.append(("DmlExecutionProvider", {"device_id": 0}))
    providers.append("CPUExecutionProvider")
    sess = ort.InferenceSession(str(model), so, providers=providers)
    log(f"matting session providers: {sess.get_providers()}")
    return sess


def _cover_resize(img: numpy.ndarray, w: int, h: int) -> numpy.ndarray:
    """Scale + center-crop an RGB image to exactly (h, w) without distortion."""
    import cv2

    ih, iw = img.shape[:2]
    scale = max(w / iw, h / ih)
    nw, nh = max(w, int(round(iw * scale))), max(h, int(round(ih * scale)))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
    x0 = (nw - w) // 2
    y0 = (nh - h) // 2
    return numpy.ascontiguousarray(resized[y0:y0 + h, x0:x0 + w])


class _BackgroundSource:
    """Yields background frames (RGB uint8, h x w) forever: a still image or a looping video."""

    def __init__(self, path: Path, w: int, h: int, fps: float, log: Log):
        import cv2

        self.w, self.h, self.fps, self.log = w, h, fps, log
        self.path = path
        self.is_video = path.suffix.lower() in config.VIDEO_EXTENSIONS
        self.proc: Optional[subprocess.Popen] = None
        self.still: Optional[numpy.ndarray] = None
        if not self.is_video:
            data = numpy.fromfile(str(path), dtype=numpy.uint8)
            img = cv2.imdecode(data, cv2.IMREAD_COLOR)
            if img is None:
                raise UserError("BAD_BACKGROUND", "The background image could not be read.", "Use a JPEG or PNG file.")
            self.still = _cover_resize(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), w, h)
        else:
            self._open()

    def _open(self) -> None:
        # scale to cover, crop to size, constant fps, loop forever
        vf = f"scale={self.w}:{self.h}:force_original_aspect_ratio=increase,crop={self.w}:{self.h},fps={self.fps}"
        cmd = [ffmpeg.ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", str(self.path), "-an", "-vf", vf,
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, bufsize=0)

    def next(self) -> numpy.ndarray:
        if self.still is not None:
            return self.still
        assert self.proc and self.proc.stdout
        n = self.w * self.h * 3
        buf = _read_exact(self.proc.stdout, n)
        if len(buf) < n:
            raise UserError("BAD_BACKGROUND", "The background video could not be read.", "Use an MP4 file.")
        return numpy.frombuffer(buf, dtype=numpy.uint8).reshape(self.h, self.w, 3)

    def close(self) -> None:
        if self.proc:
            try:
                self.proc.kill()
            except Exception:
                pass


def replace_background(video: Path, background: Path, out_video: Path, hw: Hardware, log: Log, progress: Progress, cancel: threading.Event) -> None:
    info = ffmpeg.probe(video)
    w, h, fps = info.width, info.height, info.fps
    total = max(1, info.frames)
    model = ensure_model(log)
    sess = _session(model, hw, log)
    downsample = float(max(0.125, min(1.0, 512.0 / max(w, h))))
    log(f"matting {w}x{h} @ {fps}fps, {total} frames, downsample_ratio={downsample:.3f}")

    reader = subprocess.Popen(
        [ffmpeg.ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-i", str(video), "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, bufsize=0,
    )
    encoder = "libx264"
    enc_args = ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p"]
    writer = subprocess.Popen(
        [ffmpeg.ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(info.fps_fraction or fps),
         "-i", "-", *enc_args, "-movflags", "+faststart", str(out_video)],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, bufsize=0,
    )
    bg = _BackgroundSource(background, w, h, fps, log)
    rec = [numpy.zeros((1, 1, 1, 1), dtype=numpy.float32) for _ in range(4)]
    ratio = numpy.array([downsample], dtype=numpy.float32)
    frame_bytes = w * h * 3
    done = 0
    try:
        assert reader.stdout and writer.stdin
        while True:
            if cancel.is_set():
                raise Cancelled()
            buf = _read_exact(reader.stdout, frame_bytes)
            if len(buf) < frame_bytes:
                break
            frame = numpy.frombuffer(buf, dtype=numpy.uint8).reshape(h, w, 3)
            src = frame.astype(numpy.float32).transpose(2, 0, 1)[None] / 255.0
            fgr, pha, *rec = sess.run(None, {"src": src, "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3], "downsample_ratio": ratio})
            alpha = pha[0, 0][..., None]  # h x w x 1 in 0..1
            fg = fgr[0].transpose(1, 2, 0)  # h x w x 3 in 0..1
            bgf = bg.next().astype(numpy.float32) / 255.0
            comp = fg * alpha + bgf * (1.0 - alpha)
            out = numpy.clip(comp * 255.0 + 0.5, 0, 255).astype(numpy.uint8)
            writer.stdin.write(out.tobytes())
            done += 1
            if done % 5 == 0 or done == total:
                progress(min(1.0, done / total), f"frame {done}/{total}")
        writer.stdin.close()
        rc = writer.wait(timeout=600)
        if rc != 0:
            err = writer.stderr.read().decode("utf-8", "replace")[-1000:] if writer.stderr else ""
            raise UserError("FFMPEG", "Video encoding failed after background replacement.", "", details=err, status=500)
        if done == 0:
            raise UserError("MATTING_FAILED", "Background replacement produced no frames.", "The video could not be decoded for matting.", status=500)
        log(f"background replaced on {done} frames ({encoder})")
    except Exception:
        try:
            writer.kill()
        except Exception:
            pass
        raise
    finally:
        bg.close()
        try:
            reader.kill()
        except Exception:
            pass
        try:
            del sess
        except Exception:
            pass
