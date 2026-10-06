import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server.mjs";
import { html } from "./fixture.mjs";
import { setTimeout as delay } from "node:timers/promises";
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
  const body = { text: "An article paragraph.", voice: "am_michael", speed: 1.25, title: "Article", byline: "Author", sourceUrl: "https://example.com/story" };
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
  assert.deepEqual(await (await fetch(base + `/api/streaming/${id}/content`)).json(), body);
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
  let response = await post("/api/streaming", { text, voice: "af_heart", speed: 1 });
  assert.equal(response.status, 201);
  let { id } = await response.json();
  assert.equal((await (await fetch(base + `/api/streaming/${id}/content`)).json()).text, text);
  await post(`/api/streaming/${id}/stop`, {});
  const escaped = '{"text":"' + '\\u6f22'.repeat(100000) + '","voice":"af_heart","speed":1}';
  response = await fetch(base + "/api/streaming", { method: "POST", headers: { "Content-Type": "application/json" }, body: escaped });
  assert.equal(response.status, 201);
  ({ id } = await response.json());
  await post(`/api/streaming/${id}/stop`, {});
  response = await post("/api/streaming", { text: "x".repeat(700000), voice: "af_heart", speed: 1 });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /body is too large/);
  response = await post("/api/article", { url: "https://example.com", padding: "x".repeat(150000) });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /body is too large/);
  assert.equal(server.narrations.sessions.size, 2);
  const limited = await streamingReader(t, { maxTextChars: 7000 });
  assert.equal((await limited.post("/api/streaming", { text: "x".repeat(7001), voice: "af_heart", speed: 1 })).status, 400);
  assert.equal((await limited.post("/api/streaming", { text: "x".repeat(7000), voice: "af_heart", speed: 1 })).status, 201);
});

test("metadata and credential-free HTTP(S) source URLs are validated before inference", async t => {
  let calls = 0;
  const { post } = await streamingReader(t, { synthesizeChunk: async () => { calls++; return syntheticWav(); } });
  for (const metadata of [{ title: "x".repeat(201) }, { title: null }, { byline: "x".repeat(501) }, { byline: [] },
    { sourceUrl: "x".repeat(2049) }, { sourceUrl: "not a URL" }, { sourceUrl: "file:///story" },
    { sourceUrl: "https://user:pass@example.com/" }, { sourceUrl: 123 }]) {
    assert.equal((await post("/api/streaming", { text: "Hello", voice: "af_heart", speed: 1, ...metadata })).status, 400);
  }
  assert.equal(calls, 0);
});

test("transport failure exposes a bounded connection code and does not retry ambiguous synthesis", async t => {
  let calls = 0;
  const { base, post, server } = await streamingReader(t, { synthesizeChunk: undefined, synthesize: async () => {
    calls++;
    throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
  } });
  const response = await post("/api/streaming", { text: "Connection failure.", voice: "af_heart", speed: 1 });
  const { id } = await response.json();
  await server.narrations.sessions.get(id).done;
  const status = await (await fetch(`${base}/api/streaming/${id}/status`)).json();
  assert.equal(status.error, "Speech engine connection failed (UND_ERR_SOCKET).");
  assert.equal(calls, 1);
});

