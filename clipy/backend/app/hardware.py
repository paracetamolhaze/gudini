"""GPU / execution backend detection: CUDA -> DirectML -> CPU. Never raises."""
from __future__ import annotations

import os
import shutil
import site
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from functools import lru_cache
from pathlib import Path


@dataclass
class Hardware:
    gpu_name: str = ""
    gpu_vram_mb: int = 0
    driver_version: str = ""
    backend: str = "cpu"  # cuda | directml | cpu
    execution_providers: list[str] = field(default_factory=lambda: ["cpu"])
    onnxruntime_version: str = ""
    available_providers: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def nvidia_dll_dirs() -> list[str]:
    """`bin` folders of the nvidia-* pip packages (CUDA runtime, cuBLAS, cuDNN ...)."""
    dirs: list[str] = []
    candidates: list[Path] = []
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        candidates.append(Path(sp) / "nvidia")
    for base in candidates:
        if not base.is_dir():
            continue
        for pkg in sorted(base.iterdir()):
            for sub in ("bin", "lib"):
                d = pkg / sub
                if d.is_dir() and d.as_posix() not in dirs:
                    dirs.append(str(d))
    return dirs


def engine_env() -> dict[str, str]:
    """Environment for engine subprocesses: CUDA DLLs from pip packages on PATH, no interactive prompts."""
    env = os.environ.copy()
    dll_dirs = nvidia_dll_dirs()
    if dll_dirs:
        env["PATH"] = os.pathsep.join(dll_dirs + [env.get("PATH", "")])
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env.setdefault("OMP_NUM_THREADS", str(max(1, (os.cpu_count() or 4) // 2)))
    return env


def _nvidia_smi() -> tuple[str, int, str]:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return "", 0, ""
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip().splitlines()
        if not out:
            return "", 0, ""
        name, mem, drv = [p.strip() for p in out[0].split(",")[:3]]
        return name, int(float(mem)), drv
    except Exception:
        return "", 0, ""


def _cuda_session_works() -> tuple[bool, str]:
    """Create a tiny CUDA session in a subprocess so a broken CUDA install cannot crash the server."""
    code = r"""
import sys
try:
    import numpy, onnx, onnxruntime as ort
    from onnx import helper, TensorProto
    try:
        ort.preload_dlls()
    except Exception:
        pass
    x = helper.make_tensor_value_info('x', TensorProto.FLOAT, [1, 4])
    y = helper.make_tensor_value_info('y', TensorProto.FLOAT, [1, 4])
    node = helper.make_node('Relu', ['x'], ['y'])
    graph = helper.make_graph([node], 'g', [x], [y])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)])
    model.ir_version = 8
    so = ort.SessionOptions(); so.log_severity_level = 3
    s = ort.InferenceSession(model.SerializeToString(), so, providers=['CUDAExecutionProvider'])
    if 'CUDAExecutionProvider' not in s.get_providers():
        print('NOCUDA'); sys.exit(0)
    s.run(None, {'x': numpy.ones((1, 4), dtype=numpy.float32)})
    print('OK')
except Exception as e:
    print('ERR ' + str(e)[:300])
"""
    try:
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120, env=engine_env())
        line = (r.stdout.strip().splitlines() or [""])[-1]
        if line == "OK":
            return True, ""
        return False, (line or r.stderr[-300:]).strip()
    except Exception as e:  # pragma: no cover
        return False, str(e)


@lru_cache(maxsize=1)
def detect() -> Hardware:
    hw = Hardware()
    hw.gpu_name, hw.gpu_vram_mb, hw.driver_version = _nvidia_smi()
    try:
        import onnxruntime as ort  # noqa

        hw.onnxruntime_version = ort.__version__
        hw.available_providers = list(ort.get_available_providers())
    except Exception as e:
        hw.notes.append(f"onnxruntime not importable: {e}")
        return hw

    if "CUDAExecutionProvider" in hw.available_providers and hw.gpu_name:
        ok, why = _cuda_session_works()
        if ok:
            hw.backend = "cuda"
            hw.execution_providers = ["cuda", "cpu"]
            return hw
        hw.notes.append(f"CUDA present but unusable: {why}")
    if "DmlExecutionProvider" in hw.available_providers:
        hw.backend = "directml"
        hw.execution_providers = ["directml", "cpu"]
        return hw
    hw.backend = "cpu"
    hw.execution_providers = ["cpu"]
    if not hw.gpu_name:
        hw.notes.append("No NVIDIA GPU detected")
    return hw


def has_nvenc() -> bool:
    exe = shutil.which("ffmpeg")
    if not exe:
        return False
    try:
        out = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=20).stdout
        return "h264_nvenc" in out
    except Exception:
        return False
