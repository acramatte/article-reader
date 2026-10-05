# Extraction benchmark: local renderer and managed probe

This is measured public-network extraction, not a renderer coverage claim or a narration benchmark. No login, challenge solving, paywall bypass, publisher RSS, search result, generated summary, or pasted text was used. The app still uses direct fetch plus optional local renderer only; Firecrawl is **benchmark-only**.

## Reproduce

Node 24, installed dependencies, Docker Engine on Linux, and the renderer image are required. From the repository root:

```sh
npm ci --include=dev
npm test
npm run build
# Build if the local image is not already available:
docker compose -p pr9-local-benchmark -f compose.renderer-local.yaml build
# The fixed 172.30.197.0/29 subnet cannot overlap another running renderer project.
RENDERER_LOCAL_PORT=19302 docker compose -p pr9-local-benchmark -f compose.renderer-local.yaml up -d --no-build --wait
# Always run cleanup, including after a failed benchmark.
trap 'docker compose -p pr9-local-benchmark -f compose.renderer-local.yaml down' EXIT
ARTICLE_RENDERER_URL=http://127.0.0.1:19302/render \
RENDERER_IMAGE_ID="$(docker image inspect article-reader-renderer:local --format '{{.Id}}')" \
node scripts/benchmark-extraction.mjs --output="$PWD/docs/benchmarks/local-extraction.json"
ARTICLE_RENDERER_URL=http://127.0.0.1:19302/render node tests/renderer/real-smoke.mjs
docker compose -p pr9-local-benchmark -f compose.renderer-local.yaml down
trap - EXIT

# Optional managed probe: public no-key access worked in this run, not guaranteed.
# If required, set FIRECRAWL_API_KEY in the shell; it is never recorded.
node scripts/benchmark-extraction.mjs --firecrawl --output="$PWD/docs/benchmarks/firecrawl-extraction.json"
```

The script requests Firecrawl API v2 `html` and `markdown`, `onlyMainContent: true`, timeout 45 seconds; it extracts **actual HTML** with the same local Readability parser. It does not accept markdown summaries. Managed requests have a 55-second outer deadline, a 6.1 MB response budget and 3 MB HTML budget. Local/direct requests retain existing time, network and content limits. Six cases are processed sequentially, once each, with no retries; every completed record is persisted. Reruns overwrite the chosen output file. Cached managed results are possible; these timings are not cold-browser timings, p50/p95, or service SLAs.

## Sources and validation

- **static:** https://www.paulgraham.com/greatwork.html — ordinary static article.
- **react:** https://react.dev/blog/2024/12/05/react-19 — actual framework blog with hydration; direct text succeeds, so it is **not evidence of client-only rendering**.
- **client-rendered:** https://quotes.toscrape.com/js/ — actual public JavaScript-only scraping demo, explicitly **not a publisher article**.
- **chrome:** https://developer.chrome.com/blog/new-in-chrome-131 — actual developer article.
- **angular:** https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a — exact requested URL, blocked locally.
- **not-found:** https://developer.chrome.com/blog/chrome-131 — intentionally invalid URL; negative source-404 control.

Success requires a successful source HTTP status, extracted title containing the expected title, both per-case text anchors, and the minimum character threshold recorded in JSON. This rejects provider HTTP 200 wrapping a source HTTP 404. `transportStatus` distinguishes the local relay or managed API status from `sourceStatus`; direct/local helpers expose successful source status only as 2xx, not an invented exact 200. A readiness failure may have no exposed source status. Content-validation failure is preserved, not silently upgraded to success.

The initial React title criterion was corrected from “React 19” to the observed source title “React v19” before this final local run. Firecrawl's main-content HTML drops document titles on several sites; records preserve **raw Readability title** and separate **providerTitle** metadata. The strict raw-title criterion deliberately leaves these as validation failures even where text hashes equal direct extraction. A future provider adapter could preserve verified metadata titles, but this benchmark does not rewrite results to hide the mismatch.

## Recorded results

Local measurement: 2026-10-05T15:35:11.066Z; managed measurement: 2026-10-05T15:36:27.867Z. Exact dependency versions, image ID, source revision, source/provider status, expected/matched anchors, text hashes, opening/closing excerpts and error messages are in [local-extraction.json](benchmarks/local-extraction.json) and [firecrawl-extraction.json](benchmarks/firecrawl-extraction.json).

