import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { createApp } from "../server.mjs";
import { userError } from "../errors.mjs";
import { html } from "./fixture.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamingLimits } from "../streaming-api.mjs";

async function app(t, options = {}) {
  const server = createApp(options).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return (path, body, extra = {}) => fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
}

// Synthetic silence fixture: these tests exercise real FFmpeg, not speech quality.
function syntheticWav() {
  const b = Buffer.alloc(4844);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(4800, 40);
  return b;
}

async function streamingReader(t, options = {}) {
  const server = createApp({ synthesizeChunk: async () => syntheticWav(), ...options }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { server, base, post };
}

test("normal reader exposes streaming content/audio/status/mark/stop and non-secret limits", async t => {
  const { base, server, post } = await streamingReader(t);
  const body = { text: "An article paragraph.", voice: "bill_boerst", speed: 1.25, title: "Article", byline: "Author", sourceUrl: "https://example.com/story" };
  const created = await post("/api/streaming", body);
  assert.equal(created.status, 201);
  const { id, audioUrl } = await created.json();
  assert.equal(audioUrl, `/api/streaming/${id}/audio`);
  await server.narrations.sessions.get(id).done;
  const snapshot = await (await fetch(base + `/api/streaming/${id}/status`)).json();
  assert.equal(snapshot.state, "ready");
  for (const key of ["voice", "speed", "title"]) assert.equal(snapshot[key], body[key]);
  assert.equal(snapshot.text, undefined); assert.equal(snapshot.byline, undefined);
  assert.ok(snapshot.expiresAt > Date.now()); assert.equal(snapshot.generationDeadline, null);
  const { sentences, timings, ...content } = await (await fetch(base + `/api/streaming/${id}/content`)).json();
  assert.deepEqual(content, body);
  // One sentence, timed in recording seconds (synthesis duration divided by speed).
  assert.deepEqual(sentences, [[0, body.text.length]]);
  assert.deepEqual(timings, [[0, Math.round(snapshot.audioSecondsGenerated * 1000) / 1000]]);
  const audio = await fetch(base + audioUrl);
  assert.equal(audio.headers.get("content-type"), "audio/mpeg");
  assert.ok((await audio.arrayBuffer()).byteLength > 0);
  assert.equal((await (await post(`/api/streaming/${id}/mark`, { playbackSeconds: 0.05 })).json()).mark.playbackSeconds, 0.05);
  assert.equal((await fetch(base + `/api/streaming/${id}/status`, { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(base + "/api/health")).status, 200);
  const config = await (await fetch(base + "/api/config")).json();
  assert.equal(config.maxTextChars, 100000); assert.equal(config.maxAudioBytes, 64000000);
  assert.equal((await post(`/api/streaming/${id}/stop`, {})).status, 200);
  assert.equal((await fetch(base + `/api/streaming/${id}/content`)).status, 410);
});

test("full-length Unicode/escaped JSON fits streaming body bounds; legacy byte bounds remain", async t => {
  const { base, server, post } = await streamingReader(t, { synthesizeChunk: async (_body, signal) => {
    await delay(10000, undefined, { signal }); return syntheticWav();
  } });
  const text = "漢".repeat(100000); // 300 kB UTF-8, above legacy body limit; synthesis immediately cancelled.
  let response = await post("/api/streaming", { text, voice: "jane", speed: 1 });
  assert.equal(response.status, 201);
  let { id } = await response.json();
  assert.equal((await (await fetch(base + `/api/streaming/${id}/content`)).json()).text, text);
  await post(`/api/streaming/${id}/stop`, {});
  const escaped = '{"text":"' + '\\u6f22'.repeat(100000) + '","voice":"jane","speed":1}';
  response = await fetch(base + "/api/streaming", { method: "POST", headers: { "Content-Type": "application/json" }, body: escaped });
  assert.equal(response.status, 201);
  ({ id } = await response.json());
  await post(`/api/streaming/${id}/stop`, {});
  response = await post("/api/streaming", { text: "x".repeat(700000), voice: "jane", speed: 1 });
  assert.equal(response.status, 413); assert.match((await response.json()).error, /body is too large/);
  response = await post("/api/article", { url: "https://example.com", padding: "x".repeat(150000) });
  assert.equal(response.status, 413); assert.match((await response.json()).error, /body is too large/);
  assert.equal(server.narrations.sessions.size, 2);
  const limited = await streamingReader(t, { maxTextChars: 7000 });
  assert.equal((await limited.post("/api/streaming", { text: "x".repeat(7001), voice: "jane", speed: 1 })).status, 400);
  assert.equal((await limited.post("/api/streaming", { text: "x".repeat(7000), voice: "jane", speed: 1 })).status, 201);
});

test("metadata and credential-free HTTP(S) source URLs are validated before inference", async t => {
  let calls = 0;
  const { post } = await streamingReader(t, { synthesizeChunk: async () => { calls++; return syntheticWav(); } });
  for (const metadata of [{ title: "x".repeat(201) }, { title: null }, { byline: "x".repeat(501) }, { byline: [] },
    { sourceUrl: "x".repeat(2049) }, { sourceUrl: "not a URL" }, { sourceUrl: "file:///story" },
    { sourceUrl: "https://user:pass@example.com/" }, { sourceUrl: 123 }]) {
    assert.equal((await post("/api/streaming", { text: "Hello", voice: "jane", speed: 1, ...metadata })).status, 400);
  }
  assert.equal(calls, 0);
});

test("transport failure exposes a bounded connection code and does not retry ambiguous synthesis", async t => {
  let calls = 0;
  const { base, post, server } = await streamingReader(t, { synthesizeChunk: undefined, synthesize: async () => {
    calls++;
    throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
  } });
  const response = await post("/api/streaming", { text: "Connection failure.", voice: "jane", speed: 1 });
  const { id } = await response.json();
  await server.narrations.sessions.get(id).done;
  const status = await (await fetch(`${base}/api/streaming/${id}/status`)).json();
  assert.equal(status.error, "Speech engine connection failed (UND_ERR_SOCKET).");
  assert.equal(calls, 1);
});

test("escaped maximum metadata fits the body bound alongside maximum narration text", async t => {
  const { base, server } = await streamingReader(t, { maxTextChars: 20 });
  const prefix = "https://example.com/";
  const content = { text: "漢".repeat(20), voice: "jane", speed: 1,
    title: "漢".repeat(200), byline: "漢".repeat(500), sourceUrl: prefix + "漢".repeat(2048 - prefix.length) };
  const body = JSON.stringify(content).replaceAll("漢", "\\u6f22");
  const response = await fetch(base + "/api/streaming", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  await server.narrations.sessions.get(id).done;
  const { sentences, timings, ...restored } = await (await fetch(`${base}/api/streaming/${id}/content`)).json();
  assert.deepEqual(restored, content);
  assert.deepEqual(sentences, [[0, 20]]);
  assert.equal(timings.length, 1);
});

test("stream environment overrides reject malformed, nonpositive and unreasonable limits", () => {
  assert.deepEqual(streamingLimits({}, {}), { maxTextChars: 100000, maxAudioBytes: 64000000, generationMs: 1200000,
    retentionMs: 21600000, disconnectMs: 120000, maxSessions: 4, maxConsumers: 4 });
  for (const value of ["", "0", "-1", "1.5", "1e3", " 10", "10junk", "Infinity", "9999999999999"]) {
    assert.throws(() => streamingLimits({}, { STREAM_GENERATION_MS: value }), /STREAM_GENERATION_MS/);
  }
  assert.equal(streamingLimits({}, { STREAM_RETENTION_MS: "1234" }).retentionMs, 1234);
  assert.equal(streamingLimits({}, { STREAM_MAX_CONSUMERS: "9" }).maxConsumers, 9);
  assert.throws(() => createApp({ maxTextChars: 0 }), /STREAM_MAX_TEXT_CHARS/);
  assert.throws(() => createApp({ maxConsumers: 0 }), /STREAM_MAX_CONSUMERS/);
});

test("normal streaming shares the server-side provider and rejects non-WAV", async t => {
  let request;
  const { base, server, post } = await streamingReader(t, { synthesizeChunk: undefined, ttsToken: "test-only-token",
    synthesize: async (_endpoint, options) => { request = options; return new Response(syntheticWav(), { headers: { "Content-Type": "audio/wav" } }); } });
  const { id } = await (await post("/api/streaming", { text: "Hello", voice: "jane", speed: 1 })).json();
  await server.narrations.sessions.get(id).done;
  assert.equal(request.headers.Authorization, "Bearer test-only-token"); assert.equal(request.redirect, "error");
  assert.equal((await (await fetch(base + `/api/streaming/${id}/status`)).json()).state, "ready");
  const invalid = await streamingReader(t, { synthesizeChunk: undefined, synthesize: async () => new Response("not audio") });
  const failure = await (await invalid.post("/api/streaming", { text: "Hello", voice: "jane", speed: 1 })).json();
  await invalid.server.narrations.sessions.get(failure.id).done;
  assert.match(invalid.server.narrations.sessions.get(failure.id).error, /Pocket TTS did not return WAV/);
});

test("API extracts article and proxies WAV and metrics, sending token only upstream", async (t) => {
  let upstream;
  const post = await app(t, { fetchPage: async () => ({ html, url: "https://example.com/story" }), ttsToken: "test-only-token", synthesize: async (url, request) => {
    upstream = { url, request };
    return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "Content-Type": "audio/wav", "X-Audio-Seconds": "10", "X-RTF": "0.15" } });
  } });
  const article = await post("/api/article", { url: "https://example.com/story" });
  assert.equal(article.status, 200);
  assert.equal((await article.json()).title, "A garden for everyone");
  const response = await post("/api/tts", { text: "Hello", voice: "jane", speed: 1 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-RTF"), "0.15");
  assert.equal(response.headers.get("Authorization"), null);
  assert.equal(upstream.request.headers.Authorization, "Bearer test-only-token");
  assert.deepEqual(JSON.parse(upstream.request.body), { text: "Hello", voice: "jane", speed: 1 });
  assert.equal((await response.arrayBuffer()).byteLength, 4);
});

for (const [ttsEngine, name, catalog, foreignVoices] of [
  ["pocket", "Pocket TTS", [
    { id: "jane", name: "Jane", group: "American English · Female", language: "en" },
    { id: "bill_boerst", name: "Bill Boerst", group: "American English · Male", language: "en" },
    { id: "estelle", name: "Estelle", group: "French · Female", language: "fr" },
  ], ["af_heart", "am_michael", "ff_siwis"]],
  ["kokoro", "Kokoro", [
    { id: "af_heart", name: "Heart", group: "American English · Female", language: "en" },
    { id: "am_michael", name: "Michael", group: "American English · Male", language: "en" },
    { id: "ff_siwis", name: "Siwis", group: "French · Female", language: "fr" },
  ], ["jane", "bill_boerst", "estelle"]],
]) test(`both speech APIs use the ${ttsEngine} catalog and reject foreign voices`, async t => {
  const seen = [];
  const { base, server, post } = await streamingReader(t, { ttsEngine, synthesizeChunk: undefined,
    ttsUrl: "https://tts.example.test/private/tts", ttsToken: "test-only-token",
    synthesize: async (_url, request) => {
      seen.push(JSON.parse(request.body));
      return new Response(syntheticWav(), { headers: { "Content-Type": "audio/wav" } });
    } });
  const config = await (await fetch(base + "/api/config")).json();
  assert.deepEqual(config.tts, { engine: ttsEngine, name, voices: catalog });
  assert.doesNotMatch(JSON.stringify(config), /tts\.example\.test|test-only-token|ttsUrl|ttsToken/);
  for (const { id: voice, group } of catalog) {
    const body = { text: group.startsWith("French") ? "Bonjour, lecture en français." : "Hello, reading in English.", voice, speed: 1 };
    assert.equal((await post("/api/tts", body)).status, 200);
    assert.deepEqual(seen.at(-1), body);
    const response = await post("/api/streaming", body);
    assert.equal(response.status, 201);
    const { id } = await response.json();
    await server.narrations.sessions.get(id).done;
    assert.deepEqual(seen.at(-1), body);
    assert.equal((await (await fetch(`${base}/api/streaming/${id}/content`)).json()).voice, voice);
    await post(`/api/streaming/${id}/stop`, {});
  }
  const count = seen.length;
  for (const path of ["/api/tts", "/api/streaming"]) {
    for (const voice of [...foreignVoices, "af_nicole", "af_bella"]) {
      const response = await post(path, { text: "Hello", voice, speed: 1 });
      assert.equal(response.status, 400, `${path} rejects unsupported voice ${voice}`);
      assert.match((await response.json()).error, /supported voice/);
    }
  }
  assert.equal(seen.length, count);
  assert.equal(server.narrations.sessions.size, 3, "rejected streaming requests create no sessions");
});

test("unknown engines fail at startup instead of falling back to Pocket TTS", () => {
  for (const ttsEngine of ["", "unknown", "Kokoro", "toString"]) {
    assert.throws(() => createApp({ ttsEngine }), /TTS_ENGINE must be pocket or kokoro/);
  }
});

test("an unset or empty TTS_ENGINE environment variable selects Pocket TTS", async t => {
  const previous = process.env.TTS_ENGINE;
  t.after(() => { if (previous === undefined) delete process.env.TTS_ENGINE; else process.env.TTS_ENGINE = previous; });
  for (const value of [undefined, ""]) {
    if (value === undefined) delete process.env.TTS_ENGINE; else process.env.TTS_ENGINE = value;
    const server = createApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    const config = await (await fetch(`http://127.0.0.1:${server.address().port}/api/config`)).json();
    server.closeAllConnections(); server.close();
    assert.equal(config.tts.engine, "pocket");
  }
});

test("raw WAV API rejects non-1 speeds before synthesis and directs callers to streaming", async t => {
  let calls = 0;
  const post = await app(t, { synthesize: async () => {
    calls++;
    return new Response(syntheticWav(), { headers: { "Content-Type": "audio/wav" } });
  } });
  for (const speed of [0.5, 0.75, 1.25, 1.5, 2, 0.99, 1.01, "1", null, 3]) {
    const response = await post("/api/tts", { text: "Hello", voice: "jane", speed });
    assert.equal(response.status, 400, `raw speed ${speed} is rejected`);
    const { error } = await response.json();
    assert.match(error, /speed 1/);
    assert.match(error, /\/api\/streaming/);
  }
  const missing = await post("/api/tts", { text: "Hello", voice: "jane" });
  assert.equal(missing.status, 400);
  assert.equal(calls, 0, "no rejected speed reaches the speech engine");
  assert.equal((await post("/api/tts", { text: "Hello", voice: "jane", speed: 1 })).status, 200);
  assert.equal(calls, 1);
});

test("API rejects invalid requests and cross-origin browser calls", async (t) => {
  const post = await app(t);
  for (const body of [null, {}, { text: "", voice: "jane", speed: 1 }, { text: "x".repeat(1001), voice: "jane", speed: 1 }, { text: "Hi", voice: "unknown", speed: 1 }, { text: "Hi", voice: "jane", speed: 3 }]) assert.equal((await post("/api/tts", body)).status, 400);
  assert.equal((await post("/api/tts", { text: "«»“”()[] — *** 🎵", voice: "estelle", speed: 1 })).status, 400);
  assert.equal((await post("/api/article", {})).status, 400);
  // Fetch-time rejections (validateUrl, SSRF) stay user-facing, marked as client errors at their source.
  const local = await post("/api/article", { url: "http://localhost" });
  assert.equal(local.status, 400);
  assert.match((await local.json()).error, /not allowed/);
  const file = await post("/api/article", { url: "file:///etc/passwd" });
  assert.equal(file.status, 400);
  assert.equal((await file.json()).error, "Only HTTP/HTTPS URLs on standard ports without credentials are supported.");
  assert.equal((await post("/api/article", {}, { Origin: "https://evil.example" })).status, 403);
});

test("unexpected errors return generic messages, while extraction errors stay user-facing", async (t) => {
  const lines = [];
  const consoleError = console.error;
  t.after(() => { console.error = consoleError; });
  console.error = (...parts) => lines.push(parts.join(" "));
  // A malformed static path once leaked the resolved absolute filesystem path in error.message.
  const { base, post } = await streamingReader(t, { staticDir: "dist" });
  for (const path of ["/a%00b", "/a%zzb"]) {
    const response = await fetch(base + path);
    const problem = await response.json();
    assert.equal(response.status, 400);
    assert.equal(problem.error, "The request could not be completed.");
    assert.match(lines.at(-1), new RegExp(`^GET ${path} `), "details are logged server-side");
    assert.doesNotMatch(problem.error, /workspace|dist|Received|URI/);
  }
  // article.mjs and its injected fetchPage throw only user-facing extraction/fetch messages.
  const extraction = await app(t, { fetchPage: async () => ({ html: "<html><p>x</p></html>", url: "https://example.com/story" }) });
  const article = await extraction("/api/article", { url: "https://example.com/story" });
  assert.equal(article.status, 422);
  assert.match((await article.json()).error, /readable|enough/);
  const timeout = await app(t, { fetchPage: async () => { throw Object.assign(new DOMException("hung", "TimeoutError")); } });
  const expired = await timeout("/api/article", { url: "https://example.com/story" });
  assert.equal(expired.status, 400);
  assert.equal((await expired.json()).error, "The request timed out.");
});

test("only a missing static file gets the build hint; other ENOENTs stay internal errors", async t => {
  const lines = [];
  const consoleError = console.error;
  t.after(() => { console.error = consoleError; });
  console.error = (...parts) => lines.push(parts.join(" "));
  const staticDir = await mkdtemp(join(tmpdir(), "reader-static-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Reader</title>");
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  const { base } = await streamingReader(t, { staticDir });
  assert.equal((await fetch(base + "/")).status, 200);
  const missing = await fetch(base + "/missing.html");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "Not found. Run npm run build for the production UI.");
  // A filesystem failure outside the static branch (an injected dependency reporting a vanished
  // recording file) is internal: generic message, no build hint, details logged server-side.
  const internal = await app(t, { synthesize: async () => {
    throw Object.assign(new Error("Spool recording vanished."), { code: "ENOENT" });
  } });
  const response = await internal("/api/tts", { text: "Hello", voice: "jane", speed: 1 });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "The request could not be completed.");
  assert.match(lines.at(-1), /^POST \/api\/tts Error Spool recording vanished\.$/, "details are logged server-side");
  // A marked user error that happens to carry code ENOENT keeps its own status and message.
  const marked = await app(t, { synthesize: async () => {
    throw Object.assign(userError("Recording file vanished.", 410), { code: "ENOENT" });
  } });
  const kept = await marked("/api/tts", { text: "Hello", voice: "jane", speed: 1 });
  assert.equal(kept.status, 410);
  assert.equal((await kept.json()).error, "Recording file vanished.");
});

test("upstream 503 exposes only a retryable code and Retry-After, not provider details", async (t) => {
  for (const retryAfter of ["7", "Wed, 21 Oct 2030 07:28:00 GMT", null]) {
    const post = await app(t, { synthesize: async () => new Response("provider-internal-details", {
      status: 503, headers: retryAfter ? { "Retry-After": retryAfter } : {},
    }) });
    const response = await post("/api/tts", { text: "Hello", voice: "jane", speed: 1 });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), retryAfter || "2");
    const problem = await response.json();
    assert.equal(problem.code, "INFERENCE_UNAVAILABLE");
    assert.doesNotMatch(problem.error, /provider-internal-details/);
  }
});

