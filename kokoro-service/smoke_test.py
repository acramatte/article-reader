"""Real HTTP/WAV checks, executed inside the isolated inference container."""
from concurrent.futures import ThreadPoolExecutor
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import struct
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import wave

BASE = "http://127.0.0.1:8000"
TEXT = "The article reader sends small text chunks to the speech engine. This is a real CPU synthesis test."


def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = Request(BASE + path, data=data, headers={"Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=120) as response:
            return response.status, response.headers, response.read()
    except HTTPError as error:
        return error.code, error.headers, error.read()


def validate_wav(result):
    status, headers, body = result
    assert status == 200, (status, body[:200])
    assert headers.get_content_type() == "audio/wav"
    assert headers["X-Device"] == "cpu"
    assert headers["Cache-Control"] == "no-store"
    with wave.open(io.BytesIO(body)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 24000)
        frames = wav.getnframes()
        pcm = wav.readframes(frames)
    assert len(pcm) == frames * 2 and frames > 0
    samples = struct.unpack(f"<{frames}h", pcm)
    rms = math.sqrt(sum((value / 32768) ** 2 for value in samples) / frames)
    assert rms > 0.001
    seconds = frames / 24000
    assert abs(float(headers["X-Audio-Seconds"]) - seconds) < 0.002
    assert math.isfinite(float(headers["X-RTF"]))
    return {"audio_seconds": seconds, "generation_seconds": float(headers["X-Generation-Seconds"]), "rms": rms}


if __name__ == "__main__":
    deadline = time.monotonic() + 90
    while True:
        try:
            result = request("/health")
            if result[0] == 200:
                break
        except URLError:
            pass
        assert time.monotonic() < deadline, "Service failed to become ready"
        time.sleep(0.25)
    assert json.loads(result[2])["device"] == "cpu"
    assert os.getuid() == 10001
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert importlib.metadata.version("torch").endswith("+cpu")
    assert not any(d.metadata["Name"].lower().startswith("nvidia-") for d in importlib.metadata.distributions())
    measured = []
    for voice in ("af_heart", "af_bella", "af_nicole"):
        measured.append({"voice": voice, **validate_wav(request("/tts", {"text": TEXT, "voice": voice, "speed": 1}))})
    # Root prediction route also supports HF clients that POST to the base URL.
    validate_wav(request("/", {"text": "Hello from the root prediction route.", "voice": "af_heart", "speed": 2}))
    validate_wav(request("/tts", {"text": "Slow speech is supported.", "voice": "af_heart", "speed": 0.5}))
    validate_wav(request("/tts", {"text": (TEXT + " ") * 5, "voice": "af_heart", "speed": 0.5}))
    validate_wav(request("/tts", {"text": ((TEXT + " ") * 20)[:1000], "voice": "af_heart", "speed": 2}))
    for body in (
        {"text": " "}, {"text": "x" * 1001}, {"text": TEXT, "voice": "unknown"},
        {"text": TEXT, "voice": "/tmp/voice.pt"}, {"text": TEXT, "speed": 0.49},
        {"text": TEXT, "speed": 2.01}, {"text": TEXT, "speed": "NaN"},
    ):
        assert request("/tts", body)[0] == 422
    # Simultaneous genuine inference requests: no synthetic model or transport response.
    barrier = threading.Barrier(3)
    def concurrent_request(_):
        barrier.wait()
        return request("/tts", {"text": (TEXT + " ") * 8, "voice": "af_heart", "speed": 1})
    with ThreadPoolExecutor(max_workers=3) as pool:
        responses = list(pool.map(concurrent_request, range(3)))
    assert sorted(response[0] for response in responses) == [200, 200, 429]
    for response in responses:
        if response[0] == 200:
            validate_wav(response)
        else:
            assert response[1]["Retry-After"] == "1"
    validate_wav(request("/tts", {"text": "The engine remains usable after rejecting a busy request."}))
    cgroup = Path("/sys/fs/cgroup/memory.peak")
    events = dict(line.split() for line in Path("/sys/fs/cgroup/memory.events").read_text().splitlines())
    assert int(events["oom"]) == 0 and int(events["oom_kill"]) == 0
    swap_peak = int(Path("/sys/fs/cgroup/memory.swap.peak").read_text())
    assert swap_peak == 0
    print(json.dumps({"voices": measured, "memory_peak_mib": int(cgroup.read_text()) / (1024 * 1024) if cgroup.exists() else None,
                      "swap_peak_bytes": swap_peak, "memory_events": events,
                      "checks": "offline-network startup, real WAVs, all voices, speed boundaries, root route, input validation, concurrent 429, recovery"}, indent=2))
