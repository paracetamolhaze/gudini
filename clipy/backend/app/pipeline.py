"""Job pipelines: source analysis (download -> prepare -> detect people) and render (swap -> background -> encode)."""
from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Optional

from . import config, downloader, ffmpeg, hardware
from .engine import background as bg_engine
from .engine.facefusion_runner import DEFAULT_QUALITY, PRESETS, SwapRequest, run_swap
from .errors import Cancelled, UserError, friendly
from .jobs import STAGES_RENDER, Job, JobStore, now_iso
from .procs import run_capture

ANALYZE_SCRIPT = config.APP_DIR / "engine" / "ff_analyze.py"


# ---------------------------------------------------------------- helpers

class StageTracker:
    """Keeps job.data['stages'] / 'stage' / 'progress' honest: progress only moves with real work."""

    def __init__(self, store: JobStore, job: Job, stages: list[tuple[str, str]], weights: dict[str, float]):
        self.store = store
        self.job = job
        self.keys = [k for k, _ in stages]
        self.labels = dict(stages)
        self.weights = weights
        self.job.data["stages"] = [{"key": k, "label": lbl, "status": "pending", "progress": 0} for k, lbl in stages]
        self._last_save = 0.0
        self.store.save(job)

    def _entry(self, key: str) -> dict:
        return next(s for s in self.job.data["stages"] if s["key"] == key)

    def start(self, key: str, note: str = "") -> None:
        e = self._entry(key)
        e["status"] = "running"
        e["progress"] = 0
        if note:
            e["note"] = note
        self.job.data["stage"] = key
        self.job.data["stage_label"] = self.labels[key]
        self._recompute()
        self.store.save(self.job)
        self.job.log.write(f"stage: {self.labels[key]}" + (f" ({note})" if note else ""))

    def progress(self, key: str, fraction: float, note: str = "") -> None:
        e = self._entry(key)
        e["progress"] = int(max(0.0, min(1.0, fraction)) * 100)
        if note:
            e["note"] = note
        self._recompute()
        now = time.time()
        if now - self._last_save > 0.5:
            self._last_save = now
            self.store.save(self.job)

    def done(self, key: str, note: str = "") -> None:
        e = self._entry(key)
        e["status"] = "done"
        e["progress"] = 100
        if note:
            e["note"] = note
        self._recompute()
        self.store.save(self.job)

    def skip(self, key: str, note: str = "") -> None:
        e = self._entry(key)
        e["status"] = "skipped"
        e["progress"] = 100
        if note:
            e["note"] = note
        self._recompute()
        self.store.save(self.job)

    def fail(self, key: Optional[str]) -> None:
        if key:
            self._entry(key)["status"] = "failed"
        self.store.save(self.job)

    def _recompute(self) -> None:
        total_w = sum(self.weights.get(k, 0) for k in self.keys) or 1.0
        acc = 0.0
        for s in self.job.data["stages"]:
            w = self.weights.get(s["key"], 0)
            if s["status"] in ("done", "skipped"):
                acc += w
            elif s["status"] == "running":
                acc += w * s["progress"] / 100.0
        self.job.data["progress"] = int(round(100 * acc / total_w))


def check_cancel(job: Job) -> None:
    if job.cancel.is_set():
        raise Cancelled()


def _cleanup_temp(job: Job) -> None:
    try:
        if job.temp_dir.exists():
            shutil.rmtree(job.temp_dir, ignore_errors=True)
    except OSError:
        pass


def check_disk(path: Path, need_bytes: int) -> None:
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return
    if usage.free < need_bytes:
        raise UserError("DISK_FULL", "Недостаточно места на диске.", f"Нужно около {need_bytes // (1024 * 1024)} МБ, свободно {usage.free // (1024 * 1024)} МБ.", status=507)