| Case | Provider | Outcome | Characters | Latency ms |
| --- | --- | --- | ---: | ---: |
| static | direct | validated-content | 59515 | 914 |
| static | local-renderer | error | 0 | 8656 |
| react | direct | validated-content | 27908 | 563 |
| react | local-renderer | validated-content | 27908 | 1402 |
| client-rendered | direct | error | 0 | 376 |
| client-rendered | local-renderer | error | 0 | 9107 |
| chrome | direct | validated-content | 2832 | 1469 |
| chrome | local-renderer | validated-content | 2832 | 2323 |
| angular | direct | error | 0 | 67 |
| angular | local-renderer | error | 0 | 118 |
| not-found | direct | expected-not-found | 0 | 477 |
| not-found | local-renderer | expected-not-found | 0 | 516 |
| static | firecrawl | content-validation-failed | 59515 | 975 |
| react | firecrawl | content-validation-failed | 27908 | 958 |
| client-rendered | firecrawl | content-validation-failed | 1064 | 171 |
| chrome | firecrawl | validated-content | 3749 | 235 |
| angular | firecrawl | validated-content | 9702 | 262 |
| not-found | firecrawl | expected-not-found | 0 | 217 |

### Interpretation and limitations

- The local renderer adds no successful extraction on this small public sample that direct fetch could not already extract. React and Chrome extracted identical text hashes via both paths.
- Forced rendering fails readiness on Paul Graham and the JavaScript quotes demo. The current heuristic requires paragraph/pre/blockquote text: pages using other content structures can fail even if the browser has rendered text. The app normally accepts Paul Graham via direct fetch, so this forced-render failure is not a normal URL-path failure.
- Angular returns source **403** directly and via the sandboxed renderer. The actual reader API smoke returns **400** with the renderer's source-403 error and no text. There is no RSS success, no URL-to-audio claim, and no change to publisher-specific behavior.
- The real no-key Firecrawl Angular request returns API/source **200**, the expected compiler title, **9,702 characters**, author names, and the concluding oxc compiler-port discussion. This supports managed extraction evaluation, not app integration or a general challenge-bypass guarantee.
- Firecrawl Paul Graham and React bodies have the same hashes as direct extraction, but raw titles become hostnames; provider metadata preserves correct titles. The JavaScript quotes demo returns actual quote/author text but loses its raw document title. These are adapter/format issues, not “full publisher success”.
- Firecrawl Chrome passes the minimal identity/anchor checks but includes “On this page” navigation, collection text in its raw title, and serialized feedback data at the end. **Passing these checks is not clean-content or completeness acceptance.** Paul Graham also has noisy footnote bracket artifacts even on the direct path. Human content-quality review remains necessary.
- Browser Use Cloud Playwright (no LLM agent) is **blocked/unmeasured: API key unavailable**. No timings, statuses or success claims are inferred from documentation. Managed backend/browser versions are not disclosed by the Firecrawl response; only API v2 is claimed.
- Modal behavior is tested separately with a deliberately synthetic, real-Chromium delayed-JS fixture. No real publisher modal was verified in this public sample; modal presence varies by region/session and must not be assumed from a URL.

## Synthetic modal and security checks (separate evidence)

[synthetic-modal.json](benchmarks/synthetic-modal.json) records the actual fixture output. Use the sandboxed fixture and production egress commands in [local-renderer.md](local-renderer.md#verification), replacing the project container/network names with `pr9-local-benchmark-renderer-1` and `pr9-local-benchmark_browser` while the project is running. Fixture results: title “Rendered fixture article”, 315 characters, JavaScript insertion including a separate 3-second delayed case, serialized modal noise absent, four private-DNS checks, cancellation 106 ms, zero retained contexts. Extraction latency was not logged; it is null rather than fabricated. Production egress checks denied all seven direct socket probes, public-proxy access returned 200, and outer-namespace processes had zero capabilities.

This run passed 32 unit/integration tests, the Vite build, real blocked-URL API smoke, synthetic sandboxed Chromium checks and production egress checks. The updated reader Docker image built and runtime imports worked without the deleted feed module. The unique Compose project and temporary reader verification image were removed afterwards.
