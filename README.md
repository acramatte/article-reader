<h1 align="center">
Article Reader
</h1>


Turn an online article into something you can listen to. Paste a link, choose a voice and speed, and start playback. The reader pulls out the article text and reads it aloud, with pause, resume and stop controls. You can also paste text directly.

<p align="center">
  <img src="docs/demo/article-reader-mobile.gif" width="390" alt="Article Reader phone-sized demo: paste a URL, start narration, pause and resume, scroll the extracted article, and stop playback." />
</p>

## Why it exists

The goal is hands-free listening to online articles. Being able to consume them while walking, cooking, at the gym, touching grass, or doing something other than looking at a screen. Existing operating system and phone read-aloud tools still make the journey from a web page to a comfortable and continuous listening more cumbersome than it should be. This project explores a simpler, dedicated reader built around that flow.

It's still an early version, not a finished podcast player. Narration now uses native continuous media, with lock-screen play/pause integration where the browser supports it and recovery of an existing recording after reload. Android/Brave testing confirmed prototype screen-off playback and integrated-reader recovery after Wi-Fi reconnection and browser kill/reopen. Browser processes can be reclaimed, and the saved position may lag while JavaScript is frozen. Speech generation runs in a separate service that you can host locally or remotely.

## Run it yourself

You'll need **Node 24**, **FFmpeg with libmp3lame**, and **Docker** for the local setup below. Run these commands from the project root. The first inference-image build downloads the public Pocket TTS models, voices and dependencies; the resulting speech service runs on CPU without runtime network access, model downloads or an HF token.

### 1. Start the speech service

```sh
docker build -t article-reader-pocket-tts:local pocket-tts-service
docker run --rm --name article-reader-pocket-tts \
  -p 127.0.0.1:8000:8000 article-reader-pocket-tts:local
```

Leave this terminal running. In another terminal, check readiness:

```sh
curl --fail http://127.0.0.1:8000/health
```