def run_analysis_script(mode: str, input_path: Path, out_dir: Path, cancel: threading.Event, log, max_samples: int = 32) -> dict:
    hw = hardware.detect()
    cmd = [config.PYTHON, str(ANALYZE_SCRIPT), mode, "--input", str(input_path), "--out-dir", str(out_dir), "--providers", *hw.execution_providers]
    if mode == "video":
        cmd += ["--max-samples", str(max_samples)]
    rc, out, err = run_capture(cmd, cwd=config.FACEFUSION_DIR, env=hardware.engine_env(), cancel=cancel, timeout=1800)
    for line in err.strip().splitlines()[-40:]:
        if line.strip():
            log("analyzer: " + line[:400])
    try:
        payload = json.loads(out.strip().splitlines()[-1]) if out.strip() else {}
    except ValueError:
        payload = {}
    if rc != 0 or not payload:
        raise friendly(RuntimeError(err[-2000:] or f"analyzer exit {rc}"), "ANALYSIS_FAILED")
    if not payload.get("ok"):
        raise UserError(payload.get("code", "ANALYSIS_FAILED"), payload.get("message", "Не удалось разобрать лица."), "", details=payload.get("details", ""), status=422)
    return payload


# ---------------------------------------------------------------- sources

def source_dir(source_id: str) -> Path:
    return config.SOURCES_DIR / source_id


def load_source(source_id: str) -> Optional[dict]:
    f = source_dir(source_id) / "source.json"
    if not f.is_file():
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except ValueError:
        return None


