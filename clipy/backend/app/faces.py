"""Face photos and identity profiles ("MY FACE" = a named set of 1..10 photos of one person)."""
from __future__ import annotations

import json
import shutil
import threading
from pathlib import Path
from typing import Optional

from . import config
from .errors import UserError
from .jobs import new_id, now_iso
from .pipeline import run_analysis_script

MAX_PHOTOS_PER_IDENTITY = 10


def face_dir(face_id: str) -> Path:
    return config.FACES_DIR / face_id


def load_face(face_id: str) -> Optional[dict]:
    f = face_dir(face_id) / "face.json"
    if not f.is_file():
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except ValueError:
        return None


def list_faces() -> list[dict]:
    items = []
    for f in config.FACES_DIR.glob("*/face.json"):
        try:
            items.append(json.loads(f.read_text(encoding="utf-8")))
        except ValueError:
            continue
    return sorted(items, key=lambda d: d.get("created_at", ""), reverse=True)


def register_face(photo_tmp: Path, original_name: str, log) -> dict:
    """Validate the photo with the engine's detector: exactly one face required."""
    face_id = new_id("f")
    d = face_dir(face_id)
    d.mkdir(parents=True, exist_ok=True)
    photo = d / ("photo" + photo_tmp.suffix.lower())
    shutil.move(str(photo_tmp), str(photo))
    try:
        res = run_analysis_script("image", photo, d, threading.Event(), log)
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    faces = res.get("faces", [])
    if len(faces) == 0:
        shutil.rmtree(d, ignore_errors=True)
        raise UserError("NO_FACE_IN_PHOTO", "На фото не найдено лицо.", "Возьмите резкое, хорошо освещённое фото, где лицо видно целиком.", status=422)
    if len(faces) > 1:
        shutil.rmtree(d, ignore_errors=True)
        raise UserError("MANY_FACES_IN_PHOTO", f"На фото найдено несколько лиц: {len(faces)}.", "Нужно фото, где только ваше лицо.", status=422)
    data = {
        "id": face_id,
        "created_at": now_iso(),
        "original_name": original_name[:120],
        "file": str(photo),
        "thumb": str(d / "thumb.jpg"),
        "width": res.get("width"),
        "height": res.get("height"),
        "face_width": res.get("face_width"),
        "warnings": res.get("warnings", []),
        "box": faces[0].get("box"),
    }
    (d / "face.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def delete_face(face_id: str) -> bool:
    d = face_dir(face_id)
    if not d.is_dir():
        return False
    shutil.rmtree(d, ignore_errors=True)
    return True


# ---------------------------------------------------------------- identities

def identity_file(identity_id: str) -> Path:
    return config.IDENTITIES_DIR / f"{identity_id}.json"


def list_identities() -> list[dict]:
    items = []
    for f in config.IDENTITIES_DIR.glob("*.json"):
        try:
            items.append(json.loads(f.read_text(encoding="utf-8")))
        except ValueError:
            continue
    return sorted(items, key=lambda d: d.get("created_at", ""), reverse=True)


def load_identity(identity_id: str) -> Optional[dict]:
    f = identity_file(identity_id)
    if not f.is_file():
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except ValueError:
        return None


def create_identity(name: str, face_ids: list[str]) -> dict:
    name = (name or "").strip()[:60] or "My face"
    face_ids = [f for f in dict.fromkeys(face_ids) if load_face(f)]
    if not face_ids:
        raise UserError("NO_PHOTOS", "Добавьте в профиль хотя бы одно фото.")
    if len(face_ids) > MAX_PHOTOS_PER_IDENTITY:
        raise UserError("TOO_MANY_PHOTOS", f"В профиле может быть не больше {MAX_PHOTOS_PER_IDENTITY} фото.")
    ident = {"id": new_id("i"), "name": name, "face_ids": face_ids, "created_at": now_iso()}
    config.IDENTITIES_DIR.mkdir(parents=True, exist_ok=True)
    identity_file(ident["id"]).write_text(json.dumps(ident, ensure_ascii=False, indent=2), encoding="utf-8")
    return ident


def update_identity(identity_id: str, name: Optional[str], face_ids: Optional[list[str]]) -> dict:
    ident = load_identity(identity_id)
    if not ident:
        raise UserError("NOT_FOUND", "Профиль не найден.", status=404)
    if name is not None:
        ident["name"] = name.strip()[:60] or ident["name"]
    if face_ids is not None:
        face_ids = [f for f in dict.fromkeys(face_ids) if load_face(f)]
        if not face_ids:
            raise UserError("NO_PHOTOS", "В профиле должно остаться хотя бы одно фото.")
        if len(face_ids) > MAX_PHOTOS_PER_IDENTITY:
            raise UserError("TOO_MANY_PHOTOS", f"В профиле может быть не больше {MAX_PHOTOS_PER_IDENTITY} фото.")
        ident["face_ids"] = face_ids
    ident["updated_at"] = now_iso()
    identity_file(identity_id).write_text(json.dumps(ident, ensure_ascii=False, indent=2), encoding="utf-8")
    return ident


def delete_identity(identity_id: str) -> bool:
    f = identity_file(identity_id)
    if not f.is_file():
        return False
    f.unlink()
    return True


def photos_for(face_ids: list[str]) -> list[Path]:
    photos = []
    for fid in face_ids:
        face = load_face(fid)
        if face and Path(face["file"]).is_file():
            photos.append(Path(face["file"]))
    return photos
