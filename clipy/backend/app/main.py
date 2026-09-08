"""Clipy — AI Reels Remaker. FastAPI backend serving the API and the built frontend under /clipy."""
from __future__ import annotations

import logging
import shutil
import uuid
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, downloader, faces, ffmpeg, hardware, pipeline
from .engine.facefusion_runner import PRESETS
from .errors import UserError
from .jobs import JobQueue, JobStore, new_id, now_iso

config.ensure_dirs()
_log_handler = RotatingFileHandler(config.LOGS_DIR / "clipy.log", maxBytes=5_000_000, backupCount=3, encoding="utf-8")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", handlers=[_log_handler, logging.StreamHandler()])
log = logging.getLogger("clipy")

P = config.URL_PREFIX
app = FastAPI(title="Clipy", docs_url=f"{P}/api/docs", openapi_url=f"{P}/api/openapi.json")
store = JobStore()
queue = JobQueue(store, lambda job: pipeline.run_job(store, job))


@app.middleware("http")
async def _password_gate(request: Request, call_next):
    """Optional protection when the app is published through a reverse proxy: CLIPY_PASSWORD (HTTP Basic).
    Requests from this machine (127.0.0.1) never need the password, so local use stays frictionless."""
    password = config.PASSWORD
    client = request.client.host if request.client else ""
    # Docker Desktop relays host.docker.internal through loopback, so a proxied request also looks local;
    # the reverse proxy always adds X-Forwarded-For, direct local browsers never do.
    proxied = bool(request.headers.get("x-forwarded-for"))
    if password and (proxied or client not in ("127.0.0.1", "::1")):
        import base64

        header = request.headers.get("authorization", "")
        ok = False
        if header.lower().startswith("basic "):
            try:
                raw = base64.b64decode(header[6:]).decode("utf-8", "replace")
                ok = raw.split(":", 1)[-1] == password
            except Exception:
                ok = False
        if not ok:
            return JSONResponse(status_code=401, content={"error": {"code": "AUTH", "message": "Password required."}}, headers={"WWW-Authenticate": 'Basic realm="Clipy"'})
    return await call_next(request)


@app.exception_handler(UserError)
async def _user_error(_: Request, exc: UserError):
    log.warning("user error %s: %s | %s", exc.code, exc.message, exc.details[:300])
    return JSONResponse(status_code=exc.status, content={"error": exc.to_dict()})


@app.exception_handler(Exception)
async def _any_error(_: Request, exc: Exception):
    log.exception("unhandled")
    return JSONResponse(status_code=500, content={"error": {"code": "INTERNAL", "message": "Something went wrong.", "hint": "See data/logs/clipy.log"}})


# ---------------------------------------------------------------- helpers

def _job_view(job) -> dict:
    d = dict(job.data)
    d["queue_position"] = queue.position(job.id) if d.get("status") == "queued" else 0
    d.pop("source_photos", None)
    if d.get("result"):
        d["result"] = {k: v for k, v in d["result"].items() if k not in ("file", "poster")}
        d["result"]["video_url"] = f"{P}/api/jobs/{job.id}/result"
        d["result"]["poster_url"] = f"{P}/api/jobs/{job.id}/poster"
    return d


def _source_view(src: dict) -> dict:
    d = {k: v for k, v in src.items() if k != "files"}
    d["video_url"] = f"{P}/api/sources/{src['id']}/video" if src.get("files", {}).get("prepared") else None
    d["poster_url"] = f"{P}/api/sources/{src['id']}/poster" if src.get("files", {}).get("poster") else None
    for p in d.get("persons") or []:
        p["thumbnail_url"] = f"{P}/api/sources/{src['id']}/persons/{p['id']}.jpg"
    job = store.get(src.get("job_id", ""))
    if job:
        d["job"] = {"id": job.id, "status": job.data.get("status"), "stage": job.data.get("stage"), "stage_label": job.data.get("stage_label"), "progress": job.data.get("progress", 0), "stages": job.data.get("stages", [])}
    return d