def save_source(src: dict) -> None:
    d = source_dir(src["id"])
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "source.json.tmp"
    tmp.write_text(json.dumps(src, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(d / "source.json")


STAGES_ANALYZE = [("download", "Скачивание видео"), ("prepare", "Подготовка видео"), ("detect", "Поиск лиц"), ("done", "Готово")]


def run_analyze_job(store: JobStore, job: Job) -> None:
    """Job type 'analyze': fills the source record with the prepared video and the people found in it."""
    src = load_source(job.data["source_id"])
    if not src:
        store.update(job, status="failed", error={"code": "NOT_FOUND", "message": "Видео не найдено.", "hint": ""}, finished_at=now_iso())
        return
    tracker = StageTracker(store, job, STAGES_ANALYZE, {"download": 3, "prepare": 1, "detect": 3, "done": 0})
    store.update(job, status="processing", started_at=now_iso())
    src["status"] = "processing"
    save_source(src)
    sdir = source_dir(src["id"])
    stage = None
    try:
        # 1. download
        stage = "download"
        if src["kind"] == "url":
            tracker.start(stage)
            check_disk(config.DATA_DIR, 1024 * 1024 * 1024)
            original = downloader.download(src["url"], sdir / "download", job.log.write, lambda f, n: tracker.progress("download", f, n), job.cancel)
            src["files"]["original"] = str(original)
            tracker.done(stage)
        else:
            tracker.skip(stage, "local upload")
        check_cancel(job)

        # 2. prepare
        stage = "prepare"
        tracker.start(stage)
        original = Path(src["files"]["original"])
        info = ffmpeg.probe(original)
        if info.duration > config.MAX_VIDEO_SECONDS:
            raise UserError("TOO_LONG", f"Видео длиннее {int(config.MAX_VIDEO_SECONDS // 60)} минут.", "Возьмите ролик покороче.")
        job.log.write(f"Input: {info.width}x{info.height} @ {info.fps}fps, {info.duration}s, {info.video_codec}/{info.pix_fmt}, audio={info.audio_codec or 'none'}")
        check_disk(config.DATA_DIR, int(original.stat().st_size * 3) + 200 * 1024 * 1024)
        prepared = sdir / "prepared.mp4"
        pinfo = ffmpeg.normalize(original, prepared, info, job.log.write)
        ffmpeg.poster(prepared, sdir / "poster.jpg", min(0.5, max(0.0, pinfo.duration / 4)))
        src["files"]["prepared"] = str(prepared)
        src["files"]["poster"] = str(sdir / "poster.jpg")
        src["info"] = pinfo.to_dict()
        src["original_info"] = info.to_dict()
        save_source(src)
        tracker.done(stage, f"{pinfo.width}x{pinfo.height} @ {pinfo.fps}fps")
        check_cancel(job)

        # 3. detect people
        stage = "detect"
        tracker.start(stage)
        # примерно кадр в секунду: на длинных роликах редкая выборка рвала одного человека на несколько
        samples = int(max(24, min(120, round(pinfo.duration))))
        analysis = run_analysis_script("video", prepared, sdir / "persons", job.cancel, job.log.write, max_samples=samples)
        persons = analysis.get("persons", [])
        job.log.write(f"Detected people: {len(persons)} (sampled {analysis.get('frames_sampled')} frames)")
        for p in persons:
            job.log.write(f"  {p['id']}: seen in {p['frames_seen']} frames, coverage {p['coverage']:.0%}, ref frame {p['reference_frame']} pos {p['reference_position']}, nearest other {p['nearest_other_distance']}")
        src["analysis"] = {k: v for k, v in analysis.items() if k != "ok"}
        src["persons"] = persons
        src["skipped_faces"] = int(analysis.get("skipped_faces") or 0)
        tracker.done(stage, f"{len(persons)} people")
        tracker.done("done")
        src["status"] = "ready"
        src["error"] = None
        save_source(src)
        store.update(job, status="completed", finished_at=now_iso(), result={"persons": len(persons)})
    except Cancelled:
        tracker.fail(stage)
        src["status"] = "cancelled"
        save_source(src)
        store.update(job, status="cancelled", finished_at=now_iso())
        job.log.write("cancelled")
    except Exception as e:  # noqa
        err = friendly(e, "ANALYSIS_FAILED")
        tracker.fail(stage)
        job.log.write(f"ERROR {err.code}: {err.message} | {err.details[:1500]}")
        src["status"] = "failed"
        src["error"] = err.to_dict()
        save_source(src)
        store.update(job, status="failed", error=err.to_dict(), finished_at=now_iso())
    finally:
        _cleanup_temp(job)


# ---------------------------------------------------------------- render

def person_label(person: dict, persons: list[dict]) -> str:
    """Человек 1, 2, 3… в том же порядке, в каком их видит пользователь."""
    try:
        return f"Человек {persons.index(person) + 1}"
    except ValueError:
        return person.get("id", "человек")


def pick_reference_distance(person: dict, persons: list[dict]) -> float:
    """Порог совпадения лица: покрыть собственный разброс человека, но не залезть на соседа.

    Раньше порог считался от расстояния до ЛЮБОГО другого кластера, включая случайное лицо на фоне,
    и опускался до 0.25 при разбросе самого человека 0.27 — треть кадров оставалась без замены.
    Теперь берём разброс по 85-му перцентилю плюс запас и ограничиваем только заметными людьми.
    """
    intra = float(person.get("intra_distance", 0.2))
    majors = [p for p in persons if p is not person and (float(p.get("coverage", 0)) >= 0.05 or float(p.get("avg_area_ratio", 0)) >= 0.05)]
    nearest = float(person.get("nearest_other_distance", 1.0)) if majors else 1.0
    # Запас 0.30 к разбросу: профиль и полуоборот уходят от анфасного опорного лица далеко.
    # На проверочном ролике при 0.30 заменялось 88% профилей, при 0.45 — все.
    want = intra + 0.30
    if nearest < want + 0.05:
        # рядом есть заметный другой человек: подходим к нему не ближе 0.05
        want = max(0.30, min(want, nearest - 0.05))
    value = min(0.55, max(0.30, want))
    # FaceFusion принимает порог только с шагом 0.05
    return round(round(value / 0.05) * 0.05, 2)


def run_render_job(store: JobStore, job: Job) -> None:
    d = job.data
    weights = {"download": 0, "prepare": 0.5, "detect": 1, "track": 0.5, "swap": 10, "enhance": 0, "background": 6, "encode": 1, "done": 0}
    tracker = StageTracker(store, job, STAGES_RENDER, weights)
    store.update(job, status="processing", started_at=now_iso())
    stage: Optional[str] = None
    hw = hardware.detect()
    job.log.write(f"GPU: {hw.gpu_name or 'none'} | Backend: {hw.backend.upper()} | providers={hw.execution_providers}")
    try:
        src = load_source(d["source_id"])
        if not src or src.get("status") != "ready":
            raise UserError("SOURCE_NOT_READY", "Видео ещё не готово.", "Дождитесь окончания разбора или добавьте видео ещё раз.")
        info = src["info"]
        prepared = Path(src["files"]["prepared"])
        if not prepared.is_file():
            raise UserError("SOURCE_MISSING", "Подготовленное видео пропало.", "Добавьте видео ещё раз.")
        job.temp_dir.mkdir(parents=True, exist_ok=True)
        check_disk(config.DATA_DIR, int(prepared.stat().st_size * 6) + 500 * 1024 * 1024)

        tracker.skip("download", "already downloaded")
        stage = "prepare"
        tracker.start(stage)
        job.log.write(f"Input: {info['width']}x{info['height']} @ {info['fps']}fps, {info['duration']}s, audio={'yes' if info['has_audio'] else 'no'}")
        tracker.done(stage)

        background = d.get("background") or None
        if not (d.get("assignments") or background):
            raise UserError("NOTHING_TO_DO", "Нечего делать: включите замену лица или фона.")

        current = prepared  # the video the next stage works on
        # --- кого на кого меняем
        stage = "detect"
        tracker.start(stage)
        persons: list[dict] = src.get("persons") or []
        # копии: служебные поля (_person, _photos) не должны попасть в job.json
        assignments: list[dict] = [dict(a) for a in (d.get("assignments") or [])]
        if assignments:
            if not persons:
                raise UserError("NO_FACE", "В видео не найдено лицо.", "Для замены лица оно должно быть видно. Можно заменить только фон.", status=422)
            for a in assignments:
                wanted = a.get("person") or "auto"
                person = persons[0] if wanted == "auto" else next((p for p in persons if p["id"] == wanted), None)
                if person is None:
                    raise UserError("BAD_PERSON", "Выбранный человек в этом видео не найден.", "Выберите человека из списка заново.")
                a["_person"] = person
                a["_photos"] = [Path(x) for x in a.get("photos", []) if Path(x).is_file()]
                if not a["_photos"]:
                    raise UserError("NO_SOURCE_PHOTO", "Фото лица пропало.", "Загрузите фото ещё раз и запустите задачу заново.")
            job.log.write(f"Detected faces: {len(persons)} | replacing: " + ", ".join(f"{a['_person']['id']} <- {len(a['_photos'])} photo(s)" for a in assignments))
            tracker.done(stage, f"людей {len(persons)}, замен {len(assignments)}")
        else:
            tracker.skip(stage, "замена лица выключена")

        # --- порог совпадения для каждой замены
        stage = "track"
        if assignments:
            tracker.start(stage)
            tracking = []
            for a in assignments:
                person = a["_person"]
                a["_distance"] = pick_reference_distance(person, persons)
                tracking.append({"person": person["id"], "reference_frame": person["reference_frame"], "reference_position": person["reference_position"], "reference_distance": a["_distance"]})
                job.log.write(f"Tracking {person['id']}: reference frame {person['reference_frame']}, position {person['reference_position']}, spread {person.get('intra_distance')}, max distance {a['_distance']}")
            d["tracking"] = tracking
            tracker.done(stage, f"порог {', '.join(str(t['reference_distance']) for t in tracking)}")
        else:
            tracker.skip(stage)
        check_cancel(job)

        # --- замена лиц: по проходу на каждого человека, результат каждого идёт в следующий
        stage = "swap"
        preset = PRESETS[DEFAULT_QUALITY]
        if assignments:
            total_passes = len(assignments)
            tracker.start(stage, f"замен {total_passes}")
            job.log.write(f"Face swap started: model={preset.swapper} enhancer={preset.enhancer or 'off'} mask={'+'.join(preset.mask_types)} passes={total_passes}")
            quality = job.data.get("quality") or DEFAULT_QUALITY
            preset_label = (PRESETS.get(quality) or PRESETS[DEFAULT_QUALITY]).label
            job.log.write(f"режим: {preset_label} ({quality})")
            for i, a in enumerate(assignments):
                person = a["_person"]
                out_swap = job.temp_dir / f"swapped_{i + 1}.mp4"
                label = person_label(person, persons)
                job.log.write(f"pass {i + 1}/{total_passes}: {label} ({person['id']}) <- {len(a['_photos'])} photo(s)")
                result = run_swap(
                    SwapRequest(
                        source_photos=a["_photos"],
                        target_video=current,
                        output_video=out_swap,
                        temp_dir=job.temp_dir / f"ff{i + 1}",
                        quality=quality,
                        reference_frame=int(person["reference_frame"]),
                        reference_position=int(person["reference_position"]),
                        reference_distance=float(a["_distance"]),
                        hardware=hw,
                        fps=float(info["fps"]),
                        intermediate=i < total_passes - 1,
                    ),
                    job.log.write,
                    (lambda idx: lambda f, n: tracker.progress("swap", (idx + f) / total_passes, f"{idx + 1} из {total_passes} · {n}"))(i),
                    job.cancel,
                )
                a["engine"] = result
                current = out_swap
                check_cancel(job)
            d["engine"] = {"name": "facefusion", "version": config.ENGINE_VERSION, "passes": total_passes, "swapper": preset.swapper, "enhancer": preset.enhancer}
            d["assignments"] = [{k: v for k, v in a.items() if not k.startswith("_")} for a in assignments]
            tracker.done(stage)
            tracker.done("enhance", preset.enhancer or "выключено")
        else:
            tracker.skip(stage, "замена лица выключена")
            tracker.skip("enhance")
        check_cancel(job)

        # --- background
        stage = "background"
        if background:
            tracker.start(stage)
            bg_file = Path(background["file"])
            if not bg_file.is_file():
                raise UserError("NO_BACKGROUND", "Файл фона пропал.", "Загрузите его ещё раз.")
            out_bg = job.temp_dir / "background.mp4"
            bg_engine.replace_background(current, bg_file, out_bg, hw, job.log.write, lambda f, n: tracker.progress("background", f, n), job.cancel)
            # the matting pass writes video only; put the original audio back
            muxed = job.temp_dir / "background_audio.mp4"
            ffmpeg.mux_audio(out_bg, prepared, muxed, bool(info.get("has_audio")), job.log.write)
            current = muxed
            tracker.done(stage)
        else:
            tracker.skip(stage, "off")
        check_cancel(job)

        # --- encode / finalize
        stage = "encode"
        tracker.start(stage)
        config.OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
        final = config.OUTPUTS_DIR / f"{job.id}.mp4"
        out_info = ffmpeg.probe(current)
        if info.get("has_audio") and not out_info.has_audio:
            job.log.write("output lost its audio track, muxing the original audio back")
            fixed = job.temp_dir / "with_audio.mp4"
            ffmpeg.mux_audio(current, prepared, fixed, True, job.log.write)
            current = fixed
            out_info = ffmpeg.probe(current)
        shutil.move(str(current), str(final))
        ffmpeg.poster(final, config.OUTPUTS_DIR / f"{job.id}.jpg", min(0.5, max(0.0, out_info.duration / 4)))
        tracker.done(stage)
        tracker.done("done")
        d["result"] = {"file": str(final), "poster": str(config.OUTPUTS_DIR / f"{job.id}.jpg"), **out_info.to_dict()}
        job.log.write(f"Output saved: {final.name} ({out_info.width}x{out_info.height} @ {out_info.fps}fps, {out_info.duration}s, audio={'yes' if out_info.has_audio else 'no'})")
        store.update(job, status="completed", finished_at=now_iso())
    except Cancelled:
        tracker.fail(stage)
        job.log.write("cancelled by user")
        store.update(job, status="cancelled", finished_at=now_iso())
    except Exception as e:  # noqa
        err = friendly(e)
        tracker.fail(stage)
        job.log.write(f"ERROR {err.code}: {err.message} | {err.details[:2000]}")
        store.update(job, status="failed", error=err.to_dict(), finished_at=now_iso())
    finally:
        _cleanup_temp(job)


def run_job(store: JobStore, job: Job) -> None:
    if job.data.get("type") == "analyze":
        run_analyze_job(store, job)
    else:
        run_render_job(store, job)
