# Clipy — AI Reels Remaker (вкладка /clipy сайта Гудини)

Ссылка на TikTok / Instagram Reels / YouTube Shorts или свой MP4 + фото своего лица → тот же ролик, где
лица выбранных людей заменены на ваши. Движения, камера, монтаж, fps, длительность и звук сохраняются.
Опционально заменяется фон. Всё работает локально на GPU, платных API нет.

```
TikTok / Reels / MP4 → yt-dlp / upload → FFmpeg normalize → детекция и кластеризация людей
→ FaceFusion (трекинг по эмбеддингу выбранного человека, occlusion-маски, enhancer)
→ опционально Robust Video Matting (фон) → FFmpeg mux → result.mp4
```

## Запуск (Docker, вместе с Гудини)

Clipy — сервис `clipy` в корневом `docker-compose.yml`, стартует вместе с сайтом:

```
docker compose up -d --build                    # сайт, воркер и clipy
docker compose --profile public up -d --build   # плюс Caddy: https://<домен>/clipy
```

Адреса: дома `http://192.168.1.68:3000/clipy` (сайт проксирует в контейнер) или напрямую
`http://192.168.1.68:8500/clipy`, снаружи `https://gudinijr.duckdns.org/clipy`. В шапке сайта есть вкладка «Clipy».

Вход тот же, что у сайта: при заданном `SITE_PASSWORD` принимается cookie `gudini_auth` сайта или своя
страница `/clipy/login`; при пустом пароле всё открыто. Образ (~8 ГБ: CUDA 12.9 + cuDNN 9, FaceFusion 3.9.0
с моделями) и том `clipy-data` лежат в хранилище Docker (диск D), а не в папке репозитория.

GPU пробрасывается через `deploy.resources.reservations.devices` (Docker Desktop + WSL2 + драйвер NVIDIA).
В интерфейсе видно `GPU: …` и `Backend: CUDA`; без GPU контейнер работает на CPU (медленно).

## Запуск без Docker (Windows, запасной вариант)

```
cd clipy
setup.bat        # venv, onnxruntime-gpu + CUDA из pip, FaceFusion 3.9.0, модели, сборка фронтенда
start.bat        # http://localhost:8500/clipy/
```

`setup.bat` ставит через winget недостающие git, FFmpeg, curl, Node.js и Python 3.12 (3.11 тоже работает).
`setup.bat -Backend cpu|directml|cuda` задаёт бэкенд принудительно. Пароль для доступа не с localhost —
`CLIPY_PASSWORD` в `clipy/.env`.

## Структура

```
clipy/
  Dockerfile              node-стадия (фронтенд) + nvidia/cuda runtime (python 3.12, ffmpeg, FaceFusion, модели)
  backend/app/            main.py (FastAPI, /clipy/api/*, статика, вход), jobs.py (очередь, логи),
                          pipeline.py (стадии), ffmpeg.py, downloader.py (yt-dlp), hardware.py, faces.py
  backend/app/engine/     ff_analyze.py (люди в видео на моделях FaceFusion), facefusion_runner.py,
                          background.py (RVM), ff_download.py (модели)
  frontend/               React + Vite, отдаётся под /clipy
  data/                   том: faces/ identities/ sources/ jobs/ outputs/ temp/ models/ logs/ cookies.txt
  scripts/smoke_test.py   сквозной тест против работающего backend
```

У каждой задачи `data/jobs/<id>/job.json` и `log.txt`, своя temp-папка (удаляется после успеха, ошибки и
отмены), результат в `data/outputs/<id>.mp4`.

## API

| Метод | Путь | Что делает |
| --- | --- | --- |
| GET | `/clipy/api/system` | GPU, backend, движок, ffmpeg, yt-dlp, cookies |
| POST | `/clipy/api/uploads/video` | multipart MP4/MOV/WebM → `upload_id` |
| POST | `/clipy/api/sources` | `{url}` или `{upload_id}` → источник; задача анализа (скачать → подготовить → найти людей) |
| GET | `/clipy/api/sources/{id}` | статус, параметры видео, `persons[]` с миниатюрами |
| POST | `/clipy/api/faces` | multipart фото → проверенное лицо (ровно одно лицо) |
| POST | `/clipy/api/identities` | `{name, face_ids[]}` → профиль «MY FACE» (до 10 фото) |
| POST | `/clipy/api/uploads/background` | JPEG/PNG/MP4 фон |
| POST | `/clipy/api/jobs` | `{source_id, assignments: [{person, face_ids | identity_id}], background}` → `{job_id}` |
| GET | `/clipy/api/jobs/{id}` | `status`, `stage`, `progress`, `stages[]`, `error`, `result` |
| GET | `/clipy/api/jobs/{id}/result` | result.mp4 |
| GET | `/clipy/api/jobs/{id}/logs` | строки лога задачи |
| POST | `/clipy/api/jobs/{id}/cancel` | остановить воркер, убить подпроцессы, освободить temp |

Качество одно, максимальное: hyperswap_1a_256 с прорисовкой 512×512, GFPGAN 1.4 на 70 %, маски
box + occlusion (XSeg) + region, решение по 9 кадрам подряд. Человек ведётся по отпечатку лица (ArcFace)
выбранного человека, поэтому замена не перескакивает на других и возобновляется, когда лицо возвращается
в кадр. Порог совпадения считается из разброса лица самого человека по кадрам и ограничивается только
заметными другими людьми, случайные лица на фоне на него не влияют.

Замен может быть несколько: каждому человеку в кадре назначается своё лицо, и Clipy делает по проходу
на каждого, отдавая результат предыдущего прохода в следующий. Промежуточные проходы кодируются почти
без потерь, время растёт пропорционально числу замен.

## Instagram и cookies

Instagram часто требует вход. Экспортируйте cookies в формате Netscape в `data/cookies.txt` (в Docker —
внутрь тома: `docker cp cookies.txt gudini-clipy:/app/data/cookies.txt`) и повторите. Без cookies
скачиваются только публичные ролики.

## Smoke-тест

```
python scripts/smoke_test.py --video clip.mp4 --face me.jpg --base http://127.0.0.1:8500/clipy/api
```

## Если что-то не так

* `Backend: CPU` при наличии NVIDIA — проверьте `docker run --rm --gpus all nvidia/cuda:12.9.1-base-ubuntu24.04 nvidia-smi`.
* «Видеокарте не хватило памяти» — раннер сам повторяет с меньшим числом потоков и меньшей прорисовкой; помогает закрыть другие программы, использующие видеокарту.
* «Instagram требует входа в аккаунт» — добавьте `cookies.txt`.
* Логи: `docker logs gudini-clipy`, в томе `data/logs/clipy.log`, у задачи `data/jobs/<id>/log.txt`, кнопка «Показать журнал» в интерфейсе.
