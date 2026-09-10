"""
Стенд озвучки: Chatterbox Multilingual V3 (Resemble AI) на видеокарте этого компьютера.

Отдельный контейнер, как clipy: сайту на Node не нужен ни torch, ни CUDA, а карта одна
на всех. Модель грузится лениво и выгружается по кнопке — 3060 Ti это 8 ГБ, и пока
clipy рендерит замену лица, память ей нужна целиком.

Ничего не публикует и не платит: модель локальная, генерации сколько угодно.
Каждый ответ модели помечен неслышимым водяным знаком Perth — так устроен Chatterbox.
"""

import inspect
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import torch
import torchaudio as ta
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

DATA = Path(os.environ.get("TTS_DATA_DIR", "/app/data"))
VOICES = DATA / "voices"
TAKES = DATA / "takes"
for d in (VOICES, TAKES):
    d.mkdir(parents=True, exist_ok=True)

# Образец голоса: Chatterbox читает опорный отрывок целиком, длинный только тратит время.
# Автору хватает 10–20 секунд чистой речи без музыки.
REF_SECONDS_MAX = 40
# Длинный текст модель дочитывает нестабильно (повторы, обрывы), поэтому режем по фразам.
CHUNK_CHARS = 280


# ---------------------------------------------------------------- движок

class Engine:
    """Одна модель на процесс. Замок — чтобы две генерации не делили видеопамять."""

    def __init__(self) -> None:
        self.model = None
        self.lock = threading.Lock()
        self.loading = False
        self.error: Optional[str] = None
        want = os.environ.get("TTS_DEVICE", "").strip()
        self.device = want or ("cuda" if torch.cuda.is_available() else "cpu")
        self.t3_model = os.environ.get("TTS_T3_MODEL", "v3")
        # какой чекпойнт реально загрузился: колесо с PyPI знает только старый мультиязычный,
        # V3 живёт в репозитории. Пусть стенд честно показывает, что играет
        self.loaded_model: Optional[str] = None

    def load(self):
        if self.model is not None:
            return self.model
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        self.loading = True
        self.error = None
        try:
            # t3_model появился только в релизе V3 — на старой сборке пакета его нет,
            # и передавать его вслепую значит уронить загрузку на TypeError
            supports_v3 = "t3_model" in inspect.signature(ChatterboxMultilingualTTS.from_pretrained).parameters
            kwargs = {"t3_model": self.t3_model} if supports_v3 else {}
            self.model = ChatterboxMultilingualTTS.from_pretrained(device=self.device, **kwargs)
            self.loaded_model = self.t3_model if supports_v3 else "v2 (сборка пакета без V3)"
            return self.model
        except Exception as e:  # первая загрузка тянет веса с Hugging Face — сеть может отвалиться
            self.error = f"{type(e).__name__}: {e}"
            raise
        finally:
            self.loading = False

    def unload(self):
        self.model = None
        if self.device.startswith("cuda"):
            torch.cuda.empty_cache()

    def vram(self) -> dict:
        if not self.device.startswith("cuda") or not torch.cuda.is_available():
            return {}
        free, total = torch.cuda.mem_get_info()
        return {
            "totalMb": round(total / 1024 / 1024),
            "freeMb": round(free / 1024 / 1024),
            "usedMb": round((total - free) / 1024 / 1024),
        }


engine = Engine()
app = FastAPI(title="Гудини · стенд озвучки")


# ---------------------------------------------------------------- вспомогательное

# Имена образцов пишут по-русски, а слаг уходит и в имя файла, и в путь URL.
# Кириллица там живёт только в процентных кодах и ломается на первой же пересылке
# через прокси сайта, поэтому переводим в латиницу сразу.
TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e",
    "ю": "yu", "я": "ya",
}


def slugify(name: str) -> str:
    low = (name or "").strip().lower()
    s = "".join(TRANSLIT.get(ch, ch) for ch in low)
    s = re.sub(r"[^a-z0-9-]+", "-", s).strip("-")
    return s[:40] or uuid.uuid4().hex[:8]


def split_text(text: str) -> list[str]:
    """Режем по концам предложений, короткие фразы склеиваем до CHUNK_CHARS."""
    parts = [p.strip() for p in re.split(r"(?<=[.!?…])\s+|\n+", text.strip()) if p.strip()]
    out: list[str] = []
    for p in parts:
        if out and len(out[-1]) + 1 + len(p) <= CHUNK_CHARS:
            out[-1] = f"{out[-1]} {p}"
        else:
            # одна фраза длиннее лимита — режем по запятым, иначе модель начнёт повторяться
            while len(p) > CHUNK_CHARS:
                cut = p.rfind(",", 0, CHUNK_CHARS)
                cut = cut if cut > CHUNK_CHARS // 2 else CHUNK_CHARS
                out.append(p[:cut].strip())
                p = p[cut:].strip(" ,")
            out.append(p)
    return out


def to_wav(src: Path, dst: Path, seconds: int) -> None:
    """Любой присланный файл (mp4, m4a, webm, mp3) в моно-wav 24 кГц — так ждёт модель."""
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-t", str(seconds),
         "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(dst)],
        check=True,
    )


def voice_list() -> list[dict]:
    items = []
    for f in sorted(VOICES.glob("*.wav")):
        info = ta.info(str(f))
        items.append({
            "slug": f.stem,
            "seconds": round(info.num_frames / info.sample_rate, 1),
            "sizeKb": round(f.stat().st_size / 1024),
        })
    return items


