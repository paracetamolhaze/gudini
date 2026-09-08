"""End-to-end smoke test against a running Clipy backend.

    python scripts/smoke_test.py --video path/to/source.mp4 --face path/to/face.jpg [--base http://127.0.0.1:8500/clipy/api]

Uploads the video, waits for the analysis, uploads the face, submits a job, waits for it, downloads result.mp4
and checks duration / fps / audio against the source.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

try:
    import requests  # type: ignore
except ImportError:  # keep the test dependency-free: tiny multipart helper
    requests = None


def http(method: str, url: str, data: bytes | None = None, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
        body = e.read().decode("utf-8", "replace")
        raise SystemExit(f"HTTP {e.code} {url}: {body[:800]}")


def post_json(url: str, obj: dict) -> dict:
    return http("POST", url, json.dumps(obj).encode("utf-8"), {"Content-Type": "application/json"})


def post_file(url: str, path: Path) -> dict:
    boundary = "----clipy" + str(int(time.time() * 1000))
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{path.name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    ).encode("utf-8") + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode("utf-8")
    return http("POST", url, body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)], capture_output=True, text=True).stdout
    return json.loads(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--face", required=True)
    ap.add_argument("--base", default="http://127.0.0.1:8500/clipy/api")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    base = a.base.rstrip("/")

    sysinfo = http("GET", f"{base}/system")
    print("system:", sysinfo["hardware"]["gpu_name"], sysinfo["hardware"]["backend"], "engine installed:", sysinfo["engine"]["installed"])

    t0 = time.time()
    up = post_file(f"{base}/uploads/video", Path(a.video))
    print("uploaded:", up["info"]["width"], "x", up["info"]["height"], up["info"]["fps"], "fps", up["info"]["duration"], "s")
    src = post_json(f"{base}/sources", {"upload_id": up["upload_id"]})
    while src["status"] in ("queued", "processing"):
        time.sleep(1.0)
        src = http("GET", f"{base}/sources/{src['id']}")
        job = src.get("job") or {}
        print(f"  analysis: {job.get('stage_label')} {job.get('progress')}%", end="\r")
    print()
    if src["status"] != "ready":
        print("analysis failed:", src.get("error"))
        return 1
    print(f"analysis ok in {time.time() - t0:.1f}s, persons:", [(p["id"], p["frames_seen"], p["coverage"]) for p in src["persons"]])

    face = post_file(f"{base}/faces", Path(a.face))["face"]
    print("face:", face["id"], "warnings:", face["warnings"])

    job = post_json(f"{base}/jobs", {"source_id": src["id"], "assignments": [{"person": "auto", "face_ids": [face["id"]]}]})["job"]
    print("job:", job["id"])
    t1 = time.time()
    last = ""
    while job["status"] in ("queued", "processing"):
        time.sleep(1.0)
        job = http("GET", f"{base}/jobs/{job['id']}")
        line = f"  {job.get('stage_label')} {job.get('progress')}%"
        if line != last:
            print(line)
            last = line
    print("job status:", job["status"], f"in {time.time() - t1:.1f}s")
    logs = http("GET", f"{base}/jobs/{job['id']}/logs?n=40")["lines"]
    print("\n".join("  | " + l for l in logs[-15:]))
    if job["status"] != "completed":
        print("error:", job.get("error"))
        return 1
    out = Path(a.out) if a.out else Path("result-smoke.mp4")
    with urllib.request.urlopen(f"{base}/jobs/{job['id']}/result", timeout=600) as r:
        out.write_bytes(r.read())
    p = probe(out)
    v = next(s for s in p["streams"] if s["codec_type"] == "video")
    has_audio = any(s["codec_type"] == "audio" for s in p["streams"])
    src_info = up["info"]
    dur = float(p["format"]["duration"])
    print(f"result: {out} {v['width']}x{v['height']} {v.get('avg_frame_rate')} dur={dur:.2f}s audio={has_audio}")
    ok = abs(dur - float(src_info["duration"])) < 0.6 and v["width"] == src_info["width"] and v["height"] == src_info["height"] and (has_audio == bool(src_info["has_audio"]))
    print("CHECK", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
