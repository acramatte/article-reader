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

from kokoro import KPipeline


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

pipeline = KPipeline(
    lang_code="a",
    device=device,
)

print(
    f"Kokoro loaded in "
    f"{time.perf_counter() - load_started:.2f}s"
)

# Avoid overlapping inference while we're just benchmarking.
inference_lock = threading.Lock()


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)
    voice: str = "af_heart"
    speed: float = Field(default=1.0, gt=0.25, lt=4.0)


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


@app.post("/tts")
def tts(request: TTSRequest):
    with inference_lock:
        started = time.perf_counter()

        chunks = []

        try:
            generator = pipeline(
                request.text,
                voice=request.voice,
                speed=request.speed,
            )

            for result in generator:
                audio = result.audio

                if audio is not None:
                    chunks.append(
                        audio.detach().cpu().numpy()
                    )

        except Exception as error:
            raise HTTPException(
                status_code=500,
                detail=str(error),
            ) from error

        generation_seconds = (
            time.perf_counter() - started
        )

    if not chunks:
        raise HTTPException(
            status_code=500,
            detail="Kokoro produced no audio",
        )

    samples = np.concatenate(chunks)

    audio_seconds = len(samples) / SAMPLE_RATE

    rtf = (
        generation_seconds / audio_seconds
        if audio_seconds > 0
        else float("inf")
    )

    buffer = io.BytesIO()

    sf.write(
        buffer,
        samples,
        SAMPLE_RATE,
        format="WAV",
        subtype="PCM_16",
    )

    print()
    print(f"Voice:      {request.voice}")
    print(f"Characters: {len(request.text)}")
    print(f"Device:     {device}")
    print(f"Generation: {generation_seconds:.2f}s")
    print(f"Audio:      {audio_seconds:.2f}s")
    print(f"RTF:        {rtf:.2f}x")
    print()

    return Response(
        content=buffer.getvalue(),
        media_type="audio/wav",
        headers={
            "X-Generation-Seconds":
                f"{generation_seconds:.3f}",
            "X-Audio-Seconds":
                f"{audio_seconds:.3f}",
            "X-RTF":
                f"{rtf:.3f}",
            "X-Device":
                device,
        },
    )
