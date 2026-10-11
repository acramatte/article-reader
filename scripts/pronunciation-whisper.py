"""Batch ASR helper for pronunciation.mjs; ffmpeg avoids av's audio decoder."""
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel

manifest_path = Path(sys.argv[1]).resolve()
directory = manifest_path.parent
manifest = json.loads(manifest_path.read_text())
model = WhisperModel(manifest["model"], device="cpu", compute_type="int8", cpu_threads=2, num_workers=1)
tokenizer = model.hf_tokenizer
digit_ids = [token_id for token, token_id in tokenizer.get_vocab().items()
             if any(character.isdigit() for character in token)]
leading_silence_seconds = 0.5
(directory / "whisper.json").write_text(json.dumps({
    "faster_whisper": importlib.metadata.version("faster-whisper"),
    "model": manifest["model"], "compute_type": "int8", "cpu_threads": 2,
    "leading_silence_seconds": leading_silence_seconds,
    "digit_tokens_suppressed": len(digit_ids), "beam_size": 5,
    "unsuppressed_diagnostic": manifest.get("asrDiagnostic", False),
    "unsuppressed_cases": [case["id"] for case in manifest["cases"] if case.get("asr") == "unsuppressed"],
}, indent=2) + "\n")
transcripts = []
for recording in manifest["recordings"]:
    pieces = []
    diagnostic = []
    for filename in recording["files"]:
        decoded = subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-i", str(directory / filename),
            "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1",
        ], check=True, stdout=subprocess.PIPE).stdout
        audio = np.frombuffer(decoded, dtype="<f4").copy()
        if not audio.size or not np.isfinite(audio).all():
            raise ValueError(f"Invalid decoded audio: {filename}")
        audio = np.pad(audio, (int(16000 * leading_silence_seconds), 0))
        segments, _ = model.transcribe(
            audio, language=recording["language"], beam_size=5,
            suppress_tokens=[-1] + digit_ids, condition_on_previous_text=False,
            vad_filter=False,
        )
        pieces.append(" ".join(segment.text.strip() for segment in segments))
        if manifest.get("asrDiagnostic", False) or recording.get("asr") == "unsuppressed":
            segments, _ = model.transcribe(
                audio, language=recording["language"], beam_size=5,
                suppress_tokens=[-1], condition_on_previous_text=False, vad_filter=False,
            )
            diagnostic.append(" ".join(segment.text.strip() for segment in segments))
    result = {**recording, "transcript": " ".join(pieces)}
    if diagnostic:
        result["unsuppressedTranscript"] = " ".join(diagnostic)
    transcripts.append(result)
    (directory / "transcripts.json").write_text(json.dumps(transcripts, ensure_ascii=False, indent=2) + "\n")
    print(f"Transcribed {recording['id']} {recording['mode']} {recording['sample']}", flush=True)
