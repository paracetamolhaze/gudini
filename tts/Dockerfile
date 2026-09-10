# Стенд озвучки — Chatterbox Multilingual V3 на GPU.
#
#   docker compose build tts && docker compose up -d tts
#
# Базовый образ обычный python, а не CUDA: колесо torch с PyPI везёт свои библиотеки CUDA,
# а драйвер в контейнер пробрасывает NVIDIA Container Toolkit. Так образ на пару гигабайт легче,
# чем у clipy, где CUDA нужна самому FaceFusion.
#
# Веса модели (~3 ГБ) НЕ запекаются в образ: они скачиваются при первой загрузке в том
# tts-data (HF_HOME), поэтому пересборка кода их не трогает.
FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ffmpeg приводит присланные образцы голоса к моно-wav; libsndfile нужен librosa внутри
# Chatterbox; git — потому что и сам Chatterbox, и его водяной знак Perth ставятся из репозиториев
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# torch отдельным слоем и раньше остального: он весит 2,5 ГБ, и обновление Chatterbox
# не должно тянуть его заново. Кэш pip живёт в BuildKit, а не в образе.
RUN --mount=type=cache,target=/root/.cache/pip pip install torch==2.6.0 torchaudio==2.6.0

COPY requirements.txt ./requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

COPY app ./app

ENV TTS_DATA_DIR=/app/data \
    TTS_DEVICE=cuda \
    TTS_T3_MODEL=v3 \
    HF_HOME=/app/data/hf
VOLUME ["/app/data"]
EXPOSE 8600
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8600", "--log-level", "info"]
