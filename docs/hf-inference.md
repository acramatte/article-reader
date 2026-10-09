# Pocket TTS CPU inference on Hugging Face

## Separate image

The reader image contains Node and frontend assets only. Build this separate inference image with:

`docker build -t article-reader-pocket-tts:local pocket-tts-service`

`python3 scripts/smoke-pocket-tts.py article-reader-pocket-tts:local`

The image uses Python 3.12.14 (digest-pinned), a resolved dependency lock, Pocket TTS 3.3.0, CPU-only Torch 2.14.1+cpu and torchao 0.18.0+cpu. The upstream source reference is [Pocket TTS v3.3.0](https://github.com/kyutai-labs/pocket-tts/tree/v3.3.0), matching the installed package rather than newer repository code. Regenerate the lock using the command in `pocket-tts-service/requirements.txt`; do not resolve production dependencies anew during deployment. System libraries are installed from Debian's package repositories (not a snapshot-locked OS package set).

Public, non-cloning assets from `kyutai/pocket-tts-without-voice-cloning` are bundled at `/opt/pocket-tts` at build time. Both models and voice states use the installed release's pins: weights/tokenizers come from its model configurations, and voice-state URLs come from its `get_predefined_voice()` helper. In 3.3.0 the voice revision is `4e1e0a3e611c51c0b4ed8174fc10f32a54644303`; it is not independently hard-coded in this service. Voice states from a newer release must not be mixed with these weights. The build rewrites configurations to local paths, so runtime does not resolve them again. The model card and an `assets.json` manifest with the package version, resolved voice revisions and staged-file SHA-256 hashes accompany them. The gated voice-cloning checkpoint is never requested, and the service accepts no reference audio.

Bundled precomputed voices:

| ID | Voice | Language | Source and license |
| --- | --- | --- | --- |
| `jane` | Jane, American female | English | VCTK speaker p339 (Pennsylvania), CC BY 4.0: attribution required |
| `bill_boerst` | Bill Boerst, American male (reading voice) | English | CC0 |
| `estelle` | Estelle, female | French | CC0 |

No French male voice is offered; this is intentional. [Model and voice attribution](../pocket-tts-service/NOTICES.md) is also bundled at `/opt/pocket-tts/NOTICES.md`; preserve it when redistributing the image.

No HF credential is used or bundled. The build downloads only public files with token use disabled, then enables Hub offline mode; the runtime needs no network access or HF token. The build scanner's `HF_HUB_DISABLE_IMPLICIT_TOKEN` warning refers to a public boolean setting, not a secret.

The service loads both quantized models (English and French) and prepares all three voice states before Uvicorn begins listening. Readiness is `GET /health` returning 200 only once loading has completed; until then connection attempts may fail. Always wait for readiness in tests and deployments. `POST /tts` (and `POST /`) accepts `{text, voice, speed}` JSON and returns complete mono 24-kHz PCM16 WAV with timing headers and `Cache-Control: no-store`. Text is 1–1,000 characters with non-whitespace content and voices are allowlisted to the three IDs above. `speed` must be `1` (or omitted); any other value is rejected with 422 rather than ignored. Speed adjustment belongs to the reader (see below). The previous Kokoro voice IDs (`af_heart`, `af_nicole`, `am_michael`, `ff_siwis`) are rejected.

There is one Uvicorn worker. Inference is serialized across both models: at most one request is active and one waits; further requests return 429 with `Retry-After`. Uvicorn also caps connection concurrency at eight. Use exactly one replica initially, so models and admission state are not multiplied. Request text is not logged.

### Speed

The reader always requests `speed: 1`. Streaming narration applies the selected 0.5–2× speed in its FFmpeg MP3 encoder with the `atempo` filter, and divides generated-audio duration by the speed so progress and position accounting match the encoded tempo. The frontend speed choices are unchanged. The raw `/api/tts` WAV route rejects any speed other than 1. `atempo` changes tempo without changing pitch, but does not control the model's natural cadence or prosody.

HTTP disconnect does not interrupt ongoing native Pocket TTS computation. A waiting request can also still generate after its client disconnects. This bounded overlap supports the reader's stop/restart flow but does not claim compute cancellation or public abuse protection. Authentication is supplied by the HF Protected endpoint, not this container; never expose the container directly as an unauthenticated public service. The reader backend still needs its own admission/rate policy for compromised VPN peers or multiple readers.

## Local verification

`smoke-pocket-tts.py` starts a non-root, read-only container with no external network, no capabilities and the resource limits defined in the script. It sends real HTTP inference requests and validates the WAVs. For its fixed narrative passages, validation also rejects durations above 0.25 seconds per input character, even if the PCM is well-formed and non-silent. This generous bound catches runaway output; it does not establish intelligibility or subjective quality. `python3 -m unittest discover -s pocket-tts-service -p 'test_*.py'` tests both sides of the duration boundary with synthetic WAVs, independently of real inference. The container smoke does not fabricate a model response or require HF access at runtime. On failure it captures Docker state (including OOMKilled) and logs before forcibly removing the container; cleanup does not mask the original exception.

- **Quick mode (CI)**: `python3 scripts/smoke-pocket-tts.py article-reader-pocket-tts:ci --quick` checks readiness in the offline container, one short synthesis for each of the three voices with WAV validity/non-silence, rejection of invalid inputs (including old voice IDs and `speed` other than 1), and no request-text logging. The runner has a 300-second process deadline and the workflow step a six-minute deadline. This is a packaging smoke, NOT a load or deployment-sizing test.
- **Full mode (manual)**: the same command without `--quick` adds longer inputs, concurrent requests (one active, one waiting, 429 and subsequent recovery) and repeated requests, under a 900-second process deadline.

The corrected offline container smoke passed locally on 2026-10-09, on an Intel Xeon 2.60 GHz orb with two vCPUs, a two-CPU container quota and a 4-GiB/no-swap limit. The 30 repeated mixed-language requests produced 503.2 seconds of audio in 342.6 seconds of synthesis (1.47× real time). Cgroup memory peaked at 1,677 MiB; post-request readings ranged from 1,471 to 1,639 MiB and ended at 1,517 MiB. All cgroup OOM counters were zero. This kernel lacks `memory.swap.peak`; the test verified `memory.swap.max = 0` and `memory.swap.current = 0`. Cgroup memory includes charged cache and is not process RSS. The earlier mismatched build's 1.52× real-time and 1.62-GiB peak results are withdrawn and must not be used for sizing.

This is a short bounded run, not proof of no long-term memory growth, a production sizing guarantee, or a controlled speed comparison with Kokoro. At 2× playback the measured synthesis throughput cannot keep up indefinitely, so buffering is possible until the recording is complete. Test sustained articles on the actual hosted CPU before accepting a performance improvement. Earlier testing while the orb also ran a second inference process and browser/build work timed out; avoid using that contended run as a throughput measurement.

`npm test` passed 70 tests, including real FFmpeg duration/pitch checks at 0.5×, 1.5× and 2×. The browser suite passed 35/36 tests, including real narration for all three voices and recording recovery. The remaining mobile headline assertion expects two lines but renders four at 320px on both the unchanged HEAD baseline and this change; it is unrelated to the voice catalog. Desktop and mobile voice settings were visually inspected. HF deployment, physical phone playback and subjective voice quality are not established by these checks.

## Publish before configuring HF

`.github/workflows/inference.yml` builds and runs the quick offline smoke on relevant PRs/main, then publishes from main using `GITHUB_TOKEN`:

- `ghcr.io/acramatte/article-reader-pocket-tts:stable`
- `ghcr.io/acramatte/article-reader-pocket-tts:sha-<full-commit>`

The workflow also builds/smoke-tests the retained Kokoro image independently and publishes `ghcr.io/acramatte/article-reader-kokoro` with the same tags from main. Keeping both images available does not load or start both engines; the reader selects one endpoint/catalog at startup. See the [optional Kokoro setup](../README.md#optional-kokoro-backend).

These are planned references until the commits are pushed and CI publishes the image. It will be a new GHCR package: verify/set its visibility to Public after first publication if anonymous HF pulling is intended. Neither the reader package's nor the old `-kokoro` package's visibility proves that this package is public. Keep immutable release references for HF; moving `stable` in GHCR does not itself trigger an HF deployment update.

## Reader and inference compatibility

The default `TTS_ENGINE=pocket` reader sends `jane`, `bill_boerst` and `estelle` with `speed: 1`; the Kokoro image rejects those IDs. Opt-in `TTS_ENGINE=kokoro` uses Heart, Michael and Siwis IDs against a matching Kokoro endpoint, still requesting speed 1. An older reader sends Kokoro IDs and speeds other than 1, which this Pocket image rejects. Deploy and roll back the reader engine setting, endpoint URL and credentials together:

1. Create a **separate staged** HF endpoint for the Pocket TTS image. Do not change the image of the endpoint that production currently uses.
2. Run a staged reader with `TTS_ENGINE=pocket` against the staged endpoint and verify real narration end to end.
3. Cut over production in one controlled change: set `TTS_ENGINE=pocket`, repoint the production reader's `TTS_URL` and token to the verified endpoint, and deploy the matching reader image.
4. Roll back as a pair: restore the previous reader configuration and endpoint URL/token; a current reader using the old Kokoro endpoint needs `TTS_ENGINE=kokoro`. Keep the old endpoint paused (resume it to roll back), not deleted, until the new pair is accepted.

No production action is authorized by this documentation change.

## HF configuration

Do not resume the unsupported default Transformers runtime.

In the staged HF endpoint's settings, select Custom Container and supply the published immutable inference image reference. Set the container port to **8000**, matching the image; leave its default command intact. Readiness route is **/health**; prediction route is **/tts**, with a root POST alias for clients that use the base URL. Use **Protected** access (TLS plus HF token), one maximum replica and CPU hardware. Choose hardware size from hosted measurements; the local smoke is only a starting point. Scale to zero is optional during initial validation; see [deployment](deployment.md#remaining-gates) for the reader's bounded cold-start retries.

Use `kyutai/pocket-tts-without-voice-cloning` as the required HF model repository, preferably at the voice revision above. HF mounts repository artifacts at `/repository`. This image deliberately uses its bundled `/opt/pocket-tts` assets and does NOT switch to that mount, so the service pin stays stable even if the endpoint repo revision changes. HF can still fetch/mount additional artifacts during provisioning, so local startup time does not establish endpoint provisioning time. No `handler.py` is needed for this custom container. See the current official custom-container guide for the UI fields:

https://huggingface.co/docs/inference-endpoints/en/engines/custom_container

After startup, confirm health, an authenticated WAV request for each voice, and rejection of requests without a token or with an invalid one. Configure the **staged** reader's `TTS_URL` with the staged endpoint's full `/tts` URL. The current production reader uses `TTS_URL=https://6abe5e4765c8b62f2969dba2.endpoints.huggingface.cloud/tts`; keep it unchanged until the paired cutover above.

Keep each endpoint-scoped HF credential only in the server-side protected environment file described in `deployment.md`. Do not paste it into chat, frontend configuration, Docker build arguments or Git. Test real VPS-to-HF-to-browser narration and sleeping/waking separately. No HF configuration, endpoint authentication, billing settings, CI run, image publication or VPS service changes have been executed by this work.