test("escaped maximum metadata fits the body bound alongside maximum narration text", async t => {
  const { base, server } = await streamingReader(t, { maxTextChars: 20 });
  const prefix = "https://example.com/";
  const content = { text: "漢".repeat(20), voice: "af_heart", speed: 1,
    title: "漢".repeat(200), byline: "漢".repeat(500), sourceUrl: prefix + "漢".repeat(2048 - prefix.length) };
  const body = JSON.stringify(content).replaceAll("漢", "\\u6f22");
  const response = await fetch(base + "/api/streaming", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  await server.narrations.sessions.get(id).done;
  assert.deepEqual(await (await fetch(`${base}/api/streaming/${id}/content`)).json(), content);
});

test("stream environment overrides reject malformed, nonpositive and unreasonable limits", () => {
  assert.deepEqual(streamingLimits({}, {}), { maxTextChars: 100000, maxAudioBytes: 64000000, generationMs: 1200000,
    retentionMs: 21600000, disconnectMs: 120000, maxSessions: 4 });
  for (const value of ["", "0", "-1", "1.5", "1e3", " 10", "10junk", "Infinity", "9999999999999"]) {
    assert.throws(() => streamingLimits({}, { STREAM_GENERATION_MS: value }), /STREAM_GENERATION_MS/);
  }
  assert.equal(streamingLimits({}, { STREAM_RETENTION_MS: "1234" }).retentionMs, 1234);
  assert.throws(() => createApp({ maxTextChars: 0 }), /STREAM_MAX_TEXT_CHARS/);
});

test("normal streaming shares the server-side provider and rejects non-WAV", async t => {
  let request;
  const { base, server, post } = await streamingReader(t, { synthesizeChunk: undefined, ttsToken: "test-only-token",
    synthesize: async (_endpoint, options) => { request = options; return new Response(syntheticWav(), { headers: { "Content-Type": "audio/wav" } }); } });
  const { id } = await (await post("/api/streaming", { text: "Hello", voice: "af_heart", speed: 1 })).json();
  await server.narrations.sessions.get(id).done;
  assert.equal(request.headers.Authorization, "Bearer test-only-token"); assert.equal(request.redirect, "error");
  assert.equal((await (await fetch(base + `/api/streaming/${id}/status`)).json()).state, "ready");
  const invalid = await streamingReader(t, { synthesizeChunk: undefined, synthesize: async () => new Response("not audio") });
  const failure = await (await invalid.post("/api/streaming", { text: "Hello", voice: "af_heart", speed: 1 })).json();
  await invalid.server.narrations.sessions.get(failure.id).done;
  assert.match(invalid.server.narrations.sessions.get(failure.id).error, /Kokoro did not return WAV/);
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
  const response = await post("/api/tts", { text: "Hello", voice: "af_heart", speed: 1 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-RTF"), "0.15");
  assert.equal(response.headers.get("Authorization"), null);
  assert.equal(upstream.request.headers.Authorization, "Bearer test-only-token");
  assert.deepEqual(JSON.parse(upstream.request.body), { text: "Hello", voice: "af_heart", speed: 1 });
  assert.equal((await response.arrayBuffer()).byteLength, 4);
});

test("both speech APIs accept the current voices, preserve selection and reject Bella", async t => {
  const seen = [];
  const { base, server, post } = await streamingReader(t, { synthesizeChunk: undefined,
    synthesize: async (_url, request) => {
      seen.push(JSON.parse(request.body));
      return new Response(syntheticWav(), { headers: { "Content-Type": "audio/wav" } });
    } });
  for (const voice of ["af_heart", "af_nicole", "am_michael", "ff_siwis"]) {
    const body = { text: voice === "ff_siwis" ? "Bonjour, lecture en français." : "Hello, reading in English.", voice, speed: 1 };
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
    assert.equal((await post(path, { text: "Hello", voice: "af_bella", speed: 1 })).status, 400);
  }
  assert.equal(seen.length, count);
});

test("API rejects invalid requests and cross-origin browser calls", async (t) => {
  const post = await app(t);
  for (const body of [null, {}, { text: "", voice: "af_heart", speed: 1 }, { text: "x".repeat(1001), voice: "af_heart", speed: 1 }, { text: "Hi", voice: "unknown", speed: 1 }, { text: "Hi", voice: "af_heart", speed: 3 }]) assert.equal((await post("/api/tts", body)).status, 400);
  assert.equal((await post("/api/article", {})).status, 400);
  assert.equal((await post("/api/article", { url: "http://localhost" })).status, 400);
  assert.equal((await post("/api/article", {}, { Origin: "https://evil.example" })).status, 403);
});

test("upstream 503 exposes only a retryable code and Retry-After, not provider details", async (t) => {
  for (const retryAfter of ["7", "Wed, 21 Oct 2030 07:28:00 GMT", null]) {
    const post = await app(t, { synthesize: async () => new Response("provider-internal-details", {
      status: 503, headers: retryAfter ? { "Retry-After": retryAfter } : {},
    }) });
    const response = await post("/api/tts", { text: "Hello", voice: "af_heart", speed: 1 });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), retryAfter || "2");
    const problem = await response.json();
    assert.equal(problem.code, "INFERENCE_UNAVAILABLE");
    assert.doesNotMatch(problem.error, /provider-internal-details/);
  }
});

test("authentication and busy errors are not classified as startup", async (t) => {
  for (const status of [401, 403, 429]) {
    const post = await app(t, { synthesize: async () => new Response("failed", { status }) });
    const response = await post("/api/tts", { text: "Hello", voice: "af_heart", speed: 1 });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, undefined);
  }
});

test("upstream errors and non-WAV responses become actionable API errors", async (t) => {
  for (const response of [new Response("failed", { status: 500 }), new Response("not audio")]) {
    const post = await app(t, { synthesize: async () => response });
    const result = await post("/api/tts", { text: "Hello", voice: "af_heart", speed: 1 });
    assert.equal(result.status, 502);
    assert.match((await result.json()).error, /Kokoro/);
  }
});
