# Clipy — AI Reels Remaker. GPU-контейнер: CUDA 12.9 + cuDNN 9 из базового образа NVIDIA,
# FaceFusion 3.9.0 и его модели запечены в образ, данные (лица, исходники, результаты) — в томе /app/data.
#
#   docker compose up -d --build clipy
#
# Стадия 1: сборка фронтенда
FROM node:22-bookworm-slim AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# Стадия 2: рантайм
FROM nvidia/cuda:12.9.1-cudnn-runtime-ubuntu24.04
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# python 3.12, ffmpeg/ffprobe, curl и git нужны FaceFusion; libgl/libglib — для opencv
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ffmpeg curl git ca-certificates libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

# зависимости backend + FaceFusion, onnxruntime с CUDA 12 (пин FaceFusion cuda@12)
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt && pip install onnxruntime-gpu==1.24.4

# движок: FaceFusion 3.9.0 закреплён по тегу
RUN git clone --depth 1 --branch 3.9.0 https://github.com/facefusion/facefusion.git engines/facefusion

# модели (~1.9 ГБ) — отдельным слоем, чтобы правки кода не тянули повторную загрузку
COPY backend/app/engine/ff_download.py backend/app/engine/ff_download.py
RUN python backend/app/engine/ff_download.py --providers cpu

COPY backend ./backend
COPY --from=frontend /fe/dist ./frontend/dist

ENV CLIPY_HOST=0.0.0.0 \
    CLIPY_PORT=8500 \
    CLIPY_DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 8500
CMD ["python", "-m", "uvicorn", "app.main:app", "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8500", "--log-level", "info"]
