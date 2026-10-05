# Optional local renderer fallback

The renderer is a **local, opt-in experiment**, not a production deployment change. Independently, the reader now has one automatic, narrowly allowlisted official publisher RSS fallback: `https://blog.angular.dev/feed`, only after HTTP 403/429 for an HTTPS Angular blog article URL without query/fragment. This inexpensive fallback runs before any browser attempt and also works with the renderer disabled. Feed failures are surfaced without retries or browser substitution. The normal reader still fetches pinned public IPs and parses with Readability without running scripts. `ARTICLE_RENDERER_URL` enables one browser attempt only after a typed HTTP 403/429 block or an extraction with no/insufficient readable text. URL/DNS/SSRF/redirect validation, MIME/size limits, HTTP 401 authentication responses, cancellation and transport errors **never** trigger it. A second failure is surfaced; there is no browser retry loop.

## Run

From the repository root, with Docker Engine on Linux and Node 24:

```sh
npm ci --include=dev
docker compose --project-name article-renderer-local --env-file /dev/null -f compose.renderer-local.yaml up --build -d
curl --fail http://127.0.0.1:3002/health
npm run build
ARTICLE_RENDERER_URL=http://127.0.0.1:3002/render npm start
```

Retry the health check until the sandboxed browser is ready. Use `RENDERER_LOCAL_PORT=13002` if 3002 is occupied, and update the reader endpoint accordingly. The explicit empty env file avoids implicitly loading a deployment `.env`. Start Kokoro separately as in the README. Neither existing inference nor `compose.yaml` is modified. Stop this setup with the same compose command and `down` instead of `up --build -d`.

This setup reserves **172.30.197.0/29**. If it collides with an existing network, choose a different unused subnet and update the compose addresses **and** the hardcoded proxy/ingress rules in `renderer/entrypoint.sh` together. Do not remove the firewall, add a default internet network to the browser, or publish its control port to make networking work.

## Security boundary

- Browser and Node render service are in an internal-only Docker network. A firewall in that container network namespace permits new outbound TCP connections **only** to `172.30.197.2:3128`, the public-only proxy. Direct public internet, Docker DNS, loopback, host bridge, metadata, renderer control and proxy relay connections are denied; IPv6 output/input defaults to deny. Replies to fixed proxy-container control ingress are allowed.
- The short bootstrap starts as root with only `NET_ADMIN`, `SETUID`, `SETGID`, and `SETPCAP`, installs the namespace-local firewall and **drops all capabilities, including the bounding set**, before starting Node as UID/GID 1000. It never edits host firewall rules. Runtime browser/Node processes have no outer-namespace capabilities. Chromium itself uses nested unprivileged user/network namespaces for its sandbox; those cannot change the outer firewall.
- `chromiumSandbox: true` is mandatory. No `--no-sandbox`, privileged mode, host networking, `SYS_ADMIN`, or unconfined seccomp/AppArmor is used. Failure to initialize the sandbox/firewall is fatal, not silently downgraded. Hosts that prohibit unprivileged user namespaces need an administrator-reviewed host policy; do not disable sandboxing to work around it.
- `renderer/seccomp.json` is the Moby default profile at commit `2ceae35d351c156cb5a8efc0fdc4a08cf94569d8`, plus `clone`, `setns`, `unshare`, and `chroot` for the Chromium user-namespace sandbox, and AF_NETLINK socket creation for the capability-limited firewall bootstrap. Other default-denied syscalls stay denied.
- The HTTP/CONNECT proxy checks **all** DNS answers, rejects any non-public answer, and connects to the selected **literal IP**. Every new connection rechecks DNS. HTTP redirects and JS/subresource connections traverse the same proxy; HTTPS CONNECT accepts only unambiguous authority syntax on port 443. URL schemes, ports and credentials are restricted. No public proxy port is published.
- Chromium's implicit loopback proxy bypass is disabled; direct hostname resolution and QUIC are disabled. Non-proxied WebRTC UDP is disabled and the firewall independently denies direct sockets. Service workers are blocked, WebSockets are closed through context routing, and routed browser writes are denied. The public-only proxy remains the SSRF boundary even for browser networking that is not observed by Playwright routing.
- A fixed-target local relay on the **proxy** container publishes only `127.0.0.1:3002`. It forwards `/health` and `/render` to the renderer, never an arbitrary target. The renderer itself has no published port. Browser-origin requests are rejected. This is not authentication: do not expose the relay publicly or to untrusted local users.
- Fresh browser contexts discard cookies/storage after every success/failure/cancellation. Native dialogs are dismissed; modal UI is removed only from the serialized DOM copy. The renderer does not click consent controls, solve challenges, log in, or bypass paywalls. Returned HTML is parsed with non-executing Readability and the existing UI renders text, not publisher HTML.

## Bounds and caveats

