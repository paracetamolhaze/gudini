"""Runs FaceFusion `headless-run` as a subprocess with quality presets, live progress and OOM retries."""
from __future__ import annotations

import os
import re
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from .. import config, ffmpeg
from ..errors import Cancelled, UserError
from ..hardware import Hardware, engine_env
from ..procs import run_streaming

Log = Callable[[str], None]
Progress = Callable[[float, str], None]

_PROGRESS_RE = re.compile(r"(\d+)\s*/\s*(\d+)")
_ERROR_RE = re.compile(r"\[FACEFUSION\.[A-Z_.]+\]\s+(.*)")


@dataclass
class Preset:
    processors: list[str]
    swapper: str
    pixel_boost: str
    enhancer: Optional[str]
    enhancer_blend: int
    mask_types: list[str]
    tracker_score: float
    frame_amount: int
    preset: str
    video_quality: int
    threads: int
    memory_strategy: str = "moderate"


# Режим один: максимальное качество. Раньше их было три, но «Быстро» давал мыльное лицо
# и прямоугольную маску поверх рук и волос, а выбор только путал.
PRESETS: dict[str, Preset] = {
    "best": Preset(["face_swapper", "face_enhancer"], "hyperswap_1a_256", "512x512", "gfpgan_1.4", 70, ["box", "occlusion", "region"], 0.15, 4, "slow", 90, 4),
}
DEFAULT_QUALITY = "best"


@dataclass
class SwapRequest:
    source_photos: list[Path]
    target_video: Path
    output_video: Path
    temp_dir: Path
    quality: str
    reference_frame: int
    reference_position: int
    reference_distance: float
    hardware: Hardware
    fps: float
    # промежуточный проход (за ним будет ещё замена): кодируем почти без потерь и быстрее
    intermediate: bool = False
    extra: dict = field(default_factory=dict)


def _pixel_boost_down(model: str, current: str) -> str:
    ladder = ["1024x1024", "768x768", "512x512", "384x384", "256x256", "128x128"]
    floor = "128x128" if model.startswith("inswapper") else "256x256"
    if current == floor or current not in ladder:
        return floor
    nxt = ladder[ladder.index(current) + 1]
    return nxt if nxt in ladder[: ladder.index(floor) + 1] else floor


def build_command(req: SwapRequest, preset: Preset, threads: int, pixel_boost: str, memory_strategy: str) -> list[str]:
    hw = req.hardware
    providers = list(hw.execution_providers)
    encoder = "libx264"
    # NVENC only on a native Windows install: WSL2/Docker containers list the encoder but cannot use it
    if req.quality == "fast" and hw.backend == "cuda" and sys.platform.startswith("win") and ffmpeg.encoder_available("h264_nvenc"):
        encoder = "h264_nvenc"
    cmd = [
        config.PYTHON, "facefusion.py", "headless-run",
        "--source-paths", *[str(p) for p in req.source_photos],
        "--target-path", str(req.target_video),
        "--output-path", str(req.output_video),
        "--processors", *preset.processors,
        "--face-swapper-model", preset.swapper,
        "--face-swapper-pixel-boost", pixel_boost,
        "--face-detector-model", "yolo_face",
        "--face-detector-size", "640x640",
        # 0.35 вместо 0.5: смазанное или полуотвёрнутое лицо тоже находится, иначе замена в этих кадрах пропадает
        "--face-detector-score", "0.35",
        "--face-landmarker-model", "2dfan4",
        "--face-landmarker-score", "0.5",
        "--face-selector-mode", "reference",
        "--face-selector-order", "left-right",
        "--reference-frame-number", str(req.reference_frame),
        "--reference-face-position", str(req.reference_position),
        "--reference-face-distance", f"{req.reference_distance:.2f}",
        "--face-tracker-score", f"{preset.tracker_score:.2f}",
        "--target-frame-amount", str(preset.frame_amount),
        "--face-mask-types", *preset.mask_types,
        "--face-occluder-model", "xseg_2",
        "--face-mask-blur", "0.3",
        "--face-mask-padding", "0", "0", "0", "0",
        "--output-video-encoder", encoder,
        "--output-video-preset", ("medium" if req.intermediate else preset.preset) if encoder == "libx264" else "fast",
        "--output-video-quality", str(95 if req.intermediate else preset.video_quality),
        "--output-audio-encoder", "aac",
        "--output-audio-quality", "90",
        "--execution-providers", *providers,
        "--execution-device-ids", "0",
        "--execution-thread-count", str(threads),
        "--video-memory-strategy", memory_strategy,
        "--workflow-strategy", "memory",
        "--temp-path", str(req.temp_dir),
        "--jobs-path", str(req.temp_dir / "ffjobs"),
        "--download-providers", "github", "huggingface",
        "--log-level", "info",
    ]
    if preset.enhancer:
        cmd += ["--face-enhancer-model", preset.enhancer, "--face-enhancer-blend", str(preset.enhancer_blend)]
    return cmd


