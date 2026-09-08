"""Paths, limits and constants for the Clipy backend. Everything lives under clipy/."""
from __future__ import annotations

import os
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
ROOT_DIR = BACKEND_DIR.parent  # clipy/
ENGINES_DIR = ROOT_DIR / "engines"
FACEFUSION_DIR = ENGINES_DIR / "facefusion"
DATA_DIR = Path(os.environ.get("CLIPY_DATA_DIR", ROOT_DIR / "data"))
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"

# data layout
FACES_DIR = DATA_DIR / "faces"
IDENTITIES_DIR = DATA_DIR / "identities"
DOWNLOADS_DIR = DATA_DIR / "downloads"
SOURCES_DIR = DATA_DIR / "sources"
JOBS_DIR = DATA_DIR / "jobs"
OUTPUTS_DIR = DATA_DIR / "outputs"
TEMP_DIR = DATA_DIR / "temp"
MODELS_DIR = DATA_DIR / "models"
LOGS_DIR = DATA_DIR / "logs"
UPLOADS_DIR = DATA_DIR / "uploads"
BACKGROUNDS_DIR = DATA_DIR / "backgrounds"
COOKIES_FILE = DATA_DIR / "cookies.txt"

ALL_DIRS = [FACES_DIR, IDENTITIES_DIR, DOWNLOADS_DIR, SOURCES_DIR, JOBS_DIR, OUTPUTS_DIR, TEMP_DIR, MODELS_DIR, LOGS_DIR, UPLOADS_DIR, BACKGROUNDS_DIR]

# served under this prefix so it can sit next to other apps behind one reverse proxy
URL_PREFIX = os.environ.get("CLIPY_URL_PREFIX", "/clipy").rstrip("/")
HOST = os.environ.get("CLIPY_HOST", "127.0.0.1")
PORT = int(os.environ.get("CLIPY_PORT", "8500"))
# optional: password for non-local clients (behind a reverse proxy). Loaded from clipy/.env too.
PASSWORD = os.environ.get("CLIPY_PASSWORD", "").strip()


def _load_dotenv() -> None:
    """clipy/.env: KEY=VALUE lines, applied only when the variable is not already set."""
    global PASSWORD
    f = ROOT_DIR / ".env"
    if not f.is_file():
        return
    for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v
    PASSWORD = os.environ.get("CLIPY_PASSWORD", "").strip()


_load_dotenv()

# limits
MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB
MAX_IMAGE_BYTES = 30 * 1024 * 1024
MAX_VIDEO_SECONDS = float(os.environ.get("CLIPY_MAX_VIDEO_SECONDS", "600"))
VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".m4v", ".mkv"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
BACKGROUND_EXTENSIONS = VIDEO_EXTENSIONS | IMAGE_EXTENSIONS

# yt-dlp: only these hosts are accepted for URL sources
ALLOWED_URL_HOSTS = (
    "tiktok.com",
    "vm.tiktok.com",
    "vt.tiktok.com",
    "instagram.com",
    "instagr.am",
    "youtube.com",
    "youtu.be",
)

# python interpreter used for engine subprocesses (the venv this server runs in)
PYTHON = sys.executable

# Robust Video Matting (background replacement)
RVM_MODEL_URL = "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx"
RVM_MODEL_PATH = MODELS_DIR / "rvm_mobilenetv3_fp32.onnx"

ENGINE_VERSION = "3.9.0"


def ensure_dirs() -> None:
    for d in ALL_DIRS:
        d.mkdir(parents=True, exist_ok=True)
