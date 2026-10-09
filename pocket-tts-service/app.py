import io
import logging
import os
from pathlib import Path
import threading
import time
from typing import Literal

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pocket_tts import TTSModel
from pydantic import BaseModel, ConfigDict, Field

# Pocket's generation logger includes input text at INFO; never log article contents.
logging.getLogger("pocket_tts").setLevel(logging.ERROR)
torch.set_num_threads(int(os.getenv("POCKET_TTS_THREADS", "2")))
torch.set_num_interop_threads(1)
assets = Path(os.getenv("POCKET_TTS_MODEL_DIR", "/opt/pocket-tts"))
languages = {"jane": "english", "bill_boerst": "english", "estelle": "french"}
started = time.perf_counter()
models = {language: TTSModel.load_model(config=assets / f"{language}.yaml", quantize=True)
          for language in dict.fromkeys(languages.values())}
states = {voice: models[language].get_state_for_audio_prompt(
    assets / "languages" / language / "embeddings" / f"{voice}.safetensors")
    for voice, language in languages.items()}
print(f"Pocket TTS CPU models and voices loaded in {time.perf_counter() - started:.2f}s")

# Models are not thread-safe. Bound both active work and stop/restart overlap.
inference_lock = threading.Lock()
admission = threading.BoundedSemaphore(2)


class TTSRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=1_000, pattern=r"[\p{L}\p{N}]")
    voice: Literal["jane", "bill_boerst", "estelle"] = "jane"
    # Only the reader's MP3 encoder adjusts tempo. Reject rather than ignore speed.
    speed: Literal[1.0] = 1.0


app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok", "device": "cpu", "engine": "pocket-tts", "voices": list(languages)}


@app.post("/")
@app.post("/tts")
def tts(request: TTSRequest):
    if not admission.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Speech engine is busy", headers={"Retry-After": "1"})
    try:
        # Pocket manages no_grad in its own generation threads. InferenceMode is
        # thread-local and would make their mutable KV caches unusable.
        with inference_lock:
            started = time.perf_counter()
            try:
                # copy_state=True keeps each request independent of previous narration.
                audio = models[languages[request.voice]].generate_audio(states[request.voice], request.text, copy_state=True)
                samples = audio.detach().cpu().numpy()
            except Exception as error:
                raise HTTPException(status_code=500, detail="Speech synthesis failed") from error
            generation_seconds = time.perf_counter() - started
            if samples.ndim != 1 or not samples.size or not np.isfinite(samples).all():
                raise HTTPException(status_code=500, detail="Pocket TTS produced invalid audio")
            audio_seconds = samples.size / 24_000
            buffer = io.BytesIO()
            sf.write(buffer, samples, 24_000, format="WAV", subtype="PCM_16")
            return Response(content=buffer.getvalue(), media_type="audio/wav", headers={
                "Cache-Control": "no-store",
                "X-Generation-Seconds": f"{generation_seconds:.3f}",
                "X-Audio-Seconds": f"{audio_seconds:.3f}",
                "X-RTF": f"{generation_seconds / audio_seconds:.3f}",
                "X-Device": "cpu",
            })
    finally:
        admission.release()
