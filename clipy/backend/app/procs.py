"""Subprocess runner with live output parsing, cancellation and process-tree kill."""
from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from .errors import Cancelled

LineHandler = Callable[[str], None]


def kill_tree(proc: subprocess.Popen) -> None:
    try:
        import psutil  # type: ignore

        parent = psutil.Process(proc.pid)
        children = parent.children(recursive=True)
        for c in children:
            try:
                c.kill()
            except psutil.Error:
                pass
        try:
            parent.kill()
        except psutil.Error:
            pass
        psutil.wait_procs(children + [parent], timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def run_streaming(
    cmd: list[str],
    cwd: Optional[Path],
    env: dict[str, str],
    on_line: LineHandler,
    cancel: Optional[threading.Event] = None,
    timeout: Optional[float] = None,
) -> tuple[int, list[str]]:
    """Run `cmd`, feed every stdout/stderr chunk (split on \\n and \\r, so tqdm bars arrive as lines) to on_line.
    Returns (returncode, last_lines). Raises Cancelled if the cancel event fires."""
    creationflags = 0
    if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        bufsize=0,
        creationflags=creationflags,
    )
    tail: list[str] = []
    lock = threading.Lock()

    def reader() -> None:
        buf = b""
        assert proc.stdout is not None
        while True:
            chunk = proc.stdout.read(4096)
            if not chunk:
                break
            buf += chunk
            while True:
                idx_n = buf.find(b"\n")
                idx_r = buf.find(b"\r")
                idx = min(i for i in (idx_n, idx_r) if i >= 0) if (idx_n >= 0 or idx_r >= 0) else -1
                if idx < 0:
                    break
                line = buf[:idx].decode("utf-8", errors="replace").strip()
                buf = buf[idx + 1:]
                if line:
                    with lock:
                        tail.append(line)
                        if len(tail) > 400:
                            del tail[:-400]
                    try:
                        on_line(line)
                    except Exception:
                        pass
        if buf.strip():
            line = buf.decode("utf-8", errors="replace").strip()
            with lock:
                tail.append(line)
            try:
                on_line(line)
            except Exception:
                pass

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    started = time.time()
    while True:
        rc = proc.poll()
        if rc is not None:
            break
        if cancel is not None and cancel.is_set():
            kill_tree(proc)
            t.join(timeout=5)
            raise Cancelled()
        if timeout and time.time() - started > timeout:
            kill_tree(proc)
            t.join(timeout=5)
            return 124, tail
        time.sleep(0.2)
    t.join(timeout=10)
    return rc, tail


def run_capture(cmd: list[str], cwd: Optional[Path], env: dict[str, str], cancel: Optional[threading.Event] = None, timeout: Optional[float] = None) -> tuple[int, str, str]:
    """Run and capture stdout/stderr separately (for JSON-emitting helper scripts)."""
    creationflags = 0
    if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    proc = subprocess.Popen(cmd, cwd=str(cwd) if cwd else None, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, creationflags=creationflags)
    out_parts: list[bytes] = []
    err_parts: list[bytes] = []

    def pump(stream, parts):
        for chunk in iter(lambda: stream.read(4096), b""):
            parts.append(chunk)

    t1 = threading.Thread(target=pump, args=(proc.stdout, out_parts), daemon=True)
    t2 = threading.Thread(target=pump, args=(proc.stderr, err_parts), daemon=True)
    t1.start()
    t2.start()
    started = time.time()
    while proc.poll() is None:
        if cancel is not None and cancel.is_set():
            kill_tree(proc)
            raise Cancelled()
        if timeout and time.time() - started > timeout:
            kill_tree(proc)
            return 124, b"".join(out_parts).decode("utf-8", "replace"), b"".join(err_parts).decode("utf-8", "replace")
        time.sleep(0.2)
    t1.join(timeout=10)
    t2.join(timeout=10)
    return proc.returncode, b"".join(out_parts).decode("utf-8", "replace"), b"".join(err_parts).decode("utf-8", "replace")
