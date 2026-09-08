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
     "GPU_OOM", "Видеокарте не хватило памяти.", "Попробуйте режим «Обычно» или «Быстро» либо закройте другие программы, использующие видеокарту."),
    (r"CUDA|cudnn|cublas|nvcuda|LoadLibrary failed with error 126",
     "CUDA_ERROR", "Не удалось запустить обработку на видеокарте.", "Обновите драйвер NVIDIA. Если повторяется, обработка пойдёт на процессоре."),
    (r"No face|no faces? (was|were) (found|detected)|NO_FACE",
     "NO_FACE", "Лицо не найдено.", "Убедитесь, что лицо хорошо видно."),
    (r"login required|requires authentication|rate-limit reached|Login Required|not logged in|checkpoint_required",
     "AUTH_REQUIRED", "Instagram требует входа в аккаунт.", "Положите файл cookies.txt в папку данных Clipy и попробуйте снова."),
    (r"Private video|This video is private|is private",
     "PRIVATE", "Это видео закрытое, скачать его нельзя.", "Подходят только открытые ролики."),
    (r"Unsupported URL|is not a valid URL|Unable to extract|Video unavailable|HTTP Error 404|Not Found|does not exist",
     "DOWNLOAD_FAILED", "Не удалось скачать видео.", "Проверьте, что ссылка открывается в браузере и ролик открытый."),
    (r"IP address is blocked|blocked from accessing",
     "IP_BLOCKED", "Площадка заблокировала скачивание с этого адреса.", "Скачайте ролик на телефоне и загрузите файл сюда, либо попробуйте позже."),
    (r"HTTP Error 403|Forbidden|Requested format is not available",
     "DOWNLOAD_BLOCKED", "Площадка не отдала видео.", "Попробуйте позже или загрузите файл MP4 напрямую."),
    (r"ffmpeg|ffprobe",
     "FFMPEG", "Не удалось обработать видео.", "Файл может быть повреждён. Пересохраните его как MP4 (H.264)."),
    (r"No space left|disk full|ENOSPC|There is not enough space",
     "DISK_FULL", "Недостаточно места на диске.", "Освободите место и попробуйте снова."),
    (r"content analyser|content_analyser|inappropriate|nsfw",
     "CONTENT_BLOCKED", "Фильтр содержимого движка отклонил это видео.", ""),
]


def classify(raw: str) -> tuple[str, str, str]:
    """Map a raw engine/tool message to (code, message, hint)."""
    text = raw or ""
    for pattern, code, message, hint in _PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return code, message, hint
    return "PROCESSING_FAILED", "Не удалось обработать видео.", "Подробности в журнале задачи."


def friendly(exc: BaseException, fallback_code: str = "PROCESSING_FAILED") -> UserError:
    if isinstance(exc, UserError):
        return exc
    raw = str(exc)
    code, message, hint = classify(raw)
    if code == "PROCESSING_FAILED":
        code = fallback_code
    return UserError(code, message, hint, details=raw[:4000], status=500)
