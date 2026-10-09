# Private VPS deployment

## Architecture and scope

The reader container serves the production frontend and Node article-extraction/API backend. It includes FFmpeg for server-owned continuous MP3 encoding, but no Python service or TTS weights. Browser requests stay same-origin; the VPS alone calls HF over outbound HTTPS. Configure an HF **Protected** endpoint (TLS + HF-token authentication), not **Private** (AWS/Azure PrivateLink). The endpoint must match `TTS_ENGINE`: `pocket` (default) uses the `pocket-tts-service` image (see [HF inference](hf-inference.md)); opt-in `kokoro` uses `kokoro-service`. Both accept `{text, voice, speed: 1}` JSON and return a complete, correctly sized mono 24-kHz PCM16 `audio/wav` response. Pocket voices are `jane`, `bill_boerst` and `estelle`; Kokoro voices are `af_heart`, `am_michael` and `ff_siwis`. The reader applies 0.5–2× narration speed itself, with FFmpeg `atempo` in the streaming encoder. HF endpoint/container provisioning is separate work; the reader's bounded cold-start retry policy is described below. This deployment does not make a generic HF model endpoint compatible automatically.

No VPS access, image publishing, CI run, or Watchtower configuration changes are performed by adding these files.

## Reader/inference pairing

Pair the reader's `TTS_ENGINE`, endpoint URL and endpoint-scoped token. The default `pocket` catalog is incompatible with a Kokoro endpoint; opt-in `TTS_ENGINE=kokoro` retains compatibility with that service using its three selected narration voices at `speed: 1`. Conversely, an older reader's Kokoro IDs and non-1 speeds are rejected by Pocket TTS. Production currently pairs an older reader with a Kokoro endpoint: upgrading the reader with the default engine but keeping that endpoint breaks narration. There is no automatic engine detection or failover.

- **Stage first**: run a staged reader against a separate staged Pocket TTS endpoint, never against the production endpoint, and verify real narration for all three voices.
- **Roll out as a pair**: deploy the matching reader image and set `TTS_ENGINE`, `TTS_URL` and the endpoint-scoped `TTS_TOKEN` to the verified configuration in the same controlled change. For Pocket use `TTS_ENGINE=pocket`; to retain Kokoro use `kokoro` and verify a staged reader against a matching staged endpoint first. Update the Compose interpolation variables and inference environment file before `docker compose pull reader`, then run `docker compose up -d reader` immediately: once a new image is in the local cache, Watchtower can recreate the container from it with the old settings on its next 60-second poll (see below).
- **Roll back as a pair**: restore the previous immutable reader image together with its engine setting, endpoint URL and token. Keep the previous endpoint paused, not deleted, until the new pair is accepted. Changing the startup engine or restarting the reader discards existing recordings; reload browser pages to load the new catalog.

No production rollout has been authorized or performed.

## Build and verify locally

- `npm test`
- `npm run build`
- `docker build -t article-reader:local .`
- `node scripts/smoke-container.mjs article-reader:local`
- Optional real network extraction: `node scripts/smoke-container.mjs article-reader:local https://www.paulgraham.com/greatwork.html`

The smoke test starts a temporary loopback-only container under production hardening/resource limits, checks health, non-root execution, bundled assets and SSRF rejection, then removes it. It does not verify HF synthesis or physical playback. The Docker build context is allowlisted: credentials, Python environments and models cannot be copied into the image by the current Dockerfile. Node is pinned by version and registry digest; only production npm dependencies enter the runtime image.

## Prepare the VPS (after choosing a registry and confirming a free port)

Use a separate Compose project, `article-reader`, without modifying unrelated services or starting a second Watchtower. Suggested reader address is `10.0.0.1:8084`; 8084 is NOT verified free. The host must already have `10.0.0.1` assigned by WireGuard before Compose starts.

Publish the tested image to your chosen registry first. For automatic Watchtower updates, use a dedicated mutable release-channel tag such as `:stable`; keep previous immutable version tags/digests for rollback. Digest-pinning the reader in Compose deliberately disables tag-based automatic updates. The base image stays digest-pinned in either case. No registry/repository is presumed or created here.