def _face_view(f: dict) -> dict:
    return {"id": f["id"], "created_at": f["created_at"], "original_name": f.get("original_name"), "warnings": f.get("warnings", []),
            "face_width": f.get("face_width"), "image_url": f"{P}/api/faces/{f['id']}/image", "thumb_url": f"{P}/api/faces/{f['id']}/thumb"}


async def _save_upload(upload: UploadFile, allowed: set[str], max_bytes: int, dest_dir: Path) -> Path:
    name = upload.filename or ""
    ext = Path(name).suffix.lower()
    if ext not in allowed:
        raise UserError("BAD_FILE_TYPE", f"File type {ext or 'unknown'} is not supported.", "Allowed: " + ", ".join(sorted(allowed)))
    dest_dir.mkdir(parents=True, exist_ok=True)
    tmp = dest_dir / f"{uuid.uuid4().hex}{ext}"
    size = 0
    try:
        with tmp.open("wb") as f:
            while True:
                chunk = await upload.read(4 << 20)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise UserError("FILE_TOO_LARGE", f"The file is larger than {max_bytes // (1024 * 1024)} MB.")
                f.write(chunk)
    except UserError:
        tmp.unlink(missing_ok=True)
        raise
    except OSError as e:
        tmp.unlink(missing_ok=True)
        raise UserError("DISK_FULL", "Could not write the file. The disk may be full.", details=str(e), status=507)
    if size == 0:
        tmp.unlink(missing_ok=True)
        raise UserError("EMPTY_FILE", "The file is empty.")
    return tmp


# ---------------------------------------------------------------- system

