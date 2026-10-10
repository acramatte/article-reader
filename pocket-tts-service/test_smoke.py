"""Synthetic WAV fixtures test the validator, not the inference model."""
from email.message import Message
import hashlib
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
import wave

from smoke_test import validate_wav, verify_manifest


class WavValidationTest(unittest.TestCase):
    def test_non_silent_audio_is_rejected_above_the_text_duration_bound(self):
        text = "Hello you!"  # Ten characters: independently chosen 2.5-second bound.
        for frames, accepted in ((60000, True), (60001, False)):
            with self.subTest(frames=frames):
                buffer = io.BytesIO()
                with wave.open(buffer, "wb") as wav:
                    wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                    wav.writeframes(struct.pack("<h", 2048) * frames)
                headers = Message()
                for key, value in {
                    "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Device": "cpu",
                    "X-Audio-Seconds": f"{frames / 24000:.3f}", "X-Generation-Seconds": "1", "X-RTF": "0.4",
                }.items():
                    headers[key] = value
                response = (200, headers, buffer.getvalue())
                if accepted:
                    self.assertEqual(validate_wav(response, text)["audio_seconds"], 2.5)
                else:
                    with self.assertRaisesRegex(AssertionError, "Implausible WAV duration"):
                        validate_wav(response, text)


class ManifestVerificationTest(unittest.TestCase):
    def test_manifest_must_cover_and_match_every_bundled_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "languages").mkdir()
            (root / "languages" / "model.safetensors").write_bytes(b"weights")
            (root / "english.yaml").write_text("weights_path: /opt/pocket-tts/languages/model.safetensors\n")
            (root / "NOTICES.md").write_text("Attribution")
            digest = lambda path: hashlib.sha256((root / path).read_bytes()).hexdigest()
            assets = [
                {"path": "languages/model.safetensors", "kind": "downloaded", "sha256": digest("languages/model.safetensors"),
                 "source": {"sha256": digest("languages/model.safetensors")}},
                {"path": "english.yaml", "kind": "rewritten", "sha256": digest("english.yaml"), "source": {"sha256": "0" * 64}},
            ]
            write = lambda: (root / "assets.json").write_text(json.dumps({"assets": assets}))
            write()
            self.assertEqual(verify_manifest(root), 2)
            (root / "languages" / "extra.bin").write_bytes(b"unrecorded")
            with self.assertRaisesRegex(AssertionError, "differ"):
                verify_manifest(root)
            (root / "languages" / "extra.bin").unlink()
            (root / "languages" / "model.safetensors").write_bytes(b"tampered")
            with self.assertRaisesRegex(AssertionError, "Hash mismatch"):
                verify_manifest(root)
            (root / "languages" / "model.safetensors").write_bytes(b"weights")
            assets[0]["source"]["sha256"] = "0" * 64
            write()
            with self.assertRaises(AssertionError):
                verify_manifest(root)
