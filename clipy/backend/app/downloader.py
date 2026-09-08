"""Download TikTok / Reels / Shorts with yt-dlp. Public videos only; cookies.txt is optional for Instagram."""
from __future__ import annotations

import os
import re
import threading
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlparse

from . import config
from .errors import UserError, classify

Log = Callable[[str], None]
Progress = Callable[[float, str], None]

_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def validate_url(url: str) -> str:
    url = (url or "").strip()
    if not _URL_RE.match(url) or len(url) > 2048 or any(c.isspace() for c in url):
        raise UserError("BAD_URL", "This is not a valid link.", "Paste a TikTok, Instagram Reels or YouTube Shorts link that starts with https://")
    host = (urlparse(url).hostname or "").lower()
    if not any(host == h or host.endswith("." + h) for h in config.ALLOWED_URL_HOSTS):
        raise UserError("UNSUPPORTED_HOST", "Only TikTok, Instagram and YouTube links are supported.", "Or upload the MP4 file directly.")
    return url


def cookies_status() -> dict:
    f = config.COOKIES_FILE
    return {"present": f.is_file() and f.stat().st_size > 0, "path": str(f)}


def download(url: str, dest_dir: Path, log: Log, progress: Optional[Progress] = None, cancel: Optional[threading.Event] = None) -> Path:
    try:
        import yt_dlp  # type: ignore
    except ImportError as e:  # pragma: no cover
        raise UserError("YTDLP_MISSING", "yt-dlp is not installed.", "Run setup.bat again.", details=str(e), status=500)

    dest_dir.mkdir(parents=True, exist_ok=True)
    out_tmpl = str(dest_dir / "source.%(ext)s")

    def hook(d: dict) -> None:
        if cancel is not None and cancel.is_set():
            raise yt_dlp.utils.DownloadCancelled()
        if d.get("status") == "downloading" and progress:
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            frac = (done / total) if total else 0.0
            progress(min(0.99, frac), f"{done // 1024 // 1024} MB")
        elif d.get("status") == "finished" and progress:
            progress(1.0, "download finished")

    class _Logger:
        def debug(self, msg: str) -> None:
            if msg.startswith("[download]") and "%" in msg:
                return
            log(msg)

        def info(self, msg: str) -> None:
            log(msg)

        def warning(self, msg: str) -> None:
            log("warning: " + msg)

        def error(self, msg: str) -> None:
            log("error: " + msg)

    opts: dict = {
        "outtmpl": out_tmpl,
        # prefer H.264 mp4 up to 1080p (no re-encode needed), then any mp4, then the best single file
        "format": "bv*[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a]/bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/bv*+ba/b",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": False,
        "logger": _Logger(),
        "progress_hooks": [hook],
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 30,
        "restrictfilenames": True,
        "overwrites": True,
        "max_filesize": config.MAX_VIDEO_BYTES,
        "http_headers": {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"},
    }
    if config.COOKIES_FILE.is_file() and config.COOKIES_FILE.stat().st_size > 0:
        opts["cookiefile"] = str(config.COOKIES_FILE)
        log("using cookies.txt")
    browser = os.environ.get("CLIPY_COOKIES_FROM_BROWSER", "").strip()
    if browser and "cookiefile" not in opts:
        # optional: CLIPY_COOKIES_FROM_BROWSER=chrome / firefox / edge (yt-dlp reads the local profile)
        opts["cookiesfrombrowser"] = (browser,)
        log(f"using cookies from browser: {browser}")

    log(f"yt-dlp: {url}")
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if info is None:
                raise UserError("DOWNLOAD_FAILED", "Could not download this video.", "Check that the link opens in a browser and is public.")
            duration = info.get("duration")
            if duration and duration > config.MAX_VIDEO_SECONDS:
                raise UserError("TOO_LONG", f"The video is longer than {int(config.MAX_VIDEO_SECONDS // 60)} minutes.", "Use a shorter clip.")
            title = info.get("title") or ""
            uploader = info.get("uploader") or info.get("channel") or ""
            log(f"downloaded: {title!r} by {uploader!r}")
    except yt_dlp.utils.DownloadCancelled:
        raise
    except UserError:
        raise
    except Exception as e:
        raw = str(e)
        code, message, hint = classify(raw)
        if code == "PROCESSING_FAILED":
            code, message, hint = "DOWNLOAD_FAILED", "Could not download this video.", "Check that the link opens in a browser and is public."
        if code == "AUTH_REQUIRED" and "instagram" in url.lower():
            hint = "Export your Instagram cookies to clipy/data/cookies.txt (Netscape format) and try again."
        raise UserError(code, message, hint, details=raw[:2000])

    files = sorted(dest_dir.glob("source.*"), key=lambda p: p.stat().st_size, reverse=True)
    files = [f for f in files if f.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov", ".m4v")]
    if not files:
        raise UserError("DOWNLOAD_FAILED", "The download finished but no video file was produced.", "Try again or upload the MP4 directly.")
    return files[0]


def ytdlp_version() -> str:
    try:
        import yt_dlp  # type: ignore

        return yt_dlp.version.__version__
    except Exception:
        return ""
