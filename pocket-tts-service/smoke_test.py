"""Real HTTP/WAV checks. --local skips container-only checks for a local Python service."""
import argparse
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


def validate_wav(result, text):
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
    seconds = frames / 24000
    # A generous bound for these fixed narrative passages catches runaway output,
    # even when it is valid PCM and non-silent. This is not a speech-quality test.
    assert seconds <= len(text) * 0.25, f"Implausible WAV duration: {seconds:.3f}s for {len(text)} characters"
    samples = struct.unpack(f"<{frames}h", pcm)
    rms = math.sqrt(sum((value / 32768) ** 2 for value in samples) / frames)
    assert rms > 0.001
    assert abs(float(headers["X-Audio-Seconds"]) - seconds) < 0.002
    assert math.isfinite(float(headers["X-RTF"]))
    return {"audio_seconds": seconds, "generation_seconds": float(headers["X-Generation-Seconds"]), "rms": rms}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local", action="store_true")
    args = parser.parse_args()
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
    assert json.loads(result[2])["voices"] == ["jane", "bill_boerst", "estelle"]
    if not args.local:
        assert os.getuid() == 10001
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert importlib.metadata.version("torch").endswith("+cpu")
    assert not any(d.metadata["Name"].lower().startswith("nvidia-") for d in importlib.metadata.distributions())
    quick = os.environ.get("POCKET_TTS_SMOKE_MODE") == "quick"
    voices = ("jane", "bill_boerst", "estelle")
    text = "Hello from Pocket TTS." if quick else TEXT
    measured = []
    for voice in voices:
        voice_text = "Bonjour, cet article est lu en français. Ceci est un véritable test de synthèse vocale." if voice == "estelle" else text
        measured.append({"voice": voice, **validate_wav(request("/tts", {"text": voice_text, "voice": voice, "speed": 1}), voice_text)})
    if not quick:
        # Root prediction route also supports HF clients that POST to the base URL.
        root_text = "Hello from the root prediction route."
        validate_wav(request("/", {"text": root_text, "voice": "jane", "speed": 1}), root_text)
        long_text = ((TEXT + " ") * 20)[:1000]
        validate_wav(request("/tts", {"text": long_text, "voice": "jane", "speed": 1}), long_text)
    for body in (
        {"text": " "}, {"text": "«»“”()[] — *** 🎵", "voice": "estelle"},
        {"text": "x" * 1001}, {"text": TEXT, "voice": "unknown"}, {"text": TEXT, "voice": "af_bella"},
        *({"text": TEXT, "voice": voice} for voice in ("af_heart", "af_nicole", "am_michael", "ff_siwis")),
        {"text": TEXT, "voice": "/tmp/voice.pt"}, {"text": TEXT, "speed": 0.49},
        {"text": TEXT, "speed": 0.5}, {"text": TEXT, "speed": 2},
        {"text": TEXT, "speed": 2.01}, {"text": TEXT, "speed": "NaN"}, {"text": TEXT, "reference_audio": "file.wav"},
    ):
        assert request("/tts", body)[0] == 422
    if not quick:
        # Simultaneous genuine inference requests: no synthetic model or transport response.
        barrier = threading.Barrier(3)
        concurrent_text = (TEXT + " ") * 3
        def concurrent_request(_):
            barrier.wait()
            return request("/tts", {"text": concurrent_text, "voice": "jane", "speed": 1})
        with ThreadPoolExecutor(max_workers=3) as pool:
            responses = list(pool.map(concurrent_request, range(3)))
        assert sorted(response[0] for response in responses) == [200, 200, 429]
        for response in responses:
            if response[0] == 200:
                validate_wav(response, concurrent_text)
            else:
                assert response[1]["Retry-After"] == "1"
        recovery_text = "The engine remains usable after rejecting a busy request."
        validate_wav(request("/tts", {"text": recovery_text}), recovery_text)
    repeated = []
    if not quick:
        for i in range(30):
            voice = voices[i % len(voices)]
            text = ("Bonjour, cet article présente les découvertes scientifiques de la semaine. " if voice == "estelle" else TEXT + " ") * (1 + i % 5)
            result = {"voice": voice, **validate_wav(request("/tts", {"text": text, "voice": voice}), text)}
            if not args.local:
                result["cgroup_memory_mib"] = int(Path("/sys/fs/cgroup/memory.current").read_text()) / 1024**2
            repeated.append(result)
    memory = {}
    if not args.local:
        events = dict(line.split() for line in Path("/sys/fs/cgroup/memory.events").read_text().splitlines())
        assert int(events["oom"]) == 0 and int(events["oom_kill"]) == 0
        # Older cgroup-v2 kernels lack swap.peak. The hard zero swap limit
        # still proves the no-swap contract rather than silently skipping it.
        assert Path("/sys/fs/cgroup/memory.swap.max").read_text().strip() == "0"
        assert int(Path("/sys/fs/cgroup/memory.swap.current").read_text()) == 0
        swap_path = Path("/sys/fs/cgroup/memory.swap.peak")
        swap_peak = int(swap_path.read_text()) if swap_path.exists() else None
        assert swap_peak in (None, 0)
        memory = {"memory_peak_mib": int(Path("/sys/fs/cgroup/memory.peak").read_text()) / 1024**2,
                  "swap_peak_bytes": swap_peak, "memory_events": events}
    print(json.dumps({"voices": measured, "repeated": repeated, **memory,
                      "mode": "quick" if quick else "full", "container_checks": not args.local,
                      "checks": "real WAVs, all voices, input validation" if quick else "real WAVs, all voices, root route, input validation, concurrent 429, recovery, 30 repeated mixed-language requests"}, indent=2))
