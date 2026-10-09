# Locked-screen streaming spike

## Scope

The successful experiment is now the default reader: `npm start` runs native continuous playback and reload recovery. `npm run streaming` remains a diagnostic entry point, redirecting `/` to `/streaming.html` and serving the normal reader at `/index.html`. Both share `/api/streaming`, `/api/config`, the provider boundary and lifecycle engine. Test HTML and JavaScript are served without caching.

The experiment uses real Kokoro WAV responses, validates mono 24-kHz PCM16, strips WAV containers, and feeds one continuous FFmpeg MP3 encoder. Low input probing and output flushing are explicit: encoder defaults can otherwise delay output until more PCM arrives. Browser playback is a normal `<audio>` URL, with Media Session metadata and play/pause handlers. JavaScript polling only displays status; it does not produce or schedule audio.

The results and polling references below describe the original Kokoro experiment. The current reader and diagnostic page use Pocket TTS and SSE status snapshots instead of recurring polling; native MP3 playback and the audio-consumer grace remain independent of status connections. See the [current architecture and SSE contract](../README.md#architecture) for implementation details. The historical phone results do not qualify the new provider or status transport on Android.

## Run on a trusted private network

Requirements: Node/npm dependencies, FFmpeg with `libmp3lame`, and a reachable Kokoro `/tts` endpoint.

1. `npm ci --include=dev`
2. `npm run build`
3. Set `TTS_URL` to the actual inference URL. Keep any `TTS_TOKEN` server-side using the existing secure provisioning procedure; never put it in a browser variable or command history.
4. Set `HOST` to this machine's private LAN or WireGuard address, `PORT` to a verified free port (default 3027), and `STREAM_SPOOL_DIR` to a dedicated writable scratch directory outside the repository. The default is a directory under Node's OS temporary directory.
5. Run `npm run streaming` and open `http://HOST:PORT/streaming.html` on the phone.

Bind a specific private address, not all interfaces. This diagnostic page is for trusted-network use, not a public service. If a phone on cellular cannot reach the LAN address, use a confirmed private VPN route or arrange a separately approved deployment; do not open a public tunnel.

Trusted HTTPS may be needed for platform media-control integration. HTTP can play media, but Media Session availability/lock-screen presentation must be checked on the actual Brave device. WireGuard does not turn HTTP into a browser secure context.

## Phone acceptance

Use the supplied real speech at 1× speed. Pacing is off by default. For deliberate lifecycle testing, check the pacing option to wait five seconds between synthesis requests, making generation after locking observable; it can cause buffering even at 1× with short chunks. Turn it off for normal listening.

1. Start the streaming test. If Android blocks asynchronous playback after extraction/cold start, use the player's native Play button; this is visible feedback rather than a fabricated successful start.
2. Once speech starts, press **Mark test, then lock phone**. Wait until the page confirms the mark, then lock the screen.
3. Listen for at least one minute and beyond the speech that existed at the mark. Check for gaps or silence; try lock-screen/headset pause/resume when available.
4. Unlock, press **Refresh report**, and inspect `generatedAfterMark`, `audioSecondsGenerated` at the mark, and `playedBeyondMark`.
5. A useful pass combines actual uninterrupted listening with newly generated chunks after the mark and playback beyond the pre-mark generated audio. These counters alone do not prove sound reached the device speaker or headphones.
6. Stop, then repeat without pacing. Also try automatic screen timeout, switching apps, and a longer locked session. Record Brave/Android versions and whether lock-screen controls appear.

Desktop Chromium freezing is an additional test, not a substitute for a physical Android lock screen.

The first physical Android/Brave run confirmed screen-off playback: 24 chunks were generated after the mark and playback reached the end of the 112-second recording. The user reported frequent buffering with pacing and improvement without it. Lock-screen pause/resume was inconsistent, including a reload that lost the session; the recovery slice below addresses that separately. Do not infer actual Android version from the reduced browser user agent.

## Reload recovery

- A single origin-local bookmark stores the session ID, short title and last known playback position. No article text, URL or audio is saved in browser storage. Use one playback tab; cross-tab ownership is not implemented.
- Position saves on foreground media ticks at most every five seconds and immediately on pause, seek, page hide and visibility loss. Frozen/discarded JavaScript cannot save: after a long locked interval the bookmark may lag actual listening. It is a best-known position, not an exact crash-proof listening history.
- Reload or opening a new tab checks the existing session, never silently creates another. Completed recordings load paused and seek before exposing native controls and **Resume saved recording**. A deliberate tap resumes the same audio; no autoplay is attempted on recovery.
- If generation is unfinished, recovery waits for completion before seeking. It does not pretend arbitrary seeking into the growing stream is supported. The disconnected grace and generation deadline still apply; status polling does not keep generation alive.
- Missing/expired sessions or server restarts show an explicit message and clear the bookmark. Temporary network failures retain it for retry with **Refresh report**. Stop clears it and cancels work; late status responses cannot undo Stop.
- The report includes `wasDiscarded`, navigation type, recovered state, restored position and storage warnings. `wasDiscarded: false` does not rule out an Android process kill; JavaScript cannot prevent the OS reclaiming the browser.
- Phone acceptance: start a fresh narration, listen and pause, then reload the same URL. Verify the saved recording is offered paused near its last saved position and Resume does not start from the beginning. Repeat after locking/app switching. Complete this within recording retention (six hours by default, unless capacity eviction occurs) and without restarting the server. Actual OS-discard recovery remains device acceptance, not established by a desktop reload test.

## Limits and lifecycle

- At most one narration generates at a time, with no waiting queue. Concurrent creates receive 429/Retry-After.
- At most four session records are retained; inactive terminal sessions can be evicted for a new session.
- Defaults accept 100,000 text characters and 64,000,000 encoded bytes per session. Validated positive `STREAM_*` overrides and their defaults are listed in the README; `/api/config` exposes only non-secret limits. Extraction separately retains its 100,000-character limit.
- Generation has a twenty-minute deadline. Completed recordings and terminal error metadata have a separate six-hour retention timer, starting when generation ends; a paused completed recording is not canceled by the generation/disconnect deadline. Losing all audio consumers gives unfinished generation a two-minute grace period. Status polling does not extend it.
- Pause pauses playback only. Generation can continue within these bounds.
- Stop cancels future requests, kills the encoder, removes the spool and allows another session. Native Kokoro compute already accepted upstream may still finish.
- A dropped playback connection does not own generation. Fetching the same audio URL replays existing bytes without new synthesis; seamless mid-stream network resume is not promised.
- Completed audio supports ordinary byte-range GETs. In-progress audio is a continuous unknown-length stream; arbitrary seeking is not supported.
- Failure is retained as an explicit status. A truncated media connection is not proof of natural completion: check the server report.
- Session metadata is in memory. Restarting the server does not resume it. Graceful shutdown removes its files; before the first new session, abandoned `session-XXXXXX` directories are removed. The spool must be dedicated to exactly one server instance: never share it with another running instance. Unrelated names and symlinks are not traversed.

## Container packaging

The standard image includes FFmpeg and defaults to `node server.mjs`, now providing streaming in the normal reader. The diagnostic entry point can still be selected with `node streaming-server.mjs`. Production Compose and the real-inference smoke use `STREAM_SPOOL_DIR=/spool` with a 272-MiB bounded tmpfs owned by UID 1000; the small `/tmp` alone is not sufficient for the default aggregate recording bound. The ownership lock is inside the writable spool, not its read-only parent.

These local Compose changes are not a deployment; existing VPS services are not modified. FFmpeg adds runtime image weight and needs measurement under the real deployment limits. The existing base image remains digest-pinned; Debian FFmpeg packages follow the configured security repositories, not a snapshot lock.

## Verification commands

- `npm test`: includes bookmark validation, throttling and unavailable storage, plus deliberately synthetic WAV tones through the real encoder for WAV validation, early bytes, disconnected playback, cancellation, disk/lifetime limits, admission races, errors, and range replay.
- `npm run build`
- `TTS_URL=http://127.0.0.1:8027/tts npx playwright test --config playwright.streaming.config.mjs`: needs real ready inference and FFmpeg/Chromium; exercises production-built `/streaming.html`, early playback, playback beyond the pre-freeze audio while page JavaScript is frozen, server generation, pause/resume, Stop during delayed admission acknowledgement, and decoded non-silent speech. Port 3028 is isolated from the live phone preview. Run `npm run build` first after changing public assets.
- `TTS_URL=http://127.0.0.1:8027/tts npx playwright test`: default-reader native playback/reload tests and migrated UI regressions; the diagnostic suite is explicitly separate.
- `docker build -t article-reader:streaming-spike .`
- `node scripts/smoke-container.mjs article-reader:streaming-spike`: normal entry point and packaging.
- `node scripts/smoke-streaming.mjs article-reader:streaming-spike http://KOKORO_CONTAINER:8000/tts DOCKER_NETWORK`: default runtime entry point, real inference, incremental MP3 decoding and cleanup under 512 MiB / one CPU / 128 PIDs with a separate spool tmpfs. Requires a Docker network where the named inference container is reachable; the script does not provision or expose inference.

The real speech acceptance writes its MP3 and screenshots under `.ui-review/streaming-playwright/`. Recovery tests exercise real MP3 seeking across reload and new-tab reopening, expiry, temporary network failure, interrupted restoration and in-progress waiting. Automated recovery evidence is kept separate from the physical-device results below.

## Default-reader integration verification

- 58 unit/integration tests, 33 default-reader browser tests and 7 diagnostic browser tests passed, along with the production build and both container smokes. Cleanup removed the unused Web Audio player and its four obsolete tests; native-player coverage remains. UI-only fixtures remain labeled separately from real Kokoro/MP3 checks. JSON byte bounds cover the combined worst-case escaped text and validated metadata, not an arbitrary fixed metadata allowance. A gated native-media error regression verifies that provider failures are not overwritten by an unsupported-source rejection; ambiguous transport failures are not retried.
- Real URL extraction admitted a 59,515-character article and native playback advanced while only a small portion of its 241 chunks was prepared. That early-start test deliberately stopped generation; it is not evidence of full-article natural completion or gap-free listening.
- The default reader restored the same real recording, article metadata, voice/speed and a two-second position after reload and after closing/reopening a tab, with one creation request and explicit Resume. A separate check exercised the built production UI, not Vite, with real speech: same ID, paused at two seconds, one creation, no mobile-width overflow, and confirmed server cancellation after Stop.
- The real-inference smoke uses the image's default `node server.mjs` command under non-root/read-only/resource bounds and decodes non-silent MP3 while generation is still incomplete.
- Ripwire's render complexity/nesting regressions were removed. The scoped runtime delta still reports intentional short-horizon churn in the promoted entry points and new state-machine/range-handler complexity; no blanket acknowledgement or clean quality-gate claim is made.
- Physical Android/Brave testing confirmed integrated-reader Resume after leaving/rejoining Wi-Fi and after killing/reopening the browser. Integrated lock-screen controls have not been separately qualified. Recordings do not survive server restart.

### Known inference follow-up: sustained CPU memory growth

The dedicated local CPU Kokoro test container was OOM-killed at its unchanged 6 GiB memory/no-swap limit after extended testing. This was not an observed failure of the deployed HF Inference Endpoint; sustained memory stability there remains unverified. Restarting allowed the final acceptance run to pass, but that run ended at 5,826,686,976 current bytes and 6,013,075,456 peak bytes. This is not evidence of safe long-running inference or full-length article completion. Restarting the test provider restores headroom, not a memory-growth fix.

A partial matched-workload experiment with `ONEDNN_PRIMITIVE_CACHE_CAPACITY=64` and `LRU_CACHE_CAPACITY=64` did not establish an improvement; it timed out before the planned workload completed. Neither setting was promoted into the inference image. The temporary comparison containers were removed. Investigate and validate the sustained-memory problem separately before production use; upstream has a related [Kokoro memory-growth report](https://github.com/hexgrad/kokoro/issues/152), but its cause is not proved to be identical here.
