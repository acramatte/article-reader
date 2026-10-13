# Development and checks

For prerequisites, dependency installation and the local Pocket TTS container, start with the [reader quick start](../README.md#quick-start). See [architecture](architecture.md) for the system design and [experiments](experiments.md) for the evidence behind current choices.

## Development servers

With the speech service running, start these in separate terminals:

```sh
npm run backend
npm run dev
```

Open **http://localhost:5173**. Vite serves the UI and proxies `/api` to the Node backend at `127.0.0.1:3001`. The development script binds Vite to `0.0.0.0`; the backend defaults to loopback. If you change backend `PORT`, set `READER_BACKEND_PORT` to the same value when starting Vite.

To run Pocket TTS without Docker, create a Python 3.12 environment in `pocket-tts-service/.venv`, install `requirements.txt`, and stage the assets once with `.venv/bin/python prepare_assets.py <asset-dir>` (this step uses the network). Keep the asset directory outside the repository. Then, from `pocket-tts-service`, run:

```sh
POCKET_TTS_MODEL_DIR=<asset-dir> HF_HUB_OFFLINE=1 \
  .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000 --workers 1
```

Wait for `GET http://127.0.0.1:8000/health` to return 200 before using the reader; model loading completes before the service starts listening. See the [inference reference](hf-inference.md) for assets, admission limits and packaging.

## Backend configuration

Set these environment variables on the **Node backend**, not Vite:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TTS_ENGINE` | `pocket` | Startup engine selection: `pocket` or `kokoro`. Unset or empty uses `pocket`; unknown values fail startup. Must match `TTS_URL`. |
| `TTS_URL` | `http://127.0.0.1:8000/tts` | Full speech-generation endpoint. |
| `TTS_TOKEN` | Unset | Optional server-side Bearer token. Never use a `VITE_*` variable for it. |
| `PORT` | `3001` | Reader backend port. |
| `HOST` | `127.0.0.1` | Reader backend bind address. |
| `ALLOWED_HOSTS` | Unset | Comma-separated host names the reader answers to, besides IP addresses and `localhost` (always allowed). Other `Host` headers get 403, which blocks DNS-rebinding pages. Set it when browsing the reader by name, e.g. `reader.example.internal`. |
| `STREAM_MAX_TEXT_CHARS` | `100000` | Narration text limit; extraction separately caps article text at 100,000 characters. Text is planned in a worker whose heap scales with this limit (about 290 MB at 1,000,000). |
| `STREAM_MAX_AUDIO_BYTES` | `64000000` | Encoded bytes per recording. |
| `STREAM_GENERATION_MS` | `1200000` | Twenty-minute synthesis/encoding deadline. |
| `STREAM_RETENTION_MS` | `21600000` | Six-hour retention after generation or a terminal error. |
| `STREAM_DISCONNECT_MS` | `120000` | Two-minute grace without audio consumers while generating; status requests/SSE do not extend it. |
| `STREAM_MAX_SESSIONS` | `4` | Retained session limit; inactive terminal sessions may be evicted for admission. |
| `STREAM_MAX_CONSUMERS` | `4` | Concurrent audio connections per recording; further requests get 429/Retry-After. |
| `STREAM_SPOOL_DIR` | Instance-specific temporary directory | Dedicated writable spool, exclusive to this server; set an owned bounded tmpfs in read-only containers. |

### External provider contract

An external speech endpoint must accept `{text, voice, speed: 1}` JSON with the selected engine's voices and return a complete mono 24-kHz PCM16 `audio/wav` response. Pocket uses `jane`, `bill_boerst` and `estelle`; Kokoro uses `af_heart`, `am_michael` and `ff_siwis`. Pair `TTS_ENGINE`, `TTS_URL` and endpoint credentials when deploying or rolling back (see [reader/inference pairing](deployment.md#readerinference-pairing)).

`/api/config` exposes only public engine/voice metadata and streaming limits, never the endpoint or token. The raw `/api/tts` WAV route accepts only speed 1; adjusted speeds are available through streaming narration. HF's default Transformers runtime is not a drop-in replacement; use a matching custom inference image.

## Optional Kokoro backend

Pocket TTS remains the default. Kokoro is retained as an opt-in CPU backend for comparison, with Heart (American female), Michael (American male) and Siwis (French female). Stop the local Pocket TTS container before starting Kokoro on the same port:

```sh
docker build -t article-reader-kokoro:local kokoro-service
docker run --rm --name article-reader-kokoro \
  -p 127.0.0.1:8000:8000 article-reader-kokoro:local
```

Wait for `/health` to return 200, then start the built reader with `TTS_ENGINE=kokoro npm start`. For development, use `TTS_ENGINE=kokoro npm run backend`; Vite needs no engine setting or rebuild. For a remote backend, also set `TTS_URL` and its matching `TTS_TOKEN`.

`TTS_ENGINE=pocket|kokoro` selects one engine at reader startup; it does not start an inference service, load both engines, or provide automatic failover. Both pages obtain the selected voice catalog from `/api/config`, and both speech APIs reject another engine's IDs. Switching engines requires restarting the reader with a matching endpoint, discards its temporary recordings, and requires reloading the page. WAV→continuous MP3, speed adjustment, SSE and native playback use the same path for either backend. Kokoro's previously observed memory growth and weaker French voice remain limitations, not fixed by this flag; see the [evidence ledger](experiments.md#inference-engine-choice-and-memory).

Each inference image is built and smoke-tested separately by CI. Verify Kokoro locally with:

```sh
python3 scripts/smoke-kokoro.py article-reader-kokoro:local --quick
```

Quick mode checks short real WAVs for all three reader voices, CPU-only/offline execution and input rejection. Omit `--quick` for longer-input, speed and concurrency probes. Against the running Kokoro service, check its browser catalog and real playback with:

```sh
TTS_ENGINE=kokoro npx playwright test tests/browser/voices.spec.mjs
```

## Tests

```sh
npm test
npm run build
```

Unit/integration tests cover extraction and SSRF protections, chunking, speech preparation and its mapping to highlighted text, provider retries, native-player state and recovery, bounded streaming, concurrency, deadlines, retention, spool isolation, cancellation and shutdown. Encoder tests deliberately use synthetic WAV tones with real FFmpeg.

For real browser playback tests, keep the local Pocket TTS service running, then run:

```sh
npx playwright install chromium
npm run test:browser
```

The browser suite starts dedicated servers on UI port 5197 and backend port 3017; override them with `READER_UI_PORT` and `READER_BACKEND_PORT`. Occupied ports fail rather than reuse another server. Traces and screenshots go to `.ui-review/playwright/`.

Tests require the local Pocket TTS service and internet access to `https://www.paulgraham.com/greatwork.html` for real article/audio checks. They cover native continuous MP3 playback, reload recovery without new synthesis, playback controls, completion, URL-first layout, extraction errors, manual fallback, editing/re-reading without re-extraction, keyboard access and responsive/reduced-motion behavior. Layout/startup/control fixtures are explicitly synthetic; real-provider tests separately exercise Pocket TTS and native MP3 playback. Headless checks don't establish narration quality or reliable background playback on physical phones.

The diagnostic streaming suite is separate: `npx playwright test --config playwright.streaming.config.mjs` selects `streaming.spec.mjs`, starts `npm run streaming` on port 3028 (override `STREAM_TEST_PORT`), and writes artifacts to `.ui-review/streaming-playwright/`. Its configured endpoint defaults to `http://127.0.0.1:8027/tts`, unlike the main suite: set `TTS_URL` for your running service and select the matching `TTS_ENGINE`. It also refuses an existing server. See the [streaming reference](streaming-spike.md#verification-commands) for historical diagnostic commands and their original provider context.

## Manual pronunciation regression check

With the **real Pocket TTS service** running (see [setup](../README.md#quick-start)), use Node, FFmpeg and Python to compare speech with handwritten references. This slow, local tool is **not CI**. Install Whisper in the service venv, then run:

```sh
uv pip install --python pocket-tts-service/.venv/bin/python faster-whisper==1.2.1
node scripts/pronunciation.mjs --baseline \
  --python pocket-tts-service/.venv/bin/python --out /tmp/pronunciation-run
```

Whisper downloads `small` on first use (`--model <local-directory>` uses staged weights). Run one check at a time on small machines. Both decodes prepend 0.5 seconds of silence to each WAV's decoded audio to reduce clipped opening words; retained WAVs remain unchanged.

`--cases tests/fixtures/pronunciation.json` selects a JSON array of `{id, language, text, reference}`: unique lowercase slug IDs, `en`/`fr`, and independent references written as **spoken words**, never derived from preparation. Prepared synthesis uses `planNarration`; `--baseline` also sends original text verbatim (maximum 1,000 characters). Scoring joins letter runs and expands known transcript abbreviations.

Digit-suppressed ASR is the default gate, preventing number formatting from hiding misreadings. Optional per-case `"asr": "unsuppressed"` always adds ordinary ASR and scores it after verbalizing its digits with `numberWords` in that language. Use this for known decoder failures: suppression hallucinates French dates/years; only `fr-date` opts in among the seeds. `--asr-diagnostic` retains an ordinary decoding for other cases without changing their gate. Neither pass is prompted with the reference.

Default `--samples 3` (minimum two) reports median/mean/min/max WER and gates on the median: with three samples, at least two must exceed the threshold to fail. Even sample counts use the average of the two middle scores. Exit **0**: all prepared medians ≤ `--threshold 0.2`; **1**: a prepared median exceeds it; **2**: tool/setup error. Raw baselines never gate. New output directories retain WAVs, exact texts, transcripts, settings and `report.json`; existing directories are refused.

**WER is triage, not phonetic proof**: Pocket sampling and ASR spelling/hallucinations vary. Listen to retained failed/outlier clips before changing rules; unsuppressed ASR can conceal number errors. English brand names in French voices are out of scope.