@app.get(f"{P}/api/system")
async def system():
    hw = await run_in_threadpool(hardware.detect)
    return {
        "app": "Clipy",
        "engine": {"name": "FaceFusion", "version": config.ENGINE_VERSION, "installed": (config.FACEFUSION_DIR / "facefusion.py").is_file()},
        "hardware": hw.to_dict(),
        "ffmpeg": ffmpeg.version() if shutil.which("ffmpeg") else "",
        "ytdlp": downloader.ytdlp_version(),
        "cookies": downloader.cookies_status(),
        "quality_modes": {k: {"swapper": v.swapper, "pixel_boost": v.pixel_boost, "enhancer": v.enhancer, "mask": v.mask_types} for k, v in PRESETS.items()},
        "limits": {"max_video_seconds": config.MAX_VIDEO_SECONDS, "max_video_mb": config.MAX_VIDEO_BYTES // (1024 * 1024)},
        "busy_job": queue.current,
    }


# ---------------------------------------------------------------- uploads / sources

@app.post(f"{P}/api/uploads/video")
async def upload_video(file: UploadFile = File(...)):
    tmp = await _save_upload(file, config.VIDEO_EXTENSIONS, config.MAX_VIDEO_BYTES, config.UPLOADS_DIR)
    try:
        info = await run_in_threadpool(ffmpeg.probe, tmp)
    except UserError:
        tmp.unlink(missing_ok=True)
        raise
    upload_id = tmp.stem
    return {"upload_id": upload_id, "filename": (file.filename or "")[:120], "size": tmp.stat().st_size, "info": info.to_dict()}


class SourceIn(BaseModel):
    url: Optional[str] = None
    upload_id: Optional[str] = None


@app.post(f"{P}/api/sources")
async def create_source(body: SourceIn):
    src_id = new_id("s")
    sdir = pipeline.source_dir(src_id)
    sdir.mkdir(parents=True, exist_ok=True)
    src: dict = {"id": src_id, "created_at": now_iso(), "status": "queued", "files": {}, "persons": [], "error": None}
    if body.url:
        src["kind"] = "url"
        src["url"] = downloader.validate_url(body.url)
    elif body.upload_id:
        matches = [p for p in config.UPLOADS_DIR.glob(f"{body.upload_id}.*") if p.is_file()] if body.upload_id.isalnum() else []
        if not matches:
            raise UserError("NOT_FOUND", "Uploaded file not found.", "Upload the video again.", status=404)
        original = sdir / ("original" + matches[0].suffix.lower())
        shutil.move(str(matches[0]), str(original))
        src["kind"] = "upload"
        src["files"]["original"] = str(original)
    else:
        raise UserError("BAD_REQUEST", "Provide a link or an uploaded file.")
    job = store.create({"id": new_id("a"), "type": "analyze", "source_id": src_id, "created_at": now_iso(), "status": "queued", "progress": 0, "stages": []})
    src["job_id"] = job.id
    pipeline.save_source(src)
    queue.submit(job)
    return _source_view(src)


@app.get(f"{P}/api/sources/{{source_id}}")
async def get_source(source_id: str):
    src = pipeline.load_source(source_id)
    if not src:
        raise HTTPException(404, "source not found")
    return _source_view(src)


@app.get(f"{P}/api/sources/{{source_id}}/video")
async def source_video(source_id: str):
    src = pipeline.load_source(source_id)
    f = Path(src["files"].get("prepared", "")) if src else None
    if not f or not f.is_file():
        raise HTTPException(404, "not ready")
    return FileResponse(f, media_type="video/mp4", filename="source.mp4")


@app.get(f"{P}/api/sources/{{source_id}}/poster")
async def source_poster(source_id: str):
    src = pipeline.load_source(source_id)
    f = Path(src["files"].get("poster", "")) if src else None
    if not f or not f.is_file():
        raise HTTPException(404, "not ready")
    return FileResponse(f, media_type="image/jpeg")


@app.get(f"{P}/api/sources/{{source_id}}/persons/{{person_id}}.jpg")
async def person_thumb(source_id: str, person_id: str):
    if not person_id.replace("_", "").isalnum():
        raise HTTPException(404)
    f = pipeline.source_dir(source_id) / "persons" / f"{person_id}.jpg"
    if not f.is_file():
        raise HTTPException(404)
    return FileResponse(f, media_type="image/jpeg")


@app.post(f"{P}/api/uploads/background")
async def upload_background(file: UploadFile = File(...)):
    tmp = await _save_upload(file, config.BACKGROUND_EXTENSIONS, config.MAX_VIDEO_BYTES, config.BACKGROUNDS_DIR)
    kind = "video" if tmp.suffix.lower() in config.VIDEO_EXTENSIONS else "image"
    if kind == "video":
        try:
            await run_in_threadpool(ffmpeg.probe, tmp)
        except UserError:
            tmp.unlink(missing_ok=True)
            raise
    else:
        try:
            from PIL import Image

            with Image.open(tmp) as im:
                im.verify()
        except Exception:
            tmp.unlink(missing_ok=True)
            raise UserError("BAD_IMAGE", "The background image could not be read.", "Use a JPEG or PNG file.")
    return {"background_id": tmp.stem, "kind": kind, "filename": (file.filename or "")[:120], "preview_url": f"{P}/api/backgrounds/{tmp.stem}"}


@app.get(f"{P}/api/backgrounds/{{background_id}}")
async def background_file(background_id: str):
    matches = [p for p in config.BACKGROUNDS_DIR.glob(f"{background_id}.*") if p.is_file()] if background_id.isalnum() else []
    if not matches:
        raise HTTPException(404)
    f = matches[0]
    media = "video/mp4" if f.suffix.lower() in config.VIDEO_EXTENSIONS else "image/jpeg"
    return FileResponse(f, media_type=media)


# ---------------------------------------------------------------- faces / identities

@app.post(f"{P}/api/faces")
async def upload_face(file: UploadFile = File(...)):
    tmp = await _save_upload(file, config.IMAGE_EXTENSIONS, config.MAX_IMAGE_BYTES, config.TEMP_DIR / "faces")
    try:
        from PIL import Image, ImageOps

        with Image.open(tmp) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            if max(im.size) > 2048:
                im.thumbnail((2048, 2048))
            jpg = tmp.with_suffix(".jpg")
            im.save(jpg, "JPEG", quality=95)
        if jpg != tmp:
            tmp.unlink(missing_ok=True)
        tmp = jpg
    except UserError:
        raise
    except Exception:
        tmp.unlink(missing_ok=True)
        raise UserError("BAD_IMAGE", "The photo could not be read.", "Use a JPEG or PNG file.")
    face = await run_in_threadpool(faces.register_face, tmp, file.filename or "", log.info)
    return {"face": _face_view(face)}


@app.get(f"{P}/api/faces")
async def get_faces():
    return {"faces": [_face_view(f) for f in faces.list_faces()]}


@app.delete(f"{P}/api/faces/{{face_id}}")
async def remove_face(face_id: str):
    if not faces.delete_face(face_id):
        raise HTTPException(404)
    return {"ok": True}


@app.get(f"{P}/api/faces/{{face_id}}/image")
async def face_image(face_id: str):
    f = faces.load_face(face_id)
    if not f or not Path(f["file"]).is_file():
        raise HTTPException(404)
    return FileResponse(f["file"], media_type="image/jpeg")


@app.get(f"{P}/api/faces/{{face_id}}/thumb")
async def face_thumb(face_id: str):
    f = faces.load_face(face_id)
    if not f:
        raise HTTPException(404)
    p = Path(f["thumb"]) if Path(f["thumb"]).is_file() else Path(f["file"])
    return FileResponse(p, media_type="image/jpeg")


class IdentityIn(BaseModel):
    name: str = "My face"
    face_ids: list[str] = Field(default_factory=list)


class IdentityPatch(BaseModel):
    name: Optional[str] = None
    face_ids: Optional[list[str]] = None


@app.get(f"{P}/api/identities")
async def get_identities():
    return {"identities": faces.list_identities()}


@app.post(f"{P}/api/identities")
async def post_identity(body: IdentityIn):
    return {"identity": faces.create_identity(body.name, body.face_ids)}


@app.patch(f"{P}/api/identities/{{identity_id}}")
async def patch_identity(identity_id: str, body: IdentityPatch):
    return {"identity": faces.update_identity(identity_id, body.name, body.face_ids)}


@app.delete(f"{P}/api/identities/{{identity_id}}")
async def remove_identity(identity_id: str):
    if not faces.delete_identity(identity_id):
        raise HTTPException(404)
    return {"ok": True}


# ---------------------------------------------------------------- jobs

class BackgroundIn(BaseModel):
    background_id: str


class JobIn(BaseModel):
    source_id: str
    face_ids: list[str] = Field(default_factory=list)
    identity_id: Optional[str] = None
    face_swap: bool = True
    target_person: str = "auto"
    quality: str = "balanced"
    background: Optional[BackgroundIn] = None


@app.post(f"{P}/api/jobs")
async def create_job(body: JobIn):
    src = pipeline.load_source(body.source_id)
    if not src:
        raise UserError("NOT_FOUND", "Source video not found.", "Add the video again.", status=404)
    if src.get("status") != "ready":
        raise UserError("SOURCE_NOT_READY", "The source video is still being analysed." if src.get("status") in ("queued", "processing") else "The source video failed to load.", "Wait for the analysis to finish or add the video again.")
    if body.quality not in PRESETS:
        raise UserError("BAD_QUALITY", "Unknown quality mode.")
    face_ids = list(body.face_ids)
    if body.identity_id:
        ident = faces.load_identity(body.identity_id)
        if not ident:
            raise UserError("NOT_FOUND", "Face profile not found.", status=404)
        face_ids = ident["face_ids"] + [f for f in face_ids if f not in ident["face_ids"]]
    photos = faces.photos_for(face_ids)
    if body.face_swap and not photos:
        raise UserError("NO_SOURCE_PHOTO", "Upload your face photo first.")
    if body.face_swap and body.target_person != "auto" and not any(p["id"] == body.target_person for p in src.get("persons", [])):
        raise UserError("BAD_PERSON", "The selected person was not found in this video.")
    background = None
    if body.background:
        bid = body.background.background_id
        matches = [p for p in config.BACKGROUNDS_DIR.glob(f"{bid}.*") if p.is_file()] if bid.isalnum() else []
        if not matches:
            raise UserError("NOT_FOUND", "Background file not found.", "Upload it again.", status=404)
        background = {"file": str(matches[0]), "kind": "video" if matches[0].suffix.lower() in config.VIDEO_EXTENSIONS else "image", "background_id": bid}
    if not body.face_swap and not background:
        raise UserError("NOTHING_TO_DO", "Enable face replacement or background replacement.")
    data = {
        "id": new_id("j"),
        "type": "render",
        "created_at": now_iso(),
        "status": "queued",
        "progress": 0,
        "stages": [],
        "source_id": body.source_id,
        "source": {"kind": src.get("kind"), "url": src.get("url"), "duration": src.get("info", {}).get("duration"), "width": src.get("info", {}).get("width"),
                   "height": src.get("info", {}).get("height"), "fps": src.get("info", {}).get("fps")},
        "face_ids": face_ids,
        "identity_id": body.identity_id,
        "source_photos": [str(p) for p in photos],
        "face_swap": body.face_swap,
        "target_person": body.target_person,
        "quality": body.quality,
        "background": background,
    }
    job = store.create(data)
    queue.submit(job)
    return {"job_id": job.id, "job": _job_view(job)}


@app.get(f"{P}/api/jobs")
async def list_jobs():
    return {"jobs": [_job_view(store.get(d["id"])) for d in store.list() if d.get("type") == "render"][:50]}


@app.get(f"{P}/api/jobs/{{job_id}}")
async def get_job(job_id: str):
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return _job_view(job)


@app.get(f"{P}/api/jobs/{{job_id}}/logs")
async def job_logs(job_id: str, n: int = 200):
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return {"lines": job.log.tail(max(1, min(n, 2000)))}


@app.post(f"{P}/api/jobs/{{job_id}}/cancel")
async def cancel_job(job_id: str):
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job.data.get("status") in ("completed", "failed", "cancelled"):
        return {"ok": True, "status": job.data["status"]}
    job.cancel.set()
    job.log.write("cancel requested")
    if job.data.get("status") == "queued":
        store.update(job, status="cancelled", finished_at=now_iso())
    return {"ok": True, "status": job.data["status"]}


@app.delete(f"{P}/api/jobs/{{job_id}}")
async def delete_job(job_id: str):
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job.data.get("status") in ("queued", "processing"):
        raise UserError("BUSY", "Cancel the job before deleting it.")
    for p in (config.OUTPUTS_DIR / f"{job_id}.mp4", config.OUTPUTS_DIR / f"{job_id}.jpg"):
        p.unlink(missing_ok=True)
    shutil.rmtree(job.dir, ignore_errors=True)
    with store._lock:
        store._jobs.pop(job_id, None)
    return {"ok": True}


@app.get(f"{P}/api/jobs/{{job_id}}/result")
async def job_result(job_id: str):
    job = store.get(job_id)
    if not job or job.data.get("status") != "completed":
        raise HTTPException(404, "result not ready")
    f = config.OUTPUTS_DIR / f"{job_id}.mp4"
    if not f.is_file():
        raise HTTPException(404, "result missing")
    return FileResponse(f, media_type="video/mp4", filename=f"clipy-{job_id}.mp4")


@app.get(f"{P}/api/jobs/{{job_id}}/poster")
async def job_poster(job_id: str):
    f = config.OUTPUTS_DIR / f"{job_id}.jpg"
    if not f.is_file():
        raise HTTPException(404)
    return FileResponse(f, media_type="image/jpeg")


# ---------------------------------------------------------------- frontend

@app.get("/")
async def root():
    return RedirectResponse(f"{P}/")


if config.FRONTEND_DIST.is_dir():
    app.mount(P or "/", StaticFiles(directory=str(config.FRONTEND_DIST), html=True), name="frontend")
else:
    @app.get(f"{P}/")
    async def no_frontend():
        return JSONResponse({"error": {"code": "NO_FRONTEND", "message": "Frontend is not built.", "hint": "Run setup.bat (it builds clipy/frontend)."}}, status_code=503)
