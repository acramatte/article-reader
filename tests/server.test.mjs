import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server.mjs";
import { html } from "./fixture.mjs";
import { ArticleError } from "../article.mjs";

async function app(t, options = {}) {
  const server = createApp(options).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return (path, body, extra = {}) => fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
}

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

test("API wires typed renderer fallback, preserves text safety and never retries validation errors", async (t) => {
  let calls = 0;
  const renderPage = async (_value, { signal }) => { assert.ok(signal); calls++; return { html, url: "https://example.com/story" }; };
  const post = await app(t, { fetchPage: async () => { throw new ArticleError("HTTP block", "HTTP_BLOCK"); }, renderPage });
  const result = await post("/api/article", { url: "https://example.com/story" });
  assert.equal(result.status, 200); assert.equal((await result.json()).title, "A garden for everyone"); assert.equal(calls, 1);
  const denied = await app(t, { fetchPage: async () => { throw new Error("Private target denied"); }, renderPage });
  assert.equal((await denied("/api/article", { url: "http://localhost/" })).status, 400); assert.equal(calls, 1);
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