test("authentication errors are not retryable; busy is retryable but not startup", async (t) => {
  for (const status of [401, 403]) {
    const post = await app(t, { synthesize: async () => new Response("failed", { status }) });
    const response = await post("/api/tts", { text: "Hello", voice: "jane", speed: 1 });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, undefined);
  }
  const post = await app(t, { synthesize: async () => new Response("provider-internal-details", { status: 429, headers: { "Retry-After": "1" } }) });
  const response = await post("/api/tts", { text: "Hello", voice: "jane", speed: 1 });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "1");
  const problem = await response.json();
  assert.equal(problem.code, "INFERENCE_BUSY");
  assert.doesNotMatch(problem.error, /provider-internal-details/);
});

test("streaming waits for a busy inference service instead of failing, without showing startup", async t => {
  const seen = [];
  let server;
  const reader = await streamingReader(t, { synthesizeChunk: undefined, synthesize: async (_endpoint, options) => {
    const session = [...server.narrations.sessions.values()][0];
    seen.push({ text: JSON.parse(options.body).text, warming: session.warming });
    return seen.length === 1 ? new Response("busy", { status: 429, headers: { "Retry-After": "1" } })
      : new Response(syntheticWav(), { headers: { "Content-Type": "audio/wav" } });
  } });
  server = reader.server;
  const { id } = await (await reader.post("/api/streaming", { text: "Busy engine.", voice: "jane", speed: 1 })).json();
  await server.narrations.sessions.get(id).done;
  const status = await (await fetch(`${reader.base}/api/streaming/${id}/status`)).json();
  assert.equal(status.state, "ready", status.error);
  assert.deepEqual(seen, [{ text: "Busy engine.", warming: false }, { text: "Busy engine.", warming: false }]);
});

