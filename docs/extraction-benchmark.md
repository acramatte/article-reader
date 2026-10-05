# Extraction benchmark: local renderer and Firecrawl

This is measured public-network extraction, not a general coverage claim. No login, challenge solving, paywall bypass, publisher RSS, search result, generated summary, or pasted text was used. The app defaults to direct HTTP and supports only the [opt-in Firecrawl adapter](firecrawl.md). The local renderer implementation, container, proxy, firewall, configuration and smoke scripts have been removed. Its recorded results remain historical evidence, not a runnable supported path. Historical pre-integration results are preserved below; the integration run and separate real URL-to-audio evidence are distinguished explicitly.

## Reproduce

Node 24 and installed dependencies are required. From the repository root:

```sh
npm ci --include=dev
npm test
npm run build
node scripts/benchmark-extraction.mjs --output="$PWD/docs/benchmarks/direct-extraction.json"
# Optional managed benchmark: no-key access worked, not guaranteed.
# If required, set FIRECRAWL_API_KEY in the shell; it is never recorded.
node scripts/benchmark-extraction.mjs --firecrawl --output="$PWD/docs/benchmarks/firecrawl-integration-extraction.json"
```

The default benchmark measures direct HTTP only; `--firecrawl` measures Firecrawl only. Historical `local-extraction.json` is deliberately not overwritten by the default command. Docker and Kokoro are needed only for the separate [packaging/audio smoke checks](firecrawl.md#reproducible-verification).

The current script reuses the production adapter: Firecrawl API v2 `html` only, `onlyMainContent: true`, provider timeout 25 seconds, outer deadline 28 seconds, `storeInCache: false`, 6.1 MB JSON and 3 MB HTML budgets, source/provenance/DNS validation and safely restored metadata title. It extracts **actual HTML** with local Readability, never markdown summaries. Direct requests retain their existing limits. Six cases run sequentially once each with no retries; every completed record is persisted. Reruns overwrite the selected output. Existing cached results are possible; timings are not cold-browser measurements, p50/p95 or service SLAs. The historical pre-adapter probe below used HTML+markdown and 45/55-second provider/outer deadlines.

## Sources and validation

- **static:** https://www.paulgraham.com/greatwork.html — ordinary static article.
- **react:** https://react.dev/blog/2024/12/05/react-19 — actual framework blog with hydration; direct text succeeds, so it is **not evidence of client-only rendering**.
- **client-rendered:** https://quotes.toscrape.com/js/ — actual public JavaScript-only scraping demo, explicitly **not a publisher article**.
- **chrome:** https://developer.chrome.com/blog/new-in-chrome-131 — actual developer article.
- **angular:** https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a — exact requested URL, blocked locally.
- **not-found:** https://developer.chrome.com/blog/chrome-131 — intentionally invalid URL; negative source-404 control.

Success requires a successful source HTTP status, extracted title containing the expected title, both per-case text anchors, and the minimum character threshold recorded in JSON. This rejects provider HTTP 200 wrapping a source HTTP 404. `transportStatus` distinguishes the local relay or managed API status from `sourceStatus`; direct/local helpers expose successful source status only as 2xx, not an invented exact 200. A readiness failure may have no exposed source status. Content-validation failure is preserved, not silently upgraded to success.

The initial React title criterion was corrected from “React 19” to the observed source title “React v19” before the historical local run. Firecrawl's main-content HTML drops document titles on several sites. Historical records preserve raw Readability titles and separate provider metadata; their raw-title failures are not rewritten. The new adapter preserves the metadata title safely where HTML lost it, and the separate integration report measures that behavior.

## Historical pre-integration results

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
- Forced rendering fails readiness on Paul Graham and the JavaScript quotes demo. The removed renderer heuristic required paragraph/pre/blockquote text: pages using other content structures can fail even if the browser has rendered text. The app normally accepts Paul Graham via direct fetch, so this forced-render failure is not a normal URL-path failure.
- Angular returns source **403** directly and via the sandboxed renderer. The historical local reader API smoke returns **400** with source-403 error and no text. This is historical evidence for the removed path, not the managed provider's result.
- The historical no-key Firecrawl Angular probe returned API/source **200**, compiler title, **9,702 characters**, author names and final compiler-port discussion. It did not exercise app integration. The new report below separately measures the integrated adapter; neither establishes a general challenge-bypass guarantee.
- Firecrawl Paul Graham and React bodies have the same hashes as direct extraction, but raw titles become hostnames; provider metadata preserves correct titles. The JavaScript quotes demo returns actual quote/author text but loses its raw document title. These are adapter/format issues, not “full publisher success”.
- Firecrawl Chrome passes the minimal identity/anchor checks but includes “On this page” navigation, collection text in its raw title, and serialized feedback data at the end. **Passing these checks is not clean-content or completeness acceptance.** Paul Graham also has noisy footnote bracket artifacts even on the direct path. Human content-quality review remains necessary.
- Browser Use Cloud Playwright (no LLM agent) is **blocked/unmeasured: API key unavailable**. No timings, statuses or success claims are inferred from documentation. Managed backend/browser versions are not disclosed by the Firecrawl response; only API v2 is claimed.
- Modal behavior is tested separately with a deliberately synthetic, real-Chromium delayed-JS fixture. No real publisher modal was verified in this public sample; modal presence varies by region/session and must not be assumed from a URL.

## Historical synthetic modal and security checks (removed implementation)

[synthetic-modal.json](benchmarks/synthetic-modal.json) records the actual fixture output. These checks exercised the now-removed sandboxed renderer and cannot be rerun from the current tree. Fixture results: title “Rendered fixture article”, 315 characters, JavaScript insertion including a separate 3-second delayed case, serialized modal noise absent, four private-DNS checks, cancellation 106 ms, zero retained contexts. Extraction latency was not logged; it is null rather than fabricated. Production egress checks denied all seven direct socket probes, public-proxy access returned 200, and outer-namespace processes had zero capabilities.

That historical run passed 32 unit/integration tests, the Vite build, real blocked-URL API smoke, synthetic sandboxed Chromium checks and production egress checks. The updated reader Docker image built and runtime imports worked without the deleted feed module. The unique Compose project and temporary reader verification image were removed afterwards.

## Integrated Firecrawl results

[firecrawl-integration-extraction.json](benchmarks/firecrawl-integration-extraction.json) contains the current production adapter run, with metadata titles preserved and generic semantic/widget cleanup. All five positive cases pass identity, anchor and length checks; the negative API-200/source-404 is rejected. Authentication was **no key**, hosted backend version undisclosed; this does not document guest limits or guaranteed availability.

| Case | Outcome | Characters | Latency ms |
| --- | --- | ---: | ---: |
| static | validated-content | 59515 | 791 |
| react | validated-content | 27908 | 869 |
| client-rendered demo (not a publisher article) | validated-content | 1064 | 205 |
| chrome | validated-content | 2832 | 249 |
| angular | validated-content | 9619 | 273 |
| not-found | expected-not-found (source 404) | 0 | 193 |

The generic adapter restores titles for static/React/quotes, removes the observed Chrome collection/serialized-feedback noise and Angular image-control/signup widgets, and retains Angular's later FAQ/conclusion. Minimal validation still is not a human completeness/clean-content assessment; Paul Graham's bracket artifacts remain.

[firecrawl-audio-smoke.json](benchmarks/firecrawl-audio-smoke.json) separately verifies actual HTTP → configured Firecrawl → Readability → local CPU Kokoro → headless browser for the exact Angular URL, with three non-silent WAVs, pause/resume/stop and no page errors. First audio was **1.87 s**, with **one underrun and a 5.21 s scheduling gap** after two short opening chunks. Playback/chunking code is unchanged; this is not continuous-playback or physical-device qualification. [firecrawl.md](firecrawl.md) documents privacy, trust, bounds, cost/auth errors and reproduction. [firecrawl-container-smoke.json](benchmarks/firecrawl-container-smoke.json) verifies the actual non-root/read-only Docker runtime, module packaging, Angular extraction and favicon MIME. After removing the local renderer, the current revision passes 38 unit/integration tests and the Vite build; the historical renderer tests are not part of this suite. No Browser Use Cloud tests were run.
