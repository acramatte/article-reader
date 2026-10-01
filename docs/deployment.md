# Private VPS deployment

## Architecture and scope

The reader container serves the production frontend and Node article-extraction/API backend. It contains no Python service or TTS weights. Browser requests stay same-origin; the VPS alone calls HF over outbound HTTPS. Configure an HF **Protected** endpoint (TLS + HF-token authentication), not **Private** (AWS/Azure PrivateLink). The endpoint must accept `{text, voice, speed}` JSON and return a complete, correctly sized `audio/wav` response. HF endpoint/container provisioning and cold-start handling are separate work; this deployment does not make a generic HF model endpoint compatible automatically.

No VPS access, image publishing, or Watchtower configuration changes are performed by adding these files.

## Build and verify locally

- `npm test`
- `npm run build`
- `docker build -t article-reader:local .`
- `node scripts/smoke-container.mjs article-reader:local`
- Optional real network extraction: `node scripts/smoke-container.mjs article-reader:local https://www.paulgraham.com/greatwork.html`

The smoke test starts a temporary loopback-only container under production hardening/resource limits, checks health, non-root execution, bundled assets and SSRF rejection, then removes it. It does not verify HF synthesis or physical playback. The Docker build context is allowlisted: credentials, Python environments and models cannot be copied into the image by the current Dockerfile. Node is pinned by version and registry digest; only production npm dependencies enter the runtime image.

## Prepare the VPS (after choosing a registry and confirming a free port)

Use a separate Compose project, `article-reader`, without modifying Zaimutomo or starting a second Watchtower. Suggested reader address is `10.0.0.1:8084`; 8084 is NOT verified free. The host must already have `10.0.0.1` assigned by WireGuard before Compose starts.

Publish the tested image to your chosen registry first. For automatic Watchtower updates, use a dedicated mutable release-channel tag such as `:stable`; keep previous immutable version tags/digests for rollback. Digest-pinning the reader in Compose deliberately disables tag-based automatic updates. The base image stays digest-pinned in either case. No registry/repository is presumed or created here.

Place `compose.yaml` in a dedicated deployment directory. Set these non-secret Compose interpolation variables in that directory's `.env` or shell:

- `READER_IMAGE`: full published image reference (required).
- `TTS_URL`: full HF Protected HTTPS synthesis URL, including its route (required).
- `READER_PORT`: optional, defaults to 8084; do not reuse Zaimutomo's 8083.
- `READER_INFERENCE_ENV_FILE`: optional, defaults to `/etc/article-reader/inference.env`.

Create the inference environment file directly on the VPS, outside the repo/build context, readable only by the deployment administrator (mode 0600). It must contain `TTS_TOKEN` with a dedicated least-privilege HF credential authorized for this endpoint. Never use a frontend `VITE_*` variable. Docker administrators can inspect container environment variables, so Docker access is a privileged trust boundary. Do not paste tokens into chat, commands/history, diagnostics or version control.

Validate with `docker compose config --quiet` (not plain `config`, which can expose resolved credentials), then `docker compose pull` and `docker compose up -d`. Check `docker compose ps` and `/api/health` through WireGuard. Health checks test Node only, not paid inference; they must not keep a sleeping HF endpoint awake.

The service runs non-root, read-only, without Linux capabilities, with no-new-privileges, bounded logs and initial limits of 512 MiB / one CPU / 128 PIDs. These are starting limits, not VPS load-test results. Startup does not depend on HF being online. Docker health status alone does not restart an unhealthy running process; the restart policy handles process exits.

## VPN-only access and browser HTTPS

Compose explicitly publishes only `10.0.0.1`, never all host addresses. Inside the container, Node must bind `0.0.0.0` so Docker can reach it; this does not mean the host publishes on every interface. No host networking or Docker socket is mounted.

Binding a destination IP is not an ingress-interface firewall rule. Verify Docker forwarding/NAT rules as well as the host firewall: restrict the reader port to the actual WireGuard interface and reject non-VPN ingress using the VPS's existing Docker-aware firewall policy (e.g. DOCKER-USER where appropriate). Do not assume UFW alone controls published Docker ports, and do not rewrite rules for existing services. Validate all of these on the actual VPS:

1. From a VPN client, reader health and frontend load successfully.
2. From a non-VPN external client, the public VPS IP cannot reach the reader port.
3. Inference accepts the authorized VPS credential and rejects missing/invalid credentials.
4. Zaimutomo at `10.0.0.1:8083` still works unchanged.

`http://10.0.0.1:8084` is the initial VPN-only reader address. WireGuard encrypts the device-to-VPS link; the current AudioContext player does not generally require HTTPS. Test physical phone/browser playback rather than assuming compatibility. A remote HTTP address is not a browser secure context, so future service-worker/offline or AudioWorklet streaming features may require HTTPS. A private-resolving hostname with a trusted certificate can be added later without making the reader public. HTTPS/reverse-proxy setup is explicitly deferred; do not change the existing Kamal proxy for this deployment.

## Watchtower and rollback

The reader opts in with `com.centurylinklabs.watchtower.enable=true`, understood by Watchtower-compatible deployments. The existing VPS updater runs `nickfedor/watchtower --cleanup --no-pull --interval 60`. With `--no-pull`, publishing a new registry tag is NOT sufficient: Watchtower only notices changes to the local image cache. Leave that global setting unchanged to avoid changing other services' update behavior. For each reader release, explicitly run `docker compose pull reader` on the VPS, then either let Watchtower replace it on its next poll or run `docker compose up -d reader` for an immediate controlled deployment. Prefer the latter when verifying a release. Do not assume the enable label overrides global pull settings, scopes or explicit container allowlists.

The GitHub Actions workflow `.github/workflows/container.yml` tests, builds and smoke-tests on PRs and main, then publishes from main to `ghcr.io/acramatte/article-reader:stable` and `:sha-<full-commit>`. It authenticates using the workflow's `GITHUB_TOKEN`; no separate publishing secret is required. The repository is private; confirm the package's actual visibility after first publication. Keep the package private unless explicitly deciding otherwise. A private package requires a VPS pull credential with `read:packages` (GitHub documents a classic PAT for external GHCR clients). Provision credentials through a secure local/SSH workflow, not chat or checked-in files. Confirm the Docker configuration for the administrator who runs Compose; do not print it. The existing Watchtower has only a Docker socket mount and does not need registry access for this no-pull path, because Compose performs the pull.

Watchtower cannot rebuild this Dockerfile on the VPS. Do not mount the Docker socket into the reader. Automatic replacement is not an application-level rollback guarantee: retain a known-good immutable image reference and redeploy it manually if needed. `--cleanup` removes old images after replacement, so rollback may require re-pulling the retained immutable registry tag. Commit/push, first workflow execution, package visibility/pull permissions and deployment have not yet been performed by these local files.

## Remaining gates

The existing app has no user auth, rate limiting or bounded concurrency admission; VPN access is the initial access boundary, not protection against a compromised VPN peer. Before routine use, bound synthesis concurrency/queueing at the app and inference service to prevent overspending. HF scale-to-zero can return 503 during startup; the app currently reports this as a provider error and has a 120-second timeout. Add explicit cold-start UX and bounded retry handling before claiming seamless on-demand startup. Test real URL-to-HF-to-browser narration, prolonged memory/CPU coexistence, network failure and physical phone playback before production acceptance. Do not expose this prototype publicly as-is.