test("upstream errors and non-WAV responses become actionable API errors", async (t) => {
  for (const [ttsEngine, voice, name] of [["pocket", "jane", "Pocket TTS"], ["kokoro", "af_heart", "Kokoro"]]) {
    for (const response of [new Response("failed", { status: 500 }), new Response("not audio")]) {
      const post = await app(t, { ttsEngine, synthesize: async () => response });
      const result = await post("/api/tts", { text: "Hello", voice, speed: 1 });
      assert.equal(result.status, 502);
      assert.ok((await result.json()).error.startsWith(name));
    }
  }
});

// Node's fetch always sends the connection's Host, so these requests set it explicitly.
function requestAs(server, host, path, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: server.address().port, path, method,
      headers: { Host: host, ...(body ? { "Content-Type": "application/json" } : {}), ...headers } }, response => {
      let text = "";
      response.on("data", piece => { text += piece; }).on("end", () => resolve({ status: response.statusCode, text }));
    });
    request.on("error", reject);
    request.end(body && JSON.stringify(body));
  });
}

test("DNS-rebinding host names are rejected; IP literals, localhost and ALLOWED_HOSTS names are served", async t => {
  const server = createApp({ allowedHosts: ["reader.vpn"], staticDir: "public",
    fetchPage: async () => ({ html, url: "https://example.com/story" }) }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.shutdown());
  // After rebinding, the page's own name is both its Origin and the Host: the Origin check alone passed.
  const rebound = { headers: { Origin: "http://rebind.attacker.example:8084" } };
  for (const [path, options] of [["/api/config", rebound], ["/streaming.html", rebound],
    ["/api/article", { ...rebound, method: "POST", body: { url: "https://example.com/story" } }]]) {
    const response = await requestAs(server, "rebind.attacker.example:8084", path, options);
    assert.equal(response.status, 403, path);
    assert.match(response.text, /ALLOWED_HOSTS/);
  }
  for (const host of ["127.0.0.1:3001", "10.0.0.1:8084", "[::1]:3001", "localhost:5173", "reader.vpn"]) {
    assert.equal((await requestAs(server, host, "/api/config")).status, 200, host);
  }
  for (const host of ["evil.example@127.0.0.1", "1.2.3.4.nip.io", "reader.vpn.attacker.example"]) {
    assert.equal((await requestAs(server, host, "/api/config")).status, 403, host);
  }
  let status; // Node's client always fills in Host, so call the handler directly for a request without one.
  await server.listeners("request")[0]({ url: "/api/config", method: "GET", headers: {} },
    { setHeader() {}, writeHead(code) { status = code; }, end() {} });
  assert.equal(status, 403);
  const article = await requestAs(server, "reader.vpn", "/api/article", { method: "POST", body: { url: "https://example.com/story" },
    headers: { Origin: "http://reader.vpn" } });
  assert.equal(JSON.parse(article.text).title, "A garden for everyone");
});