def take_list() -> list[dict]:
    items = []
    for f in sorted(TAKES.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            items.append(json.loads(f.read_text("utf-8")))
        except Exception:
            continue
    return items[:60]


# ---------------------------------------------------------------- состояние

@app.get("/health")
def health():
    return {
        "device": engine.device,
        "cuda": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "model": engine.loaded_model or engine.t3_model,
        "loaded": engine.model is not None,
        "loading": engine.loading,
        "busy": engine.lock.locked(),
        "error": engine.error,
        "vram": engine.vram(),
    }


@app.post("/load")
def load():
    with engine.lock:
        engine.load()
    return health()


@app.post("/unload")
def unload():
    with engine.lock:
        engine.unload()
    return health()


# ---------------------------------------------------------------- образцы голоса

@app.get("/voices")
def voices():
    return {"voices": voice_list()}


@app.post("/voices")
async def add_voice(file: UploadFile = File(...), name: str = Form(""), seconds: int = Form(20)):
    seconds = max(3, min(REF_SECONDS_MAX, seconds))
    slug = slugify(name or Path(file.filename or "").stem)
    tmp = DATA / f"_upload-{uuid.uuid4().hex}"
    try:
        with tmp.open("wb") as out:
            shutil.copyfileobj(file.file, out)
        try:
            to_wav(tmp, VOICES / f"{slug}.wav", seconds)
        except subprocess.CalledProcessError:
            raise HTTPException(400, "ffmpeg не разобрал файл: нужен аудио- или видеофайл со звуком")
    finally:
        tmp.unlink(missing_ok=True)
    return {"voices": voice_list(), "slug": slug}


@app.get("/voices/{slug}.wav")
def voice_file(slug: str):
    f = VOICES / f"{slugify(slug)}.wav"
    if not f.exists():
        raise HTTPException(404, "образец не найден")
    return FileResponse(f, media_type="audio/wav")


@app.delete("/voices/{slug}")
def voice_delete(slug: str):
    (VOICES / f"{slugify(slug)}.wav").unlink(missing_ok=True)
    return {"voices": voice_list()}


# ---------------------------------------------------------------- генерация

class SpeakRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    language_id: str = "ru"
    exaggeration: float = 0.5
    cfg_weight: float = 0.5
    temperature: float = 0.8
    seed: Optional[int] = None
    note: str = ""


@app.post("/speak")
def speak(req: SpeakRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "пустой текст")
    chunks = split_text(text)

    prompt: Optional[str] = None
    if req.voice:
        f = VOICES / f"{slugify(req.voice)}.wav"
        if not f.exists():
            raise HTTPException(400, f"образец «{req.voice}» не найден")
        prompt = str(f)

    if engine.lock.locked():
        raise HTTPException(409, "карта занята: идёт загрузка модели или другая генерация")

    with engine.lock:
        model = engine.load()
        # состав параметров у Chatterbox меняется между версиями — отдаём только то,
        # что модель действительно принимает, иначе обновление пакета уронит стенд
        allowed = set(inspect.signature(model.generate).parameters)
        kwargs = {
            k: v for k, v in {
                "language_id": req.language_id,
                "audio_prompt_path": prompt,
                "exaggeration": req.exaggeration,
                "cfg_weight": req.cfg_weight,
                "temperature": req.temperature,
            }.items() if k in allowed and v is not None
        }
        if req.seed is not None:
            torch.manual_seed(req.seed)

        started = time.time()
        pieces = []
        gap = torch.zeros(1, int(model.sr * 0.25))
        for i, chunk in enumerate(chunks):
            wav = model.generate(chunk, **kwargs).detach().cpu()
            if wav.dim() == 1:
                wav = wav.unsqueeze(0)
            if i:
                pieces.append(gap)
            pieces.append(wav)
        audio = torch.cat(pieces, dim=-1)
        elapsed = round(time.time() - started, 1)

    take_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    ta.save(str(TAKES / f"{take_id}.wav"), audio, model.sr)
    meta = {
        "id": take_id,
        "text": text,
        "chars": len(text),
        "chunks": len(chunks),
        "voice": req.voice,
        "language_id": req.language_id,
        "exaggeration": req.exaggeration,
        "cfg_weight": req.cfg_weight,
        "temperature": req.temperature,
        "seed": req.seed,
        "note": req.note,
        "seconds": round(audio.shape[-1] / model.sr, 1),
        "elapsedSec": elapsed,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    (TAKES / f"{take_id}.json").write_text(json.dumps(meta, ensure_ascii=False), "utf-8")
    return JSONResponse(meta)


@app.get("/takes")
def takes():
    return {"takes": take_list()}


@app.get("/takes/{take_id}.wav")
def take_file(take_id: str):
    f = TAKES / f"{slugify(take_id)}.wav"
    if not f.exists():
        raise HTTPException(404, "дубль не найден")
    return FileResponse(f, media_type="audio/wav")


@app.delete("/takes/{take_id}")
def take_delete(take_id: str):
    slug = slugify(take_id)
    (TAKES / f"{slug}.wav").unlink(missing_ok=True)
    (TAKES / f"{slug}.json").unlink(missing_ok=True)
    return {"takes": take_list()}
