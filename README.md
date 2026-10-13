# Article Reader

Turn an online article into something you can listen to. Paste a link, choose a voice and speed, and listen while walking, cooking, or doing something other than looking at a screen. You can also paste text directly.

<p align="center">
  <img src="docs/demo/article-reader-mobile.gif" width="390" alt="Article Reader mobile demo: paste a URL, start narration, pause and resume, scroll the extracted article, and stop playback." />
</p>

*UI demo recorded with the optional Kokoro backend; the default voices are listed below.*

## Current features

- **URL-first reading:** extract the article with Mozilla Readability, or paste text when extraction fails.
- **Continuous audio:** start listening before the whole article is generated; pause, resume, stop, and read again without re-fetching the URL. Stop playback to edit the article text before re-reading.
- **English and French voices:** Pocket TTS is the default, with Jane (American English female), Bill Boerst (American English male), and Estelle (French female). [Kokoro is optional](docs/development.md#optional-kokoro-backend).
- **Adjustable speed:** 0.8–2× in the UI, without changing pitch. Choose a voice matching the text's language; narration does not translate it.
- **Sentence highlighting:** follow the narrated sentence, with article-panel auto-scroll that pauses when you scroll manually. Timing is approximate; highlighting needs browser CSS Custom Highlight support.
- **Reload recovery:** resume the same temporary recording near its last saved position, without generating it again. Browser media/lock-screen play and pause are available where supported.
- **Separate speech service:** run inference locally on CPU or use a matching hosted endpoint. Provider credentials stay on the reader backend.

This is an early reader, not a finished podcast player. Prototype screen-off playback and integrated-reader recovery after Wi-Fi reconnection and browser kill/reopen were observed on Android/Brave; reliable background playback and integrated lock-screen controls are not fully qualified. See the [device evidence and limits](docs/streaming-spike.md).

## Quick start

Requirements: **Node 24**, **FFmpeg with `libmp3lame`**, and **Docker**. Run from the project root.

### 1. Start speech inference

```sh
docker build -t article-reader-pocket-tts:local pocket-tts-service
docker run --rm --name article-reader-pocket-tts \
  -p 127.0.0.1:8000:8000 article-reader-pocket-tts:local
```

The first build downloads public models and voices. The resulting service runs on CPU without runtime model downloads or an HF token. Leave it running; in another terminal, wait for both language models to load and readiness to succeed:

```sh
curl --fail http://127.0.0.1:8000/health
```

Retry the readiness check while models load. Inference capacity determines whether playback can keep up, especially at 2×; [local measurements are not a production sizing guarantee](docs/hf-inference.md#local-verification).

### 2. Start the reader

```sh
npm ci --include=dev
npm run build
npm start
```

Open **http://127.0.0.1:3001**, paste a link, and click **Read**. If extraction fails, choose **Paste text instead**. The Listen card provides **Read again**, **Pause/Resume**, and **Stop**; voice/speed settings and diagnostics are collapsible. Recovery offers the saved recording paused: tap **Resume** to continue.

For hot-reload development, [run Node and Vite separately](docs/development.md#development-servers).

## Limits and safe hosting

- JS-heavy or paywalled pages may not extract; inline ads or consent text can remain. Only public HTTP/HTTPS article URLs are accepted.
- Speech preparation is deliberately limited to English and French. There is no French male voice, translation, or guaranteed pronunciation of every number, identifier, or abbreviation.
- Pause stops listening, not generation. Stop removes the recording and cancels future work, but cannot interrupt computation already running on the speech service.
- Recordings are temporary and instance-local: server restarts discard them, and retention/capacity limits can expire them. Use one playback tab; cross-tab coordination, offline narration, and arbitrary seeking in growing streams are not provided. Saved positions may lag while mobile JavaScript is frozen.
- Sustained inference sizing remains unverified. Pocket passed a bounded local run; retained Kokoro has observed CPU memory growth/OOM. See [experiments and benchmarks](docs/experiments.md).

**Do not expose the app publicly as-is.** It has no built-in user authentication or per-user rate limits. Keep the reader behind a VPN or another access-control layer, and local inference bound to loopback. The supplied Compose setup is a WireGuard deployment template, not proof of a production rollout; see the [deployment runbook](docs/deployment.md).

## Documentation

Start with the [documentation map](docs/README.md). Technical detail lives outside this README:

- [Plain-language visual guide](docs/how-it-works.html): a standalone HTML explainer of the article-to-audio journey, playback controls, and recovery. Download/open it locally or serve it with the docs; repository hosts may show its source rather than render it.
- [Architecture](docs/architecture.md): context, components, runtime sequences, development/production infrastructure, decisions, and risks.
- [Development and configuration](docs/development.md): alternative backends, environment variables, tests, and pronunciation checks.
- [Deployment](docs/deployment.md) and [HF inference](docs/hf-inference.md): containers, access controls, credentials, rollout, and service packaging.
- [Experiments and benchmarks](docs/experiments.md): what was tried, what was adopted, measured evidence, and its limitations.
