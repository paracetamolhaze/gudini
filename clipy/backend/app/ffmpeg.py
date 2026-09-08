"""FFmpeg / ffprobe helpers. Keeps aspect ratio, fps and audio; re-encodes only when needed."""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, asdict
from fractions import Fraction
from pathlib import Path
from typing import Callable, Optional

from .errors import UserError

Log = Callable[[str], None]


def ffmpeg_exe() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise UserError("FFMPEG_MISSING", "FFmpeg не установлен.", "Пересоберите Clipy или установите FFmpeg.", status=500)
    return exe


def ffprobe_exe() -> str:
    exe = shutil.which("ffprobe")
    if not exe:
        raise UserError("FFMPEG_MISSING", "ffprobe не установлен.", "Пересоберите Clipy или установите FFmpeg.", status=500)
    return exe


@dataclass
class VideoInfo:
    width: int
    height: int
    fps: float
    fps_fraction: str
    duration: float
    frames: int
    video_codec: str
    pix_fmt: str
    has_audio: bool
    audio_codec: str
    container: str
    bit_rate: int
    rotation: int

    def to_dict(self) -> dict:
        return asdict(self)


def probe(path: Path) -> VideoInfo:
    cmd = [ffprobe_exe(), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0 or not r.stdout:
        raise UserError("CORRUPTED_VIDEO", "Не удалось прочитать видеофайл.", "Возможно, он повреждён или это не видео. Пересохраните его как MP4.", details=r.stderr[-1000:])
    data = json.loads(r.stdout)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not video:
        raise UserError("CORRUPTED_VIDEO", "В файле нет видеодорожки.", "Загрузите видео MP4, MOV или WebM.")
    fmt = data.get("format", {})

    def frac(s: str) -> float:
        try:
            return float(Fraction(s)) if s and s != "0/0" else 0.0
        except (ZeroDivisionError, ValueError):
            return 0.0

    fps = frac(video.get("avg_frame_rate", "")) or frac(video.get("r_frame_rate", "")) or 30.0
    fps_fraction = video.get("avg_frame_rate") if frac(video.get("avg_frame_rate", "")) else video.get("r_frame_rate", "30/1")
    duration = float(video.get("duration") or fmt.get("duration") or 0.0)
    frames = int(video.get("nb_frames") or 0) or int(round(duration * fps))
    rotation = 0
    for sd in video.get("side_data_list", []) or []:
        if "rotation" in sd:
            try:
                rotation = int(sd["rotation"])
            except (TypeError, ValueError):
                pass
    if not rotation:
        try:
            rotation = int(video.get("tags", {}).get("rotate", 0))
        except (TypeError, ValueError):
            rotation = 0
    width, height = int(video.get("width", 0)), int(video.get("height", 0))
    if rotation in (90, -90, 270, -270):
        width, height = height, width
    return VideoInfo(
        width=width,
        height=height,
        fps=round(fps, 3),
        fps_fraction=fps_fraction,
        duration=round(duration, 3),
        frames=frames,
        video_codec=video.get("codec_name", ""),
        pix_fmt=video.get("pix_fmt", ""),
        has_audio=audio is not None,
        audio_codec=(audio or {}).get("codec_name", ""),
        container=fmt.get("format_name", ""),
        bit_rate=int(fmt.get("bit_rate") or 0),
        rotation=rotation,
    )


def _run(cmd: list[str], log: Optional[Log] = None, timeout: int = 3600) -> None:
    if log:
        log("ffmpeg " + " ".join(cmd[1:]))
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        tail = (r.stderr or "")[-1500:]
        if log:
            log(tail)
        raise UserError("FFMPEG", "Не удалось обработать видео.", "Файл может быть повреждён. Пересохраните его как MP4 (H.264).", details=tail, status=500)


def normalize(src: Path, dst: Path, info: VideoInfo, log: Optional[Log] = None) -> VideoInfo:
    """Produce an MP4 the engine reads reliably: H.264 yuv420p, constant fps, rotation baked in, even dimensions.
    Copies the streams when they already qualify (no quality loss)."""
    copy_video = (
        info.video_codec in ("h264",)
        and info.pix_fmt == "yuv420p"
        and info.rotation == 0
        and info.width % 2 == 0
        and info.height % 2 == 0
        and "mp4" in info.container
    )
    copy_audio = info.audio_codec in ("aac", "mp3") if info.has_audio else True
    cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-i", str(src)]
    if copy_video:
        cmd += ["-c:v", "copy"]
    else:
        # scale to even size without changing the aspect ratio; rotation metadata is applied by ffmpeg automatically
        cmd += ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-r", info.fps_fraction or str(info.fps), "-fps_mode", "cfr",
                "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p"]
    if info.has_audio:
        cmd += ["-c:a", "copy"] if copy_audio else ["-c:a", "aac", "-b:a", "192k"]
    else:
        cmd += ["-an"]
    cmd += ["-map", "0:v:0"] + (["-map", "0:a:0"] if info.has_audio else []) + ["-movflags", "+faststart", str(dst)]
    _run(cmd, log)
    return probe(dst)


def extract_frame(video: Path, frame_index: int, fps: float, dst: Path) -> None:
    t = max(0.0, frame_index / fps) if fps else 0.0
    cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1", "-q:v", "3", str(dst)]
    _run(cmd)


def poster(video: Path, dst: Path, seconds: float = 0.5) -> None:
    cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{seconds:.3f}", "-i", str(video), "-frames:v", "1",
           "-vf", "scale='min(540,iw)':-2", "-q:v", "4", str(dst)]
    _run(cmd)


def mux_audio(video_only: Path, audio_source: Path, dst: Path, has_audio: bool, log: Optional[Log] = None) -> None:
    """Attach the original audio track to a freshly rendered video without re-encoding the video."""
    cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-i", str(video_only)]
    if has_audio:
        cmd += ["-i", str(audio_source), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest"]
    else:
        cmd += ["-c:v", "copy", "-an"]
    cmd += ["-movflags", "+faststart", str(dst)]
    _run(cmd, log)


def encoder_available(name: str) -> bool:
    try:
        out = subprocess.run([ffmpeg_exe(), "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=20).stdout
        return f" {name} " in out
    except Exception:
        return False


def version() -> str:
    try:
        out = subprocess.run([ffmpeg_exe(), "-version"], capture_output=True, text=True, timeout=20).stdout
        return out.splitlines()[0].split(" Copyright")[0].replace("ffmpeg version ", "") if out else ""
    except Exception:
        return ""
