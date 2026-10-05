# Opt-in Firecrawl extraction fallback

The default remains direct HTTP → local Readability, with no remote extraction. Set `ARTICLE_EXTRACTOR=firecrawl` on the **Node backend** to enable direct HTTP → one Firecrawl attempt → Readability → plain text. This is a general provider adapter, not an Angular/publisher branch, feed lookup, LLM summary or JSON content generation. The optional local renderer is still available separately via `ARTICLE_RENDERER_URL`; configuring both providers fails at startup rather than silently choosing/chaining them.

```sh
npm run build
# Load FIRECRAWL_API_KEY through your shell/secret manager, never VITE_* or git.
ARTICLE_EXTRACTOR=firecrawl npm start
```

`FIRECRAWL_API_KEY` is optional for local experiments: unauthenticated requests worked during the recorded run. That is **not a documented guest quota, availability guarantee or production credential strategy**. Use an account/API key with appropriate paid credits for production, and check [Firecrawl's current API documentation](https://docs.firecrawl.dev/api-reference/endpoint/scrape) and billing. Setting a key alone does not enable the provider. Unknown `ARTICLE_EXTRACTOR` values fail startup; unset it for the existing HTTP-only/local behavior. Container deployments can supply these backend variables through the existing private `env_file`; no Compose default is changed.

## Eligibility and trust boundary

- Only typed HTTP 403/429 blocks and missing/insufficient readable text trigger fallback. URL/DNS/SSRF/redirect validation failures, oversized HTML/text, unsupported MIME/encoding, HTTP 401 or 404, transport failures and cancellation do not trigger it. Provider failure is surfaced once with an actionable error; there is no application retry loop, paid/local provider chain, challenge-solving, credential forwarding or paywall/login integration.
- Requests go only to the fixed documented `https://api.firecrawl.dev/v2/scrape` endpoint. API redirects are rejected. The request asks for `formats: ['html']`, `onlyMainContent: true`, a 25-second provider timeout and `storeInCache: false`; it requests no summary, markdown, actions or generated JSON.
- Before submission, public HTTP/HTTPS URL/port/credential validation and **all-answer public DNS checks** run locally. Success requires API HTTP 2xx, `success: true`, numeric source HTTP 2xx, no source error, actual bounded HTML, and `metadata.sourceURL` matching the requested URL. Returned source DNS and final `metadata.url` (when exposed) are validated again. Private returned targets, unrelated provenance and API-200/source-404 error pages are rejected.
- **Managed egress is a third-party trust boundary.** Local DNS checks do not pin Firecrawl's connection, inspect its redirect chain/subresources, or prove its DNS/firewall behavior. The adapter checks exposed provenance/final metadata, not an independently observed provider navigation trace. The local renderer retains its separate pinned-IP/firewall boundary.
- Opt-in discloses the submitted public URL (including query strings) and fetched content to Firecrawl. Do not submit confidential URLs. `storeInCache: false` requests no new index/cache storage; it does not establish zero retention, prevent existing cache hits or replace the provider's terms/privacy policy. API keys stay server-side and are not returned to the browser. Managed latency, cost, cache state and backend/browser version are not guaranteed; no cold-run or latency/cost SLA is claimed.

## Limits and content

The adapter's 28-second deadline covers local DNS, submission and streamed JSON reads; the existing whole HTTP-plus-fallback path is 45 seconds. Caller cancellation propagates to remote fetch/body reads; it cannot guarantee cancellation of work already accepted/billed by the provider. JSON is capped at 6.1 MB before parsing, HTML at 3 MB, provider titles at 1,000 characters, Readability at 50,000 elements and article text at 100,000 characters. No unbounded retries or custom relay endpoint.

Metadata title is assigned through DOM `document.title` only when HTML lost its document title. Scripts/resources never execute locally. Small semantic UI, form-like signup widgets, collection controls and machine-data feedback outside article content are removed generically; code/JSON examples inside article content and later prose/FAQ are retained. This is not perfect boilerplate removal or a human completeness assessment. The UI continues to render **text**, never remote HTML. Provider auth/access, credits, rate-limit, transport, source-status, size and malformed-response failures have safe typed actionable errors; raw provider diagnostics are not reflected.

## Reproducible verification

```sh
npm test
npm run build
node scripts/benchmark-extraction.mjs --firecrawl --output="$PWD/docs/benchmarks/firecrawl-integration-extraction.json"
# Run a dedicated ready Kokoro, leaving any existing service untouched:
docker run -d --name article-reader-firecrawl-kokoro \
  -p 127.0.0.1:18000:8000 --memory=6g --memory-swap=6g --cpus=4 article-reader-kokoro:local
# Check readiness before the browser smoke; model initialization takes time.
curl --fail http://127.0.0.1:18000/health
TTS_URL=http://127.0.0.1:18000/tts node tests/firecrawl/real-smoke.mjs
docker rm -f article-reader-firecrawl-kokoro
# Actual packaged, non-root/read-only runtime with public extraction and asset MIME:
docker build -t article-reader:firecrawl-review .
node tests/firecrawl/container-smoke.mjs
```

Always clean up the dedicated inference container after failure too. Smoke scripts write real measurements under `docs/benchmarks/`; reruns overwrite their reports. The container smoke cleans up its own runtime container. The original `tests/renderer/real-smoke.mjs` remains a **local-renderer negative** test regardless of `ARTICLE_EXTRACTOR` in the shell. No Browser Use Cloud tests are part of this integration.

### Recorded Angular URL-to-audio result

[firecrawl-audio-smoke.json](benchmarks/firecrawl-audio-smoke.json) records direct source **403**, real Firecrawl source-404 rejection, API-404 rejection without article text, and the real browser path for the exact requested Angular URL. Extracted title and final compiler-port discussion are retained: **9,619 characters**. Three real Kokoro WAVs decode to RMS **0.0503 / 0.0450 / 0.0512**, with first audio **1.97 seconds** from the UI's measurement. Pause freezes the AudioContext clock, Resume restores running state, and Stop closes it; no page errors.

The measured opening has **one underrun and a 6.89-second gap** before the long third chunk. Chunking/synthesis/playback code is unchanged; short opening metadata/byline chunks still outrun the following CPU synthesis. This is successful URL-to-audio/control evidence, **not continuous-playback acceptance**, human listening quality or physical/mobile background qualification. Kokoro was already ready on a dedicated CPU container; Firecrawl cache state is unknown, so these are not cold-start numbers. The runtime Docker evidence is [firecrawl-container-smoke.json](benchmarks/firecrawl-container-smoke.json).
