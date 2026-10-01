# Kokoro CPU inference on Hugging Face

## Separate image

The reader image contains Node and frontend assets only. Build this separate inference image with:

`docker build -t article-reader-kokoro:local kokoro-service`

`python3 scripts/smoke-kokoro.py article-reader-kokoro:local`

The image uses Python 3.12.14 (digest-pinned), a resolved dependency lock, CPU-only Torch 2.14.1+cpu and Kokoro 0.9.4. Regenerate the lock using the command in `kokoro-service/requirements.txt`; do not resolve production dependencies anew during deployment. System libraries are installed from Debian's package repositories (not a snapshot-locked OS package set).

Pinned public Kokoro v1.0 assets are bundled at `/opt/kokoro` at build time: revision `f3ff3571791e39611d31c381e3a41a3af07b4987`, config, weights and `af_heart`, `af_bella`, `af_nicole`. The weight checksum is verified during the build. Model card, voice documentation, Apache 2.0 license and an asset hash manifest accompany the weights. English spaCy assets are installed during the build too. No HF credential is used or bundled, and runtime Hub/Transformers offline mode is enabled. The build scanner's `HF_HUB_DISABLE_IMPLICIT_TOKEN` warning refers to a public boolean setting, not a secret.

The service loads and prepares models/voices before Uvicorn begins listening. Readiness is `GET /health` returning 200 only once imports/model loading completed; until then connection attempts may fail. Always wait for readiness in tests and deployments. `POST /tts` (and `POST /`) accepts the existing `{text, voice, speed}` JSON and returns complete mono 24-kHz PCM16 WAV with timing headers and `Cache-Control: no-store`. Text is 1–1,000 characters with non-whitespace content, voices are allowlisted, and speed is 0.5–2 inclusive. At most one inference runs and one request waits; further admitted-route requests return 429 with Retry-After. Uvicorn also caps connection concurrency at eight. Use exactly one worker/replica initially so the model and admission state are not multiplied.

HTTP disconnect does not interrupt ongoing native Kokoro computation. A waiting request can also still generate after its client disconnects. This bounded overlap supports the current reader's stop/restart flow, but does not claim compute cancellation or public abuse protection. Authentication is supplied by the HF Protected endpoint, not this container; never expose the container directly as an unauthenticated public service. The reader backend still needs its own admission/rate policy for compromised VPN peers or multiple readers.

## Local verification

CI uses `python3 scripts/smoke-kokoro.py article-reader-kokoro:ci --quick`: readiness, one short Heart synthesis, WAV validity/non-silence and rejected invalid requests only. It skips multi-voice, slow/long-input, concurrency and recovery probes. The inference check has a three-minute workflow deadline, a 150-second process deadline, two-CPU/4-GiB/no-swap limits and no external container network. It is a packaging smoke, NOT a load or deployment-sizing test. The full suite remains manual via the command without `--quick`. On failure the runner captures Docker state (including OOMKilled) and logs before forcibly removing the container; cleanup does not mask the original exception.

The first GitHub Actions run of the full suite was killed with exit 137 during concurrency testing under the 4-GiB limit. Its auto-removed container prevented confirming OOMKilled; treat this as a resource warning, not a proven OOM diagnosis or justification to raise CI limits. Passing a short CI request does not establish sufficient hosted memory for real articles.

`smoke-kokoro.py` starts a non-root, read-only container with no external network, no capabilities, two CPU quota, 4 GiB memory and no swap. It checks actual HTTP inference, all three voices, finite non-silent WAV payloads and frame/duration agreement, root prediction route, slow/fast speeds, long input, invalid requests, one-active/one-waiting admission, 429 and subsequent recovery. It inspects cgroup OOM/swap counters and removes the test container. It does not fabricate a model response or require HF access at runtime.

A no-swap local run produced Heart/Bella/Nicole audio of 6.900/7.225/10.975 seconds in 2.152/1.974/2.919 seconds respectively for the fixed smoke input. Container cgroup peak was 3,834.6 MiB, with zero OOM events and zero swap. This includes charged cache/runtime overhead and is NOT process RSS or an HF hardware benchmark. The allocation is tight: 4 GiB passed these requests, but a nominal provider 4 GB allocation, other texts/speeds and platform overhead need actual hosted measurement. Do not present this as guaranteed headroom. Increase hosted memory if measurements require it rather than enabling swap as a throughput fix.

The built production frontend and actual Node proxy were also tested against the new inference image with all four existing Playwright tests: real public article extraction, valid non-silent decoded audio, contiguous scheduling, pause/resume, stop/restart, completion, layout and error recovery. The passing warm/ready run reported first audio 3.77 seconds, 46.2 seconds buffered and zero tested underruns. An initial run failed before the engine was ready; waiting on `/health` removed that startup race. These are local/headless observations, not physical listening quality or HF latency results.

## Publish before configuring HF

`.github/workflows/inference.yml` builds and runs real offline smoke checks on relevant PRs/main, then publishes from main using GITHUB_TOKEN:

- `ghcr.io/acramatte/article-reader-kokoro:stable`
- `ghcr.io/acramatte/article-reader-kokoro:sha-<full-commit>`

These are planned references until this change is committed, pushed and its workflow succeeds. This is a new GHCR package: verify/set its visibility to Public after first publication if anonymous HF pulling is intended. The reader package's visibility does not prove this new package is public. Keep immutable release references for HF; moving `stable` in GHCR does not itself trigger an HF deployment update.

## HF configuration

Keep the failed endpoint paused while preparing the image. Do not resume the unsupported default Transformers runtime.

In HF endpoint settings, select Custom Container and supply the published immutable inference image reference. Set the container port to **8000**, matching the image; leave its default command intact. Readiness route is **/health**; prediction route is **/tts**, with a root POST alias for clients that use the base URL. Use **Protected** access (TLS plus HF token), one maximum replica and CPU hardware. 2 vCPU / 4 GB is only a trial candidate given the tight local peak; select more memory if hosted load tests require it. Scale to zero is optional during initial validation; the reader does not yet gracefully retry cold-start 503s.

Use `hexgrad/Kokoro-82M` as the required HF model repository, preferably at the same tested revision. HF mounts repository artifacts at `/repository`. This image deliberately uses its bundled `/opt/kokoro` assets and does NOT automatically switch to that mount; the service pin remains stable even if the endpoint repo revision is changed. HF can still fetch/mount additional artifacts during provisioning, so image-local startup time does not establish endpoint provisioning time. No handler.py is needed for this custom container. See the current official custom-container guide for the UI fields:

https://huggingface.co/docs/inference-endpoints/en/engines/custom_container

After resume, confirm health and an authenticated WAV request, and rejection of requests without/with invalid tokens. Configure the VPS with:

`TTS_URL=https://6abe5e4765c8b62f2969dba2.endpoints.huggingface.cloud/tts`

Keep the endpoint-scoped HF credential only in the server-side protected environment file described in `deployment.md`. Do not paste it into chat, frontend configuration, Docker build arguments or Git. Test real VPS-to-HF-to-browser narration and sleeping/waking separately; no HF configuration, endpoint authentication, billing settings or VPS service changes have been executed by this local build/test work.
