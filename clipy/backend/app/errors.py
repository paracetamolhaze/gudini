"""User-facing errors. The UI shows `message` (+ `hint`); the raw cause goes to the job log only."""
from __future__ import annotations

import re


class UserError(Exception):
    def __init__(self, code: str, message: str, hint: str = "", details: str = "", status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.details = details
        self.status = status

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "hint": self.hint}


class Cancelled(Exception):
    """Raised inside the pipeline when the job was cancelled."""


# ordered: first match wins
_PATTERNS: list[tuple[str, str, str, str]] = [
    (r"out of memory|CUDA_ERROR_OUT_OF_MEMORY|CUDNN_STATUS_ALLOC_FAILED|cudaErrorMemoryAllocation|Failed to allocate memory",
     "GPU_OOM", "GPU ran out of memory.", "Try Balanced or Fast mode, or close other GPU applications."),
    (r"CUDA|cudnn|cublas|nvcuda|LoadLibrary failed with error 126",
     "CUDA_ERROR", "The GPU backend failed to start.", "The app will fall back to CPU on the next run. Update the NVIDIA driver if this keeps happening."),
    (r"No face|no faces? (was|were) (found|detected)|NO_FACE",
     "NO_FACE", "No face was found.", "Make sure the face is clearly visible."),
    (r"login required|requires authentication|rate-limit reached|Login Required|not logged in|checkpoint_required",
     "AUTH_REQUIRED", "Instagram requires authentication.", "Put your cookies.txt into clipy/data and try again."),
    (r"Private video|This video is private|is private",
     "PRIVATE", "This video is private and cannot be downloaded.", "Only public videos are supported."),
    (r"Unsupported URL|is not a valid URL|Unable to extract|Video unavailable|HTTP Error 404|Not Found|does not exist",
     "DOWNLOAD_FAILED", "Could not download this video.", "Check that the link opens in a browser and is public."),
    (r"HTTP Error 403|Forbidden|Requested format is not available",
     "DOWNLOAD_BLOCKED", "The platform blocked the download.", "Try again later or upload the MP4 directly."),
    (r"ffmpeg|ffprobe",
     "FFMPEG", "Video processing failed.", "The file may be corrupted. Try re-exporting it as MP4 (H.264)."),
    (r"No space left|disk full|ENOSPC|There is not enough space",
     "DISK_FULL", "Not enough disk space.", "Free some space on the drive and try again."),
    (r"content analyser|content_analyser|inappropriate|nsfw",
     "CONTENT_BLOCKED", "The engine's content filter rejected this video.", ""),
]


def classify(raw: str) -> tuple[str, str, str]:
    """Map a raw engine/tool message to (code, message, hint)."""
    text = raw or ""
    for pattern, code, message, hint in _PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return code, message, hint
    return "PROCESSING_FAILED", "Could not process video.", "See the job log for details."


def friendly(exc: BaseException, fallback_code: str = "PROCESSING_FAILED") -> UserError:
    if isinstance(exc, UserError):
        return exc
    raw = str(exc)
    code, message, hint = classify(raw)
    if code == "PROCESSING_FAILED":
        code = fallback_code
    return UserError(code, message, hint, details=raw[:4000], status=500)