def run_swap(req: SwapRequest, log: Log, progress: Progress, cancel: threading.Event) -> dict:
    """Returns {'attempts': n, 'pixel_boost': ..., 'threads': ...}. Raises UserError / Cancelled."""
    preset = PRESETS.get(req.quality) or PRESETS[DEFAULT_QUALITY]
    hw = req.hardware
    threads = preset.threads
    pixel_boost = preset.pixel_boost
    memory_strategy = preset.memory_strategy
    if hw.backend == "cpu":
        # без видеокарты полное разрешение прорисовки нереально: снижаем, иначе ролик считается часами
        threads = max(1, min(4, (os.cpu_count() or 4) // 2))
        pixel_boost = "256x256"
        log("CPU backend: this will be slow, pixel boost reduced to 256x256")
    elif hw.backend == "cuda" and hw.gpu_vram_mb and hw.gpu_vram_mb < 6000:
        threads = min(threads, 3)

    attempts = 0
    last_error = ""
    while True:
        attempts += 1
        if req.output_video.exists():
            req.output_video.unlink()
        cmd = build_command(req, preset, threads, pixel_boost, memory_strategy)
        log(f"facefusion attempt {attempts}: threads={threads} pixel_boost={pixel_boost} memory={memory_strategy} providers={hw.execution_providers}")
        log("cmd: " + " ".join(cmd[1:]))
        state = {"phase": "", "last": ""}

        def on_line(line: str) -> None:
            m = _PROGRESS_RE.search(line)
            low = line.lower()
            if low.startswith("analysing") and m:
                cur, tot = int(m.group(1)), int(m.group(2))
                progress(0.0, f"checking video {cur}/{tot}")
                return
            if low.startswith("processing") and m and "|" in line:
                cur, tot = int(m.group(1)), int(m.group(2))
                if tot > 0:
                    progress(min(1.0, cur / tot), f"frame {cur}/{tot}")
                return
            if low.startswith("merging") or low.startswith("extracting"):
                return
            # argparse usage dumps are hundreds of lines; keep only the actual error line
            if line.startswith("usage:") or line.startswith("[--") or line.startswith("[-") or line.startswith("{"):
                return
            state["last"] = line
            em = _ERROR_RE.match(line)
            if em or "error" in line.lower() or "Traceback" in line or "Error" in line:
                log(line[:600])
            else:
                log(line[:300])

        rc, tail = run_streaming(cmd, cwd=config.FACEFUSION_DIR, env=engine_env(), on_line=on_line, cancel=cancel)
        if rc == 0 and req.output_video.exists() and req.output_video.stat().st_size > 0:
            return {"attempts": attempts, "pixel_boost": pixel_boost, "threads": threads}
        meaningful = [t for t in tail if not (t.startswith("usage:") or t.startswith("[--") or t.startswith("[-") or t.startswith("{"))]
        joined = "\n".join(meaningful[-60:])
        last_error = joined[-3000:]
        arg_error = next((t for t in meaningful if "error: argument" in t or "error: unrecognized" in t), None)
        if arg_error:
            raise UserError("ENGINE_ARGS", "Движок замены лица отклонил настройки.", "Это ошибка Clipy, подробности в журнале задачи.", details=arg_error[:800], status=500)
        if rc == 3:
            raise UserError("CONTENT_BLOCKED", "Фильтр содержимого движка отклонил это видео.", "", details=last_error, status=422)
        if rc == 4:
            raise Cancelled()
        if rc == 124:
            raise UserError("TIMEOUT", "Обработка шла слишком долго и была остановлена.", "Возьмите ролик короче или режим «Быстро».", details=last_error, status=500)
        oom = re.search(r"out of memory|CUDA_ERROR_OUT_OF_MEMORY|CUDNN_STATUS_ALLOC_FAILED|Failed to allocate|cudaErrorMemoryAllocation|std::bad_alloc", joined, re.IGNORECASE)
        if oom and attempts < 3:
            new_threads = max(1, threads // 2)
            new_pb = _pixel_boost_down(preset.swapper, pixel_boost)
            log(f"GPU out of memory: retrying with threads={new_threads} pixel_boost={new_pb} memory=strict")
            threads, pixel_boost, memory_strategy = new_threads, new_pb, "strict"
            continue
        if re.search(r"no face|No face|face not found", joined, re.IGNORECASE):
            raise UserError("NO_FACE", "В опорном кадре не найдено лицо.", "Выберите другого человека или проверьте фото.", details=last_error, status=422)
        if oom:
            raise UserError("GPU_OOM", "Видеокарте не хватило памяти.", "Попробуйте режим «Обычно» или «Быстро» либо закройте другие программы, использующие видеокарту.", details=last_error, status=500)
        if re.search(r"CUDA|cudnn|cublas|LoadLibrary", joined, re.IGNORECASE) and hw.backend == "cuda":
            raise UserError("CUDA_ERROR", "Видеокарта дала сбой во время обработки.", "Перезапустите Clipy. Если повторяется, обновите драйвер NVIDIA.", details=last_error, status=500)
        if re.search(r"could not download|download failed|validating_hash_failed|hash.*failed|Downloading", joined, re.IGNORECASE):
            raise UserError("MODEL_DOWNLOAD", "Движок не смог скачать модели.", "Проверьте интернет и попробуйте снова.", details=last_error, status=500)
        raise UserError("ENGINE_FAILED", "Замена лица не удалась.", "Подробности в журнале задачи.", details=last_error, status=500)