Place `compose.yaml` in a dedicated deployment directory. Set these non-secret Compose interpolation variables in that directory's `.env` or shell:

- `READER_IMAGE`: full published image reference (required).
- `TTS_ENGINE`: `pocket` (default) or `kokoro`; must match the endpoint. Set it here, not only in the inference environment file: Compose's explicit `environment` entry takes precedence over `env_file`.
- `TTS_URL`: full HF Protected HTTPS synthesis URL, including its route (required).
- `READER_PORT`: optional, defaults to 8084; confirm it does not conflict with another service.
- `READER_INFERENCE_ENV_FILE`: optional, defaults to `/etc/article-reader/inference.env`.

Create the inference environment file directly on the VPS, outside the repo/build context, readable only by the deployment administrator (mode 0600). It must contain `TTS_TOKEN` with a dedicated least-privilege HF credential authorized for this endpoint. Never use a frontend `VITE_*` variable. Docker administrators can inspect container environment variables, so Docker access is a privileged trust boundary. Do not paste tokens into chat, commands/history, diagnostics or version control.

Validate with `docker compose config --quiet` (not plain `config`, which can expose resolved credentials), then `docker compose pull` and `docker compose up -d`. Check `docker compose ps` and `/api/health` through WireGuard. Health checks test Node only, not paid inference; they must not keep a sleeping HF endpoint awake.

The service uses a dedicated 272-MiB `/spool` tmpfs owned by UID 1000, in addition to a small `/tmp`. This covers the default four 64,000,000-byte recording limits with headroom; increase the spool and memory budget together if increasing those limits. `STREAM_MAX_AUDIO_BYTES` allows up to 1,000,000,000 bytes per recording, but does not resize that tmpfs (the real-inference smoke also fixes it at 272 MiB). Provision at least `STREAM_MAX_SESSIONS × STREAM_MAX_AUDIO_BYTES` plus filesystem headroom, and increase the container memory budget accordingly. Otherwise the filesystem can fill before the configured byte limit, failing generation with a storage-write error; the configured byte limit produces the separate “disk limit” error. The ownership lock lives inside `/spool`, so its parent does not need to be writable. Recordings are temporary: restart/redeployment loses the in-memory session map and recovery cannot survive it.

The service runs non-root, read-only, without Linux capabilities, with no-new-privileges, bounded logs and initial limits of 512 MiB / one CPU / 128 PIDs. These are starting limits, not VPS load-test results. Startup does not depend on HF being online. Docker health status alone does not restart an unhealthy running process; the restart policy handles process exits.

## VPN-only access and browser HTTPS

Compose explicitly publishes only `10.0.0.1`, never all host addresses. Inside the container, Node must bind `0.0.0.0` so Docker can reach it; this does not mean the host publishes on every interface. No host networking or Docker socket is mounted.

Binding a destination IP is not an ingress-interface firewall rule. Verify Docker forwarding/NAT rules as well as the host firewall: restrict the reader port to the actual WireGuard interface and reject non-VPN ingress using the VPS's existing Docker-aware firewall policy (e.g. DOCKER-USER where appropriate). Do not assume UFW alone controls published Docker ports, and do not rewrite rules for existing services. Validate all of these on the actual VPS:

1. From a VPN client, reader health and frontend load successfully.
2. From a non-VPN external client, the public VPS IP cannot reach the reader port.
3. Inference accepts the authorized VPS credential and rejects missing/invalid credentials.
4. Existing services remain reachable and unchanged.

`http://10.0.0.1:8084` is the initial VPN-only reader address. WireGuard encrypts the device-to-VPS link; the native HTML audio player does not generally require HTTPS. Test physical phone/browser playback rather than assuming compatibility. A remote HTTP address is not a browser secure context, so future service-worker/offline or AudioWorklet streaming features may require HTTPS. A private-resolving hostname with a trusted certificate can be added later without making the reader public. HTTPS/reverse-proxy setup is explicitly deferred; do not change the existing Kamal proxy for this deployment.