test("one article is extracted at a time; others are told to retry", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const post = await app(t, { fetchPage: async () => { await gate; return { html, url: "https://example.com/story" }; } });
  const first = post("/api/article", { url: "https://example.com/story" });
  await delay(50);
  const busy = await post("/api/article", { url: "https://example.com/other" });
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("Retry-After"), "2");
  release();
  assert.equal((await first).status, 200);
  assert.equal((await post("/api/article", { url: "https://example.com/story" })).status, 200);
});

test("hostile narration text is planned off the event loop and rejected promptly", async t => {
  const { post } = await streamingReader(t);
  let last = performance.now();
  let stall = 0;
  const timer = setInterval(() => { const now = performance.now(); stall = Math.max(stall, now - last); last = now; }, 10);
  // Reported: this 100 KB paste blocked every request for 66 s, and repeatably (no session is created).
  const started = performance.now();
  const response = await post("/api/streaming", { text: `https://example.com/${")".repeat(99_980)}`, voice: "jane", speed: 1 });
  clearInterval(timer);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /only contains links/);
  assert.ok(performance.now() - started < 5000);
  assert.ok(stall < 250, `event loop stalled ${stall} ms`);
});

test("static responses carry a strict Content-Security-Policy", async (t) => {
  const staticDir = await mkdtemp(join(tmpdir(), "reader-static-"));
  await mkdir(join(staticDir, "assets"));
  const write = (name, body) => writeFile(join(staticDir, name), body);
  await Promise.all([
    write("index.html", '<!doctype html><html><head><style>body{color:#172c31}</style></head><body><script type="module" src="/assets/main.js"></script></body></html>'),
    write("streaming.html", '<!doctype html><html><head><style>body{color:#e6e8ed}</style></head><body><script type="module" src="/streaming.js"></script></body></html>'),
    write("assets/main.js", "export {};"),
    write("streaming.js", "export {};"),
    write("favicon.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'),
  ]);
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  const { base } = await streamingReader(t, { staticDir });
  const directives = [
    "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self'", "media-src 'self'", "connect-src 'self'", "form-action 'none'",
    "base-uri 'none'", "frame-ancestors 'none'", "object-src 'none'",
  ];
  const expected = directives.join("; ");
  for (const path of ["/", "/index.html", "/streaming.html", "/favicon.svg", "/assets/main.js", "/streaming.js"]) {
    const policy = (await fetch(base + path)).headers.get("content-security-policy");
    // Exact match, not substring: a loosened policy (extra sources or directives) must fail.
    assert.equal(policy, expected, `${path} must send the strict policy`);
  }
});
