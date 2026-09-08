"""Job store (json files), per-job logs, and a single-worker queue with cancellation."""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from . import config

log = logging.getLogger("clipy")

STAGES_RENDER = [
    ("download", "Downloading video"),
    ("prepare", "Preparing video"),
    ("detect", "Detecting faces"),
    ("track", "Tracking face"),
    ("swap", "Swapping face"),
    ("enhance", "Enhancing"),
    ("background", "Processing background"),
    ("encode", "Encoding"),
    ("done", "Completed"),
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_id(prefix: str = "") -> str:
    return prefix + uuid.uuid4().hex[:12]


class JobLog:
    """Appends to data/jobs/<id>/log.txt and keeps the tail in memory."""

    def __init__(self, job_id: str, path: Path):
        self.job_id = job_id
        self.path = path
        self.lines: list[str] = []
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, message: str) -> None:
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"{stamp} [JOB {self.job_id}] {message}"
        with self._lock:
            self.lines.append(line)
            if len(self.lines) > 2000:
                del self.lines[:-2000]
            try:
                with self.path.open("a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except OSError:
                pass
        log.info("[%s] %s", self.job_id, message)

    def tail(self, n: int = 200) -> list[str]:
        with self._lock:
            if self.lines:
                return self.lines[-n:]
        try:
            return self.path.read_text(encoding="utf-8", errors="replace").splitlines()[-n:]
        except OSError:
            return []


class Job:
    def __init__(self, data: dict[str, Any]):
        self.data = data
        self.cancel = threading.Event()
        self.log = JobLog(data["id"], config.JOBS_DIR / data["id"] / "log.txt")

    @property
    def id(self) -> str:
        return self.data["id"]

    @property
    def dir(self) -> Path:
        return config.JOBS_DIR / self.id

    @property
    def temp_dir(self) -> Path:
        return config.TEMP_DIR / self.id


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.RLock()
        self._load()

    def _load(self) -> None:
        config.JOBS_DIR.mkdir(parents=True, exist_ok=True)
        for jf in config.JOBS_DIR.glob("*/job.json"):
            try:
                data = json.loads(jf.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            # jobs that were running when the server died can never finish
            if data.get("status") in ("queued", "processing"):
                data["status"] = "failed"
                data["error"] = {"code": "INTERRUPTED", "message": "The app was restarted while this job was running.", "hint": "Run it again."}
                data["finished_at"] = now_iso()
                try:
                    jf.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                except OSError:
                    pass
            self._jobs[data["id"]] = Job(data)

    def create(self, data: dict[str, Any]) -> Job:
        with self._lock:
            job = Job(data)
            self._jobs[job.id] = job
            self.save(job)
            return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[dict]:
        with self._lock:
            items = [j.data for j in self._jobs.values()]
        return sorted(items, key=lambda d: d.get("created_at", ""), reverse=True)

    def save(self, job: Job) -> None:
        with self._lock:
            job.dir.mkdir(parents=True, exist_ok=True)
            tmp = job.dir / "job.json.tmp"
            tmp.write_text(json.dumps(job.data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(job.dir / "job.json")

    def update(self, job: Job, **fields: Any) -> None:
        with self._lock:
            job.data.update(fields)
            job.data["updated_at"] = now_iso()
        self.save(job)


class JobQueue:
    """One worker thread: the GPU can only do one job well at a time."""

    def __init__(self, store: JobStore, runner: Callable[[Job], None]):
        self.store = store
        self.runner = runner
        self._q: "queue.Queue[str]" = queue.Queue()
        self.current: Optional[str] = None
        self._thread = threading.Thread(target=self._loop, name="clipy-worker", daemon=True)
        self._thread.start()

    def submit(self, job: Job) -> None:
        self._q.put(job.id)

    def position(self, job_id: str) -> int:
        with self._q.mutex:
            items = list(self._q.queue)
        return items.index(job_id) + 1 if job_id in items else 0

    def _loop(self) -> None:
        while True:
            job_id = self._q.get()
            job = self.store.get(job_id)
            if job is None:
                continue
            if job.cancel.is_set():
                self.store.update(job, status="cancelled", finished_at=now_iso())
                continue
            self.current = job_id
            started = time.time()
            try:
                self.runner(job)
            except Exception as e:  # the runner handles its own errors; this is the last line of defence
                log.exception("job %s crashed", job_id)
                self.store.update(job, status="failed", error={"code": "CRASH", "message": "Could not process video.", "hint": str(e)[:300]}, finished_at=now_iso())
            finally:
                self.current = None
                job.log.write(f"finished in {time.time() - started:.1f}s with status={job.data.get('status')}")