One render at a time; overlap returns 429 without queueing. Rendering has a 25-second deadline, the client a 28-second deadline and the entire normal-fetch-plus-fallback path 45 seconds. Main-frame requests allow at most six navigation/redirect requests; context routing permits 200 requests. CDP-observed page response bytes are limited to 16 MB, each proxy connection/tunnel to 16 MB and 35 seconds, and the proxy to 64 concurrent sockets. Serialized HTML is limited to 3 MB; the client bounds JSON bytes before parsing. Existing article text/element limits remain in force. Containers have read-only roots, bounded tmpfs, memory, CPU and PID limits.

After DOMContentLoaded, the renderer waits at most **8 seconds** for at least 200 characters of paragraph/pre/blockquote content in article/main (or body), unchanged for **750 ms**. Dialog/navigation/aside content is excluded. It does not wait for networkidle; stalled analytics cannot hold readiness open. A real sandboxed fixture inserting its article after **3 seconds** verifies the delayed-content path. This heuristic can still settle before later updates on some publishers. These limits are safety budgets, not a guarantee that a page fully renders. CDP page accounting is not a universal cross-worker aggregate; per-connection bounds, admission and container limits remain independent safeguards. Cancellation closes the fresh context and awaits its actual teardown before releasing admission.

The browser image is pinned to Playwright `v1.63.0-noble` plus its manifest digest. The npm Playwright dependency is exactly `1.63.0`, with a build-time compatibility assertion and lockfile. The added firewall package is pinned to Ubuntu's `iptables=1.8.10-3ubuntu2`; its distribution dependencies are resolved by apt. Revisit image/package pins together when updating. This remains a prototype needing independent security review before any deployment.

## Verification

```sh
npm test
npm run build
# Actual firewall and runtime-capability checks against the running service:
docker exec -i --user 1000 article-renderer-local-renderer-1 node --input-type=module < tests/renderer/egress-check.mjs
# Real sandboxed Chromium, deliberately synthetic JS/modal/private-DNS fixtures:
docker run --rm --network article-renderer-local_browser --user pwuser --cap-drop ALL \
  --security-opt no-new-privileges --security-opt seccomp=renderer/seccomp.json \
  --read-only --tmpfs /tmp:rw,nosuid,size=256m --shm-size 256m --memory 1g --cpus 2 --pids-limit 256 \
  -v "$PWD/tests:/app/tests:ro" article-reader-renderer:local node tests/renderer/container-smoke.mjs
```

The fixture container deliberately has no production firewall bootstrap so its injected test-only proxy can use local fixture sockets. It still runs non-root sandboxed Chromium in the internal network with no capabilities. Production namespace egress is independently checked by `egress-check.mjs`. No runtime environment switch enables private upstream targets.

### Angular publisher check and actual URL-to-audio

The requested URL, `https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a`, remains blocked by Cloudflare in direct HTTP and browser checks. The reader now succeeds **without solving the challenge**, by reading that exact article from the legitimate publisher's public RSS `content:encoded` field.

The only feed is hardcoded `https://blog.angular.dev/feed`; there is no generic discovery, arbitrary feed input, search, or title/slug matching. The RSS item link must match the complete requested canonical URL exactly. Angular's observed fixed RSS attribution suffix `?source=rss----447683c3d9a3---4` is removed from feed links only; arbitrary query parameters are not removed. A missing or ambiguous item, malformed feed or failed request returns an error. Rolling feeds may eventually omit older articles.

Every feed connection uses existing strict URL validation, all-answer public DNS validation, and pinned IP transport. Redirects are limited to five, revalidated each time and additionally cannot leave the publisher HTTPS origin. MIME must be RSS/XML, identity encoding only, bytes at most 3 MB, XML at most 50,000 elements, and the whole feed lookup (including DNS) has a 10-second deadline plus caller cancellation. DTD/entity declarations are rejected. XML/HTML parsing executes no scripts and loads no resources; item HTML goes through existing Readability/text limits. No cookies, credentials or login access are used. Success reports `source: "publisher-rss"` and preserves the requested URL.

With a ready local Kokoro service:

```sh
npm run build
TTS_URL=http://127.0.0.1:8000/tts node tests/renderer/real-smoke.mjs
```

This real-network check verifies `/api/article` **200**, enters the actual URL into the UI and clicks Read, observes a second real article API **200**, and waits for actual Kokoro WAV decoding and source starts. It never pastes text or mocks extraction/inference. It checks pause clock freeze and Stop closure, saving `angular-first-chunk.wav`, `publisher-feed-playing.png`, and `real-smoke.json` in ignored `.ui-review/renderer/`.

Observed on local CPU Kokoro limited to four CPUs/6 GiB: **9,700 characters**, first usable audio **1.34 seconds**, decoded durations **2.475/31.625 seconds**, RMS **0.0450/0.0512**. There was **one underrun and a 7.94-second scheduling gap** after the short author-name first chunk, so continuous playback is **not established**. Pause and Stop passed. Playback chunking was intentionally not changed. This verifies non-silent generated audio and headless scheduling, not physical speaker output or human-perceived speech quality.

Security regression coverage also sends a real upstream `HTTP/1.1 000` response to the proxy: it returns **502**, closes upstream, and serves the next request successfully instead of crashing the proxy/relay process. Response-callback exceptions are contained; the fixed local relay validates upstream status as well.
