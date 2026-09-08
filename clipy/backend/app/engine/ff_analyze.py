"""Face analysis on top of FaceFusion's own detector / recognizer, run as a subprocess.

    python ff_analyze.py video --input source.mp4 --out-dir DIR [--max-samples 32] [--providers cuda cpu]
    python ff_analyze.py image --input face.jpg --out-dir DIR [--providers ...]

Prints ONE JSON object on stdout; everything else goes to stderr. Using the engine's models guarantees that
the person we pick here is the same one FaceFusion will match while swapping (same detector, same embeddings).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
FF_DIR = (HERE.parent.parent.parent / "engines" / "facefusion").resolve()


# Сходство эмбеддингов ArcFace: лицо попадает в кластер при таком сходстве с его центроидом,
# кластеры склеиваются при такой средней связи. Склейка должна быть не строже присоединения,
# иначе один человек остаётся разбитым на несколько.
ASSIGN_SIM = 0.42
MERGE_SIM = 0.40


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def fail(code: str, message: str, details: str = "") -> None:
    emit({"ok": False, "code": code, "message": message, "details": details})
    sys.exit(0)


def bootstrap(target_path: str, providers: list[str]) -> None:
    """Initialise FaceFusion state exactly like the CLI does, so the same defaults apply."""
    os.chdir(FF_DIR)
    sys.path.insert(0, str(FF_DIR))
    try:
        import onnxruntime  # noqa

        try:
            onnxruntime.preload_dlls()  # type: ignore[attr-defined]
        except Exception:
            pass
    except Exception:
        pass
    from facefusion import logger, state_manager
    from facefusion.args import apply_args
    from facefusion.program import create_program

    program = create_program()
    argv = [
        "headless-run",
        "--target-path", target_path,
        "--output-path", str(Path(target_path).with_suffix(".analysis.mp4")),
        "--execution-providers", *providers,
        "--face-detector-model", "yolo_face",
        "--face-detector-size", "640x640",
        # 0.35 вместо 0.5: смазанные, мелкие и полуотвёрнутые лица тоже попадают в разбор
        "--face-detector-score", "0.35",
        "--face-landmarker-model", "2dfan4",
        "--face-landmarker-score", "0.5",
        "--log-level", "error",
    ]
    args = vars(program.parse_args(argv))
    apply_args(args, state_manager.init_item)
    logger.init("error")
    from facefusion import face_classifier, face_detector, face_landmarker, face_recognizer

    for module in (face_detector, face_landmarker, face_recognizer, face_classifier):
        if not module.pre_check():
            fail("MODEL_DOWNLOAD", "Не удалось скачать модели лиц.", f"{module.__name__}.pre_check() failed")


def face_to_dict(face, frame_w: int, frame_h: int) -> dict:
    x1, y1, x2, y2 = [float(v) for v in face.bounding_box]
    return {
        "box": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
        "score": round(float(face.score_set.get("detector", 0.0)), 3),
        "landmark_score": round(float(face.score_set.get("landmarker", 0.0)), 3),
        "area_ratio": round(max(0.0, (x2 - x1) * (y2 - y1)) / float(frame_w * frame_h), 4),
        "gender": face.gender,
        "age": list(face.age) if face.age is not None else None,
    }


def crop_thumb(frame, box, path: Path, size: int = 256) -> None:
    import cv2

    h, w = frame.shape[:2]
    x1, y1, x2, y2 = box
    bw, bh = x2 - x1, y2 - y1
    m = 0.45
    cx1 = int(max(0, x1 - bw * m))
    cy1 = int(max(0, y1 - bh * m))
    cx2 = int(min(w, x2 + bw * m))
    cy2 = int(min(h, y2 + bh * m))
    crop = frame[cy1:cy2, cx1:cx2]
    if crop.size == 0:
        crop = frame
    scale = size / max(crop.shape[0], crop.shape[1])
    if scale < 1:
        crop = cv2.resize(crop, (max(1, int(crop.shape[1] * scale)), max(1, int(crop.shape[0] * scale))), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(path), crop, [cv2.IMWRITE_JPEG_QUALITY, 90])


def analyze_video(path: str, out_dir: Path, max_samples: int, providers: list[str]) -> dict:
    import cv2
    import numpy

    bootstrap(path, providers)
    from facefusion.face_creator import get_many_faces

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        fail("CORRUPTED_VIDEO", "Не удалось прочитать видеофайл.")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if total <= 0:
        total = 1
    n = max(1, min(max_samples, total))
    sample_idx = sorted(set(int(round(v)) for v in numpy.linspace(0, total - 1, n)))

    clusters: list[dict] = []  # {centroid, members:[(frame_idx, face)], sum}
    frame_faces: dict[int, list] = {}
    frames_cache: dict[int, object] = {}
    sampled = 0
    for idx in sample_idx:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        sampled += 1
        faces = get_many_faces([frame])
        frame_faces[idx] = faces
        if faces:
            frames_cache[idx] = frame
        for face in faces:
            emb = numpy.asarray(face.embedding_norm, dtype=numpy.float32)
            best, best_sim = None, 0.0
            for c in clusters:
                sim = float(numpy.dot(emb, c["centroid"]))
                if sim > best_sim:
                    best, best_sim = c, sim
            if best is not None and best_sim >= ASSIGN_SIM:
                best["members"].append((idx, face))
                best["sum"] = best["sum"] + emb
                best["centroid"] = best["sum"] / (numpy.linalg.norm(best["sum"]) + 1e-8)
            else:
                clusters.append({"centroid": emb.copy(), "sum": emb.copy(), "members": [(idx, face)]})
        sys.stderr.write(f"frame {idx}: {len(faces)} face(s)\n")
    cap.release()

    # Склейка кластеров одного человека, снятого под разными углами. Средняя связь по всем парам:
    # по центроидам два ракурса одного лица расходятся сильнее, чем два разных человека сближаются,
    # и человек рассыпался на «person_4, person_5, person_6», а порог сходства для замены схлопывался.
    def linkage(a: dict, b: dict) -> float:
        ea = numpy.stack([numpy.asarray(f.embedding_norm, dtype=numpy.float32) for _, f in a["members"]])
        eb = numpy.stack([numpy.asarray(f.embedding_norm, dtype=numpy.float32) for _, f in b["members"]])
        return float(numpy.mean(ea @ eb.T))

    merged = True
    while merged and len(clusters) > 1:
        merged = False
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                # два лица в одном кадре — это точно разные люди, такие кластеры не склеиваем
                frames_i = {m[0] for m in clusters[i]["members"]}
                frames_j = {m[0] for m in clusters[j]["members"]}
                if frames_i & frames_j:
                    continue
                if linkage(clusters[i], clusters[j]) >= MERGE_SIM:
                    clusters[i]["members"].extend(clusters[j]["members"])
                    clusters[i]["sum"] = clusters[i]["sum"] + clusters[j]["sum"]
                    clusters[i]["centroid"] = clusters[i]["sum"] / (numpy.linalg.norm(clusters[i]["sum"]) + 1e-8)
                    del clusters[j]
                    merged = True
                    break
            if merged:
                break

    if not clusters:
        return {"ok": True, "frames_sampled": sampled, "frames_total": total, "fps": fps, "width": width, "height": height, "persons": []}

    # rank: how often present x how large
    def rank(c: dict) -> float:
        frames_seen = len({m[0] for m in c["members"]})
        area = numpy.mean([max(0.0, (f.bounding_box[2] - f.bounding_box[0]) * (f.bounding_box[3] - f.bounding_box[1])) for _, f in c["members"]]) / float(max(1, width * height))
        return frames_seen * (0.3 + float(area))

    clusters.sort(key=rank, reverse=True)

    # «Значимый» человек — тот, кого реально стоит показывать в списке замен: он появляется не в
    # одном кадре или занимает заметную часть экрана. Прохожие и ложные срабатывания на фоне
    # (лицо в 0.1% кадра, один раз) в список не идут и не влияют на порог совпадения.
    def area_of(c: dict) -> float:
        return float(numpy.mean([max(0.0, (f.bounding_box[2] - f.bounding_box[0]) * (f.bounding_box[3] - f.bounding_box[1])) for _, f in c["members"]]) / float(max(1, width * height)))

    def frames_of(c: dict) -> int:
        return len({m[0] for m in c["members"]})

    def significant(c: dict) -> bool:
        return (frames_of(c) >= 2 and frames_of(c) / float(max(1, sampled)) >= 0.02) or area_of(c) >= 0.03

    keep = [c for c in clusters if significant(c)] or clusters[:1]
    dropped = len(clusters) - len(keep)
    if dropped:
        sys.stderr.write(f"skipped {dropped} incidental face(s)\n")
    clusters = keep[:8]

    persons = []
    out_dir.mkdir(parents=True, exist_ok=True)
    for pi, c in enumerate(clusters):
        pid = f"person_{pi + 1}"
        members = c["members"]
        frames_seen = sorted({m[0] for m in members})
        # intra-cluster distance (FaceFusion scale: cosine distance mapped [0,2] -> [0,1])
        intra = [max(0.0, (1.0 - float(numpy.dot(numpy.asarray(f.embedding_norm), c["centroid"]))) / 2.0) for _, f in members]
        inter = 1.0
        for oc in clusters:
            if oc is c:
                continue
            inter = min(inter, max(0.0, (1.0 - float(numpy.dot(c["centroid"], oc["centroid"]))) / 2.0))
        # Опорный кадр. Движок сравнивает все кадры ролика именно с этим лицом, поэтому главное —
        # чтобы оно было самым типичным для человека (ближе всех к центроиду), а не просто крупным:
        # нетипичный ракурс в опоре отсекал половину кадров, и лицо «пропадало».
        def ref_score(item):
            fidx, f = item
            typical = float(numpy.dot(numpy.asarray(f.embedding_norm), c["centroid"]))
            alone = 1.0 if len(frame_faces.get(fidx, [])) == 1 else 0.0
            area = max(0.0, (f.bounding_box[2] - f.bounding_box[0]) * (f.bounding_box[3] - f.bounding_box[1])) / float(max(1, width * height))
            return typical * 4.0 + alone + float(f.score_set.get("landmarker", 0)) + min(area * 10, 1.0)

        ref_idx, ref_face = max(members, key=ref_score)
        ordered = sorted(frame_faces[ref_idx], key=lambda f: float(f.bounding_box[0]))
        position = next((i for i, f in enumerate(ordered) if f is ref_face), 0)
        thumb = out_dir / f"{pid}.jpg"
        crop_thumb(frames_cache[ref_idx], ref_face.bounding_box, thumb)
        numpy.save(out_dir / f"{pid}.npy", c["centroid"])
        persons.append({
            "id": pid,
            "frames_seen": len(frames_seen),
            "coverage": round(len(frames_seen) / float(max(1, sampled)), 3),
            "avg_area_ratio": round(float(numpy.mean([max(0.0, (f.bounding_box[2] - f.bounding_box[0]) * (f.bounding_box[3] - f.bounding_box[1])) for _, f in members]) / float(max(1, width * height))), 4),
            "first_frame": frames_seen[0],
            "last_frame": frames_seen[-1],
            "reference_frame": int(ref_idx),
            "reference_position": int(position),
            "reference_alone": len(frame_faces.get(ref_idx, [])) == 1,
            # разброс лица по кадрам: p85, а не максимум — один нетипичный кадр не должен задирать порог
            "intra_distance": round(float(numpy.percentile(intra, 85)) if intra else 0.0, 3),
            "intra_max": round(float(max(intra)) if intra else 0.0, 3),
            "nearest_other_distance": round(float(inter), 3),
            "coverage_rank": pi,
            "thumbnail": thumb.name,
            "sample": face_to_dict(ref_face, width, height),
        })
    return {"ok": True, "frames_sampled": sampled, "frames_total": total, "fps": fps, "width": width, "height": height, "persons": persons}


def analyze_image(path: str, out_dir: Path, providers: list[str]) -> dict:
    import cv2
    import numpy

    bootstrap(path, providers)
    from facefusion.face_creator import get_many_faces

    frame = cv2.imread(path, cv2.IMREAD_COLOR)
    if frame is None:
        fail("BAD_IMAGE", "Не удалось прочитать фото.", "Подходят файлы JPEG и PNG.")
    h, w = frame.shape[:2]
    faces = get_many_faces([frame])
    out_dir.mkdir(parents=True, exist_ok=True)
    result = {"ok": True, "width": w, "height": h, "faces": [face_to_dict(f, w, h) for f in faces]}
    if len(faces) == 1:
        f = faces[0]
        numpy.save(out_dir / "embedding.npy", numpy.asarray(f.embedding_norm, dtype=numpy.float32))
        crop_thumb(frame, f.bounding_box, out_dir / "thumb.jpg", size=320)
        fw = float(f.bounding_box[2] - f.bounding_box[0])
        result["face_width"] = round(fw, 1)
        result["warnings"] = ["Лицо на фото мелкое, для лучшего качества возьмите фото крупнее."] if fw < 120 else []
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["video", "image"])
    ap.add_argument("--input", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--max-samples", type=int, default=32)
    ap.add_argument("--providers", nargs="+", default=["cpu"])
    a = ap.parse_args()
    try:
        if a.mode == "video":
            emit(analyze_video(a.input, Path(a.out_dir), a.max_samples, a.providers))
        else:
            emit(analyze_image(a.input, Path(a.out_dir), a.providers))
    except SystemExit:
        raise
    except Exception as e:  # noqa
        traceback.print_exc(file=sys.stderr)
        fail("ANALYSIS_FAILED", "Не удалось разобрать лица.", f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
