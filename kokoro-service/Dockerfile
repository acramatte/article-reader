FROM python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_IMPLICIT_TOKEN=1 HF_HUB_DISABLE_TELEMETRY=1 \
    KOKORO_DEVICE=cpu KOKORO_THREADS=2 KOKORO_MODEL_DIR=/opt/kokoro \
    HF_HOME=/tmp/huggingface HOME=/tmp
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 espeak-ng \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install -r requirements.txt && pip check
COPY prepare_assets.py ./
RUN python prepare_assets.py /opt/kokoro
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
COPY app.py ./
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin inference
USER inference
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "8", "--no-access-log"]
