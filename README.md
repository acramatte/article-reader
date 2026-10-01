# Article Reader + Kokoro

A first vertical slice: URL → server-side Mozilla Readability → paragraph/sentence chunks → Kokoro WAV → scheduled browser audio. The first chunk is capped at 220 characters; subsequent chunks at 500. The player schedules decoded audio on the Web Audio clock with a 45-second look-ahead target (it can overshoot by one chunk), rather than switching separate audio players at chunk boundaries.

## Development

Node 24 and the existing Python 3.12 Kokoro environment are used here.

1. `npm install --include=dev` (this machine's npm configuration omits dev dependencies by default).
2. Start the existing service from `kokoro-service`: `.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000`.
3. In the project root, `npm run backend` (127.0.0.1:3001).
4. In another terminal, `npm run dev`.
5. Open http://localhost:5173. Paste a webpage URL into the large landing field and choose **Read article**. Extraction starts narration automatically, smoothly brings the URL area toward the top, and reveals the retrieved article. Reduced-motion users get the same layout immediately. **Paste text instead** is a secondary fallback, highlighted after extraction errors; the editor is not shown initially. Retrieved content can be edited through **Edit article text** after stopping.

The compact Listen card groups **Read again**, **Pause/Resume** and **Stop**. After Stop or completion, **Read again** starts the current editor text from the beginning with newly generated audio, without fetching the URL again. **Read article** by the URL field explicitly fetches a page. Voice/speed and buffer diagnostics are collapsible.

Both browser API requests are same-origin. Vite proxies `/api` to the app backend. The browser never calls the Python service directly and never receives a model-provider token. Pause freezes the audio clock and stops new synthesis requests; one in-flight request may complete. Stop aborts fetches, drops pending audio and closes the audio context. Cancelling an HTTP request cannot interrupt Python inference that has already started.

## Backend configuration

- `TTS_URL`: full WAV synthesis endpoint; defaults to `http://127.0.0.1:8000/tts`.
- `TTS_TOKEN`: optional server-side Bearer token, never a `VITE_*` variable.
- `PORT`: app backend port; defaults to 3001.
- `HOST`: app backend bind address; defaults to 127.0.0.1.

Hosted inference must accept the current `{text, voice, speed}` JSON and return `audio/wav`. The separate CPU-only inference image and HF custom-container configuration are documented in [docs/hf-inference.md](docs/hf-inference.md); it is not HF's default Transformers runtime.

## Production / phone testing

`npm run build` then `npm start` serves the built UI and API from the app backend. For another device, bind with `HOST=0.0.0.0` and put it behind an **HTTPS** reverse proxy before exposing it beyond your trusted network. The TTS server can stay on loopback; Android does not need a Python service on the phone. The backend has no user auth, rate limiting or concurrency admission control yet: do not deploy it publicly as-is. URLs, article text, and generated audio are not stored by the app.

## Container / WireGuard deployment

The multi-stage `Dockerfile` bundles the production frontend and Node crawler/API only; inference stays external. `compose.yaml` binds the reader to `10.0.0.1:8084` by default, separately from existing services, and opts into the existing Watchtower via its enable label. See [docs/deployment.md](docs/deployment.md) for required image/endpoint configuration, server-only credentials, VPN/firewall and HTTPS checks, local container smoke tests, and remaining deployment gates. No registry image or HF endpoint has been provisioned by these files.

## Extraction limits

HTTP/HTTPS only, standard ports, no credentials. Every URL/redirect is checked against all DNS results, and the selected public IP is pinned to the socket to avoid DNS rebinding. Private/loopback/link-local/reserved IPs are blocked. Fetching has a 15-second deadline, five-redirect limit, and 3 MB HTML body limit. HTML scripts/resources are not executed. UTF-8 HTML is currently assumed. Articles are limited to 100,000 characters. Provider failures and JS-heavy/paywalled pages are reported; paste text to continue. Readability reduces noise but cannot guarantee removal of every inline ad or consent banner.

English voices: Heart, Bella, Nicole. Voice and synthesis speed are fixed for each listening session. No headless-browser fallback, Web Speech mode, seek, persisted articles, offline mode, media-session integration or guaranteed mobile background playback yet. Keep the tab open; physical Android and macOS testing is still needed.

## Verification

- `npm test`: extraction, SSRF/redirect validation, socket limits, chunking, API behavior, scheduling, backpressure, pause, cancellation and cleanup.
- `npm run build`: production bundle.
- `npx playwright install chromium` then `npm run test:browser`: real public article + **real local Kokoro** + Web Audio playback, buffer continuity, pause/resume/stop, 390px mobile layout and natural completion. Requires the Python service and external access to `https://www.paulgraham.com/greatwork.html`; the test runner starts the app backend and Vite when necessary. The error-path test intentionally simulates a TTS failure, not a successful audio response. Traces/screenshots are stored under `.ui-review/playwright/` in this worktree. Headless browser playback verifies non-silent samples and scheduling, not human-perceived narration quality.

### Independent UI review (this worktree)

Production preview from this worktree:

```sh
npm run build
PORT=5187 HOST=127.0.0.1 npm start
```

For hot-reload development instead, stop the production preview and use two terminals:

```sh
PORT=3017 npm run backend
READER_BACKEND_PORT=3017 npm run dev -- --host 127.0.0.1 --port 5187 --strictPort
```

Open http://127.0.0.1:5187. The existing Kokoro endpoint on port 8000 is required for speech; no inference service or backend API was changed.

Browser tests use UI 5197 / backend 3017, separate from the production preview on 5187. Override with `READER_UI_PORT` / `READER_BACKEND_PORT` if needed; occupied ports fail rather than reuse another server. For worktree-local transform/browser caches:

```sh
mkdir -p .ui-review/tmp
TMPDIR="$PWD/.ui-review/tmp" npm run test:browser
```

Artifacts use `.ui-review/playwright/`. Tests cover URL-first initial state, article reveal only after successful extraction, extraction errors and manual fallback, keyboard/settings access at 1280/390/320px, extraction cancellation, and Stop → Read again (another TTS request, no re-extraction, edited text). The reveal tests measure intermediate URL positions, focus retention, no overflow, and immediate reduced-motion behavior. Their article/startup fixtures are explicitly synthetic; the console playback tests and existing public-URL test retain real Kokoro audio.

The old browser-inference experiment remains in `main_.js`, but is not loaded by the app. Its unused `kokoro-js` dependency was removed from the active app; reinstall it separately if revisiting that experiment.