Loading both models (English and French) takes time; retry the check until it succeeds before starting playback. The corrected two-vCPU container smoke peaked at 1.64 GiB and generated about 1.47× real time; this is not a production sizing guarantee or a speed comparison with Kokoro. See [measurements and limitations](docs/hf-inference.md#local-verification), especially for 2× playback.

### 2. Start the reader

```sh
npm install --include=dev
npm run build
npm start
```

Open **http://127.0.0.1:3001**, paste a link and click **Read**. Narration starts automatically and the extracted article appears below. If extraction fails, choose **Paste text instead**.

The Listen card provides **Read again**, **Pause/Resume** and **Stop**. After stopping, use **Edit article text** to make changes; **Read again** generates fresh narration from that text without fetching the URL again. Voice/speed settings and playback diagnostics are collapsible. Reload recovery offers the same recording paused near its last saved position; tap Resume to continue without regenerating speech. Available voices: Jane (American English female), Bill Boerst (American English male) and Estelle (French female); no French male voice is offered. Choose a voice matching the text’s language; narration does not translate the article. Speech is always synthesized at the model's own pace; the selected speed (UI choices 0.8–2×; the streaming API accepts 0.5–2) is applied afterwards by the reader's MP3 encoder (FFmpeg `atempo`), which changes tempo but not the model's natural cadence. Voice and speed are fixed for each listening session. The Jane voice derives from VCTK speaker p339 (CC BY 4.0, attribution required); Bill Boerst and Estelle are CC0. See [HF inference](docs/hf-inference.md) for sources.

### Optional Kokoro backend

Pocket TTS remains the default. Kokoro is retained as an opt-in CPU backend for comparison, with Heart (American female), Michael (American male) and Siwis (French female). Stop the local Pocket TTS container before starting Kokoro on the same port:

```sh
docker build -t article-reader-kokoro:local kokoro-service
docker run --rm --name article-reader-kokoro \
  -p 127.0.0.1:8000:8000 article-reader-kokoro:local
```

Wait for `/health` as above, then start the built reader with `TTS_ENGINE=kokoro npm start`. For development, use `TTS_ENGINE=kokoro npm run backend`; Vite needs no engine setting or rebuild. For a remote backend, also set `TTS_URL` and its matching `TTS_TOKEN`.

`TTS_ENGINE=pocket|kokoro` selects one engine at reader startup; it does not start an inference service, load both engines, or provide automatic failover. Both pages obtain the selected voice catalog from `/api/config`, and both speech APIs reject another engine's IDs. Switching engines requires restarting the reader with a matching endpoint, discards its temporary recordings, and requires reloading the page. WAV→continuous MP3, speed adjustment, SSE and native playback use the same path for either backend. Kokoro's previously observed memory growth and weaker French voice remain limitations, not fixed by this flag.

Each inference image is built and smoke-tested separately by CI. Verify Kokoro locally with `python3 scripts/smoke-kokoro.py article-reader-kokoro:local --quick` (short real WAVs for all three reader voices, CPU-only/offline execution and input rejection). Omit `--quick` for longer-input, speed and concurrency probes. Run `TTS_ENGINE=kokoro npx playwright test tests/browser/voices.spec.mjs` against the running Kokoro service for browser catalog and real playback checks.

### Hosting

**Do not expose the app publicly as-is.** The reader requires an external access-control layer; it does not enforce per-user rate limits. Streaming admission is bounded to one generating narration and four retained recordings by default, but that is not a public-service abuse boundary. Keep it behind a VPN or another access-control layer, and keep local inference bound to loopback.

For containers, the root `Dockerfile` packages the reader UI and backend only; inference is a separate instance. The supplied `compose.yaml` targets a WireGuard deployment, binding to `10.0.0.1:8084` by default. See [deployment](docs/deployment.md) for image configuration, credentials, HTTPS, firewall and update instructions, or [HF inference](docs/hf-inference.md) to host the speech service on a Hugging Face Protected custom-container endpoint.

## Development and configuration

### Architecture

```mermaid
flowchart LR
    Browser["Browser / phone<br/>Native audio player"] -->|"Article requests and playback controls"| Reader["Reader instance<br/>Node API + FFmpeg + built UI"]
    Reader -->|"Article text + continuous MP3"| Browser
    Reader -->|"Fetch article"| Website["Public article website"]
    Reader -->|"Text chunks + voice"| Speech["Speech instance<br/>Pocket TTS (default) or Kokoro: local or hosted"]
    Speech -->|"WAV per chunk"| Reader
    classDef managed fill:#1e40af,stroke:#1e3a8a,color:#ffffff
    classDef external fill:#4b5563,stroke:#374151,color:#ffffff,stroke-dasharray:5 5
    class Reader,Speech managed
    class Browser,Website external
```

Grey, dashed components are external platforms outside our control; blue components are services we run.

The Node backend extracts article text with Mozilla Readability and owns narration: small paragraph/sentence chunks feed a single FFmpeg encoder producing continuous MP3 audio, applying the selected speed with `atempo` and accounting audio duration at that tempo. The first chunk is capped at 220 characters, later chunks at 500. A native HTML audio element plays the growing stream before the full article is synthesized; server-sent events (SSE) display progress and handle recovery, not audio scheduling.

`GET /api/streaming/:id/events` sends a named `status` event containing the current snapshot immediately on connect/reconnect, then pushes preparation progress, warmup and terminal states. First-audio, chunk progress, warmup, consumer/mark changes and terminal states publish immediately; byte-only encoder updates are coalesced into the latest counters at most once every 250 ms, rather than publishing every MP3 frame. Immediate updates include pending counters, and completed snapshots contain the final byte count. It sends comment heartbeats every 15 seconds, allows at most four status subscribers per recording, and closes on ready/error/Stop. A stalled subscriber is disconnected instead of buffering unlimited updates; EventSource reconnects with the latest snapshot, so no event replay is required. Status disconnections neither cancel narration nor count as audio consumers. There is no recurring `/status` polling; the JSON snapshot endpoint remains for explicit recovery, retry, media-error diagnosis and completion checks. Both the reader and diagnostic page use SSE. Proxies must allow unbuffered long-lived responses; see [deployment](docs/deployment.md#vpn-only-access-and-browser-https).

Browser API calls stay same-origin. Provider credentials remain on the reader backend, never in the browser. Article text, source metadata and recordings are retained temporarily on this reader instance for recovery; they do not survive a server restart. Browser storage contains only a validated session reference, title and best-known position, not article text or audio. With remote inference, text is sent to that service.

Pause pauses listening, not generation. The server continues within its generation and storage limits. Stop cancels future requests, kills the encoder, removes the recording and clears its bookmark, but cannot interrupt speech computation already running on the inference service. Recovery restores an already-generated saved position in the growing recording and offers explicit Resume without waiting for the whole article; completed files also support byte ranges.

### Development servers

With the speech service above running, start these in separate terminals:

```sh
npm run backend
npm run dev
```

Open **http://localhost:5173**. Vite serves the UI and proxies `/api` to the Node backend at `127.0.0.1:3001`. To run without Docker, create a Python 3.12 environment in `pocket-tts-service/.venv`, install `requirements.txt`, stage the assets once with `.venv/bin/python prepare_assets.py <asset-dir>` (this step uses the network), then from `pocket-tts-service` run `POCKET_TTS_MODEL_DIR=<asset-dir> HF_HUB_OFFLINE=1 .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000 --workers 1`. Keep the asset directory outside the repository.

### Backend configuration

Set these environment variables on the **Node backend**:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TTS_ENGINE` | `pocket` | Startup engine selection: `pocket` or `kokoro`. Unset or empty uses `pocket`; unknown values fail startup. Must match `TTS_URL`. |
| `TTS_URL` | `http://127.0.0.1:8000/tts` | Full speech-generation endpoint. |
| `TTS_TOKEN` | Unset | Optional server-side Bearer token. Never use a `VITE_*` variable for it. |
| `PORT` | `3001` | Reader backend port. |
| `HOST` | `127.0.0.1` | Reader backend bind address. |
| `STREAM_MAX_TEXT_CHARS` | `100000` | Narration text limit; extraction separately caps article text at 100,000 characters. |
| `STREAM_MAX_AUDIO_BYTES` | `64000000` | Encoded bytes per recording. |
| `STREAM_GENERATION_MS` | `1200000` | Twenty-minute synthesis/encoding deadline. |
| `STREAM_RETENTION_MS` | `21600000` | Six-hour retention after generation or a terminal error. |
| `STREAM_DISCONNECT_MS` | `120000` | Two-minute grace without audio consumers while generating; status requests/SSE do not extend it. |
| `STREAM_MAX_SESSIONS` | `4` | Retained session limit; inactive terminal sessions may be evicted for admission. |
| `STREAM_SPOOL_DIR` | Instance-specific temporary directory | Dedicated writable spool, exclusive to this server; set an owned bounded tmpfs in read-only containers. |

An external speech endpoint must accept `{text, voice, speed: 1}` JSON with the selected engine's voices and return a complete mono 24-kHz PCM16 `audio/wav` response. Pocket uses `jane`, `bill_boerst` and `estelle`; Kokoro uses `af_heart`, `am_michael` and `ff_siwis`. Pair `TTS_ENGINE`, `TTS_URL` and endpoint credentials when deploying or rolling back (see [deployment](docs/deployment.md#readerinference-pairing)). `/api/config` exposes only public engine/voice metadata and streaming limits, never the endpoint or token. The raw `/api/tts` WAV route accepts only speed 1; adjusted speeds are available through streaming narration. HF's default Transformers runtime is not a drop-in replacement; use a matching custom inference image. If you change the backend `PORT` during development, set `READER_BACKEND_PORT` to the same value when starting Vite.

### Tests

```sh
npm test
npm run build
```

Unit/integration tests cover extraction and SSRF protections, chunking, provider retries, native-player state and recovery, bounded streaming, concurrency, deadlines, retention, spool isolation, cancellation and shutdown. Encoder tests deliberately use synthetic WAV tones with real FFmpeg. For real browser playback tests, keep the local Pocket TTS service running, then run:

```sh
npx playwright install chromium
npm run test:browser
```

The browser suite starts dedicated servers on UI port 5197 and backend port 3017; override them with `READER_UI_PORT` and `READER_BACKEND_PORT`. Occupied ports fail rather than reuse another server. Traces and screenshots go to `.ui-review/playwright/`.

Tests require the local Pocket TTS service and internet access to `https://www.paulgraham.com/greatwork.html` for real article/audio checks. They cover native continuous MP3 playback, reload recovery without new synthesis, playback controls, completion, URL-first layout, extraction errors, manual fallback, editing/re-reading without re-extraction, keyboard access and responsive/reduced-motion behavior. Layout/startup/control fixtures are explicitly synthetic; real-provider tests separately exercise Pocket TTS and native MP3 playback. Headless checks don't establish narration quality or reliable background playback on physical phones.


## Locked-screen playback and diagnostic page

The default reader now uses the [continuous-media implementation](docs/streaming-spike.md). `npm run streaming` retains the diagnostic `/streaming.html` page with deliberate pacing, a lock-screen test mark and detailed reports, backed by the same API/provider. Screen-off playback was confirmed on Brave/Android in the prototype, with improved buffering when test pacing was disabled. Desktop tests recover an existing recording after reload and tab reopening without regeneration. Physical Android/Brave testing confirmed integrated-reader Resume after leaving/rejoining Wi-Fi and after killing/reopening the browser; integrated lock-screen controls have not been separately qualified.

## Current limits

- JS-heavy or paywalled pages may not extract; paste text as a fallback. Readability cannot remove every inline ad or consent banner.
- Extraction accepts public HTTP/HTTPS URLs on standard ports, without URL credentials. Private, loopback, link-local and reserved addresses are blocked, including redirects; DNS results are checked and the selected public IP is pinned to the connection.
- Fetches have a 15-second deadline, five-redirect limit and 3 MB HTML limit. Scripts are not executed, UTF-8 HTML is assumed, and article text is limited to 100,000 characters.
- Recovery seeks completed recordings and uses Media Session play/pause where supported, but arbitrary seeking in growing streams, offline narration and guaranteed unkillable mobile playback are not provided. Use one playback tab; cross-tab coordination is not implemented.
- The inference server needs to be dimensioned according to usage. Concurrent listening is limited by the speech service’s compute capacity and request queue. Although the model is shared per inference worker, not loaded separately for each user.
- Kokoro (opt-in): extended testing of the previous local Kokoro CPU inference showed memory growth and an OOM kill at a 6 GiB container limit; this was not an observed failure of the HF endpoint. Restarting restored service, not a fix; see the [inference follow-up](docs/streaming-spike.md#known-inference-follow-up-sustained-cpu-memory-growth). Pocket TTS passed a bounded 30-request mixed-language run without OOM, but longer production testing remains necessary; do not assume the original problem is permanently solved.

The old browser-inference experiment in `main_.js` is not loaded by the app. Its unused `kokoro-js` dependency was removed; revisiting it requires installing that dependency separately.
