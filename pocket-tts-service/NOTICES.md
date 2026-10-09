# Pocket TTS model and voice attribution

This image redistributes Kyutai's Pocket TTS non-voice-cloning checkpoints and
precomputed voice states. The weights are licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Source: https://huggingface.co/kyutai/pocket-tts-without-voice-cloning.
The bundled README contains the model card and prohibited-use notice;
assets.json records the distributed files' hashes. We rewrite configuration
paths for offline use and dynamically quantize the models at startup.

Voice states are Kyutai's derivatives of these recordings:

- **Jane:** VCTK p339 (female, American, Pennsylvania), enhanced recording
  `vctk/p339_023_enhanced.wav`. CSTR VCTK Corpus 0.92, Junichi Yamagishi,
  Christophe Veaux and Kirsten MacDonald (2019), University of Edinburgh.
  https://doi.org/10.7488/ds/2645 — CC BY 4.0.
  Kyutai supplies an enhanced recording and precomputed conditioning state;
  this application uses that state unchanged.
- **Bill Boerst:** `voice-zero/bill_boerst.wav`, a reading voice from
  Voice-Zero/LibriVox, distributed under CC0.
  https://github.com/OwenTyme/voice-zero
- **Estelle:** Kyutai's own recording,
  `unmute-prod-website/developpeuse-3.wav`, distributed under CC0.

Voice provenance and licenses: https://huggingface.co/kyutai/tts-voices.
CC0: https://creativecommons.org/publicdomain/zero/1.0/.
These names identify synthesis presets; generated narration is not a recording
of, or endorsement by, the original speakers. No user-supplied voice cloning is
provided by this service.
