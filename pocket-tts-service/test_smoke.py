"""Synthetic WAV fixtures test the validator, not the inference model."""
from email.message import Message
import io
import struct
import unittest
import wave

from smoke_test import validate_wav


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
