import io
import os
import time
import threading

import numpy as np
import soundfile as sf
import torch

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from pathlib import Path
from typing import Literal

from kokoro import KModel, KPipeline


SAMPLE_RATE = 24_000

requested_device = os.getenv("KOKORO_DEVICE", "auto")

if requested_device == "auto":
    device = "cuda" if torch.cuda.is_available() else "cpu"
else:
    device = requested_device

print(f"Kokoro device: {device}")
print(f"PyTorch version: {torch.__version__}")
print(f"ROCm/HIP version: {torch.version.hip}")

if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")

print("Loading Kokoro...")

load_started = time.perf_counter()

# Set after model imports; native libraries may otherwise override thread settings.
torch.set_num_threads(int(os.getenv("KOKORO_THREADS", "2")))
torch.set_num_interop_threads(1)
model_dir = os.getenv("KOKORO_MODEL_DIR")
if model_dir:
    assets = Path(model_dir)
    model = KModel(
        repo_id="hexgrad/Kokoro-82M",
        config=str(assets / "config.json"),
        model=str(assets / "kokoro-v1_0.pth"),
    ).to(device).eval()
    pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", model=model)
    for voice in ("af_heart", "af_bella", "af_nicole"):
        pipeline.voices[voice] = pipeline.load_single_voice(str(assets / "voices" / f"{voice}.pt"))
else:
    # Preserve the existing local-development path; the image always sets model_dir.
    pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device=device)

print(
    f"Kokoro loaded in "
    f"{time.perf_counter() - load_started:.2f}s"
)

# One active synthesis and at most one waiting request (including stop/restart overlap).
inference_lock = threading.Lock()
admission = threading.BoundedSemaphore(2)


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1_000, pattern=r"\S")
    voice: Literal["af_heart", "af_bella", "af_nicole"] = "af_heart"
    speed: float = Field(default=1.0, ge=0.5, le=2.0, allow_inf_nan=False)


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-Generation-Seconds",
        "X-Audio-Seconds",
        "X-RTF",
        "X-Device",
    ],
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": device,
        "torch_cuda_available": torch.cuda.is_available(),
        "torch_hip_version": torch.version.hip,
        "gpu": (
            torch.cuda.get_device_name(0)
            if torch.cuda.is_available()
            else None
        ),
    }


@app.post("/")
@app.post("/tts")
def tts(request: TTSRequest):
    if not admission.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Speech engine is busy", headers={"Retry-After": "1"})
    inference_lock.acquire()
    try:
        started = time.perf_counter()
        chunks = []
        try:
            for result in pipeline(request.text, voice=request.voice, speed=request.speed):
                if result.audio is not None:
                    chunks.append(result.audio.detach().cpu().numpy())
        except Exception as error:
            # Do not return upstream exceptions containing request text or internal paths.
            raise HTTPException(status_code=500, detail="Speech synthesis failed") from error
        generation_seconds = time.perf_counter() - started
        if not chunks:
            raise HTTPException(status_code=500, detail="Kokoro produced no audio")
        samples = np.concatenate(chunks)
        if not np.isfinite(samples).all():
            raise HTTPException(status_code=500, detail="Kokoro produced invalid audio")
        audio_seconds = len(samples) / SAMPLE_RATE
        if audio_seconds <= 0:
            raise HTTPException(status_code=500, detail="Kokoro produced empty audio")
        buffer = io.BytesIO()
        sf.write(buffer, samples, SAMPLE_RATE, format="WAV", subtype="PCM_16")
        return Response(
            content=buffer.getvalue(),
            media_type="audio/wav",
            headers={
                "Cache-Control": "no-store",
                "X-Generation-Seconds": f"{generation_seconds:.3f}",
                "X-Audio-Seconds": f"{audio_seconds:.3f}",
                "X-RTF": f"{generation_seconds / audio_seconds:.3f}",
                "X-Device": device,
            },
        )
    finally:
        inference_lock.release()
        admission.release()
