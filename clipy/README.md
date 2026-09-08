# Clipy — AI Reels Remaker

Local web app: give it a TikTok / Instagram Reels / YouTube Shorts link or an MP4, upload a photo of your face,
and it replaces the main person's face with yours while keeping the original movement, camera, cut, fps,
duration and audio. Optional background replacement. Everything runs on your machine, no paid APIs.

```
TikTok / Reels / MP4 → yt-dlp / upload → FFmpeg normalize → face detection + identity clustering
→ FaceFusion (reference-tracked swap + enhancer + occlusion masks) → optional Robust Video Matting background
→ FFmpeg mux → result.mp4
```

## Quick start (Windows 10/11)

```
git clone <this repo>
cd gudini\clipy
setup.bat
start.bat
```

Open http://localhost:8500/clipy/ — the UI shows `GPU: …` and `Backend: CUDA / DIRECTML / CPU`.

`setup.bat` installs (via winget when missing) git, FFmpeg, curl, Node.js and Python 3.12 (3.11 also works),
creates `.venv`, installs the Python deps, picks the ONNX Runtime flavour (CUDA 12 + cuDNN 9 from pip when an
NVIDIA GPU is present, otherwise DirectML, otherwise CPU), clones FaceFusion 3.9.0 into `engines/facefusion`,
downloads the face models (~1.9 GB) and builds the frontend. Re-run it after updates; it is idempotent.

`setup.bat -Backend cpu` (or `directml`, `cuda`) forces a backend.

## Layout

```
clipy/
  backend/app/            FastAPI app (main.py), jobs.py (queue + logs), pipeline.py (stages),
                          ffmpeg.py, downloader.py (yt-dlp), hardware.py (CUDA → DirectML → CPU), faces.py
  backend/app/engine/     ff_analyze.py (people detection with FaceFusion's models), facefusion_runner.py,
                          background.py (RVM matting), ff_download.py (model pre-download)
  frontend/               React + Vite UI, built to frontend/dist and served under /clipy
  engines/facefusion/     FaceFusion 3.9.0 (cloned by setup)
  data/                   faces/ identities/ sources/ jobs/ outputs/ temp/ models/ logs/ uploads/ backgrounds/
  scripts/smoke_test.py   end-to-end test against a running backend
  setup.ps1 / setup.bat / start.bat
```

Each job has `data/jobs/<id>/job.json` + `log.txt`, its own temp folder under `data/temp/<id>` (removed after
success, failure or cancel) and its result in `data/outputs/<id>.mp4`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/clipy/api/system` | GPU, backend, engine, ffmpeg, yt-dlp, cookies |
| POST | `/clipy/api/uploads/video` | multipart MP4/MOV/WebM → `upload_id` |
| POST | `/clipy/api/sources` | `{url}` or `{upload_id}` → source; analysis job starts (download → prepare → detect people) |
| GET | `/clipy/api/sources/{id}` | status, video info, `persons[]` with thumbnails |
| POST | `/clipy/api/faces` | multipart photo → validated face (exactly one face required) |
| POST | `/clipy/api/identities` | `{name, face_ids[]}` → saved profile ("MY FACE", up to 10 photos) |
| POST | `/clipy/api/uploads/background` | JPEG/PNG/MP4 background |
| POST | `/clipy/api/jobs` | `{source_id, face_ids | identity_id, face_swap, target_person, quality, background}` → `{job_id}` |
| GET | `/clipy/api/jobs/{id}` | `status`, `stage`, `progress`, `stages[]`, `error`, `result` |
| GET | `/clipy/api/jobs/{id}/result` | result.mp4 |
| GET | `/clipy/api/jobs/{id}/logs` | job log lines |
| POST | `/clipy/api/jobs/{id}/cancel` | stops the worker, kills subprocesses, frees temp files |

Quality modes (FaceFusion processors): **Fast** = inswapper_128_fp16, box mask, no enhancer;
**Balanced** = hyperswap_1a_256, GFPGAN 1.4 at 50 %, box + occlusion (XSeg) masks, 5-frame face tracking;
**Best** = hyperswap with 512×512 pixel boost, GFPGAN 70 %, box + occlusion + region masks, 7-frame tracking.
The target person is followed by identity (ArcFace embedding of the person you picked), so the swap never
jumps to another person and resumes when the face comes back into frame.

## Instagram / cookies

Instagram often requires a login for downloads. Export your cookies in Netscape format to
`clipy/data/cookies.txt` (browser extensions like "Get cookies.txt LOCALLY") and retry. Alternatively set
`CLIPY_COOKIES_FROM_BROWSER=chrome` (or `firefox`, `edge`) before `start.bat` and yt-dlp reads the browser
profile. Only public videos can be downloaded without cookies.

## Smoke test

```
start.bat                                   (in one terminal)
.venv\Scripts\python scripts\smoke_test.py --video path\to\clip.mp4 --face path\to\me.jpg --quality fast
```

## Troubleshooting

* `Backend: CPU` with an NVIDIA card — update the driver, then `setup.bat -Backend cuda`.
* `GPU ran out of memory` — switch to Balanced/Fast; the runner already retries with fewer threads and a smaller pixel boost.
* `Instagram requires authentication` — add `data/cookies.txt`.
* Logs: `data/logs/clipy.log`, per job `data/jobs/<id>/log.txt`, and the "Show log" button in the UI.