Status uses same-origin SSE at `/api/streaming/:id/events`, separate from the native MP3 connection. If adding a proxy, disable response buffering, caching and compression buffering for this route, and set its read/idle timeout above the 15-second heartbeat interval with headroom (for example, 60 seconds). The app sends `X-Accel-Buffering: no` and `Cache-Control: no-store, no-transform`; verify the proxy honors them and forwards each event promptly. HTTP/1.1 works; HTTP/2 or HTTP/3 is not required. Mobile suspension or a transport drop can delay the UI, but reconnect sends the current state without restarting synthesis. A permanent SSE HTTP rejection is diagnosed once through the JSON snapshot endpoint, with explicit retry if the recording still exists. These are deployment requirements, not changes to existing VPS infrastructure.

## Watchtower and rollback

The reader opts in with `com.centurylinklabs.watchtower.enable=true`, understood by Watchtower-compatible deployments. The existing VPS updater runs `nickfedor/watchtower --cleanup --no-pull --interval 60`. With `--no-pull`, publishing a new registry tag is NOT sufficient: Watchtower only notices changes to the local image cache. Leave that global setting unchanged to avoid changing other services' update behavior. For each reader release, explicitly run `docker compose pull reader` on the VPS, then either let Watchtower replace it on its next poll or run `docker compose up -d reader` for an immediate controlled deployment. Prefer the latter when verifying a release. Do not assume the enable label overrides global pull settings, scopes or explicit container allowlists.

The GitHub Actions workflow `.github/workflows/container.yml` tests, builds and smoke-tests on PRs and main, then publishes from main to `ghcr.io/acramatte/article-reader:stable` and `:sha-<full-commit>`. It authenticates using the workflow's `GITHUB_TOKEN`; no separate publishing secret is required. The repository is private; confirm the package's actual visibility after first publication. Keep the package private unless explicitly deciding otherwise. A private package requires a VPS pull credential with `read:packages` (GitHub documents a classic PAT for external GHCR clients). Provision credentials through a secure local/SSH workflow, not chat or checked-in files. Confirm the Docker configuration for the administrator who runs Compose; do not print it. The existing Watchtower has only a Docker socket mount and does not need registry access for this no-pull path, because Compose performs the pull.

Watchtower cannot rebuild this Dockerfile on the VPS. Do not mount the Docker socket into the reader. Automatic replacement is not an application-level rollback guarantee: retain a known-good immutable image reference and redeploy it manually if needed. `--cleanup` removes old images after replacement, so rollback may require re-pulling the retained immutable registry tag. A reader rollback must also restore the inference endpoint it was paired with (see [pairing](#readerinference-pairing)). Commit/push, first workflow execution, package visibility/pull permissions and deployment have not yet been performed by these local files.

## Remaining gates

VPN access is the access boundary, not protection against a compromised VPN peer; the reader does not enforce per-user rate limits. Streaming has one generating narration, four retained sessions and explicit disk/time/text limits by default, with no waiting queue. This does not bound traffic to the compatibility `/api/tts` endpoint or constitute an inference-service abuse policy. The compatibility `/api/tts` route accepts only `speed: 1`. Verify inference admission and cost controls before routine hosted use; the [local Pocket TTS measurements](hf-inference.md#local-verification) do not establish hosted sizing. HF scale-to-zero can return 503 during startup. The backend forwards it as a structured `INFERENCE_UNAVAILABLE` 503 with `Retry-After`; only that response is retried by the server-owned streaming provider (the legacy WAV route still forwards it). Each chunk has one 180-second total deadline (including response-body transfer), at most 20 attempts, and exponential 1/2/4/8-second backoff capped at 10 seconds; a longer numeric/date `Retry-After` takes precedence. The UI shows “Speech engine is waking up…” until success, error or Stop. Stop cancels server retry waits and fetches; it cannot cancel HF provisioning or native synthesis already started. Authentication, busy, non-503 and ambiguous transport failures are not retried. The legacy WAV endpoint retains its 120-second timeout. Streaming separately defaults to a twenty-minute generation deadline and six-hour recording retention; see the README's `STREAM_*` configuration table. There is no background warm-up polling; health remains local. A 503 can also mean overload rather than cold start, so the bounded policy must end with an actionable error. Test real URL-to-HF-to-browser narration, prolonged memory/CPU coexistence, network failure and physical phone playback before production acceptance. Do not expose this prototype publicly as-is.
