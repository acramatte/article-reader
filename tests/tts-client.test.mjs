import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeSpeech, retryDelay } from "../tts-client.mjs";

const body = { text: "Hello", voice: "af_heart", speed: 1 };
const unavailable = () => Response.json({ code: "INFERENCE_UNAVAILABLE" }, { status: 503 });
const signal = () => new AbortController().signal;

test("startup retries recover with the same payload and a waiting notification", async () => {
  let calls = 0;
  const states = [];
  const wav = new Uint8Array([82, 73, 70, 70]);
  const result = await synthesizeSpeech(body, signal(), (waiting) => states.push(waiting), {
    fetchSpeech: async (url, options) => {
      assert.equal(url, "/api/tts");
      assert.deepEqual(JSON.parse(options.body), body);
      return ++calls === 1 ? unavailable() : new Response(wav);
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(new Uint8Array(result), wav);
  assert.deepEqual(states, [true, false]);
});

test("Retry-After seconds and HTTP dates are respected; malformed values use capped backoff", () => {
  assert.equal(retryDelay("7", 0), 7000);
  assert.equal(retryDelay("Wed, 21 Oct 2030 07:28:00 GMT", 0, Date.parse("Wed, 21 Oct 2030 07:27:50 GMT")), 10000);
  assert.equal(retryDelay("invalid", 1), 2000);
  assert.equal(retryDelay(null, 8), 10000);
  assert.equal(retryDelay("0", 0), 1000);
});

test("auth, busy, generic 503, and network failures are never retried", async () => {
  for (const status of [401, 403, 429, 502, 503]) {
    let calls = 0;
    await assert.rejects(synthesizeSpeech(body, signal(), undefined, {
      fetchSpeech: async () => { calls++; return Response.json({ error: "Rejected" }, { status }); },
    }), /Rejected/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(synthesizeSpeech(body, signal(), undefined, {
    fetchSpeech: async () => { calls++; throw new TypeError("Network failed"); },
  }), /Network failed/);
  assert.equal(calls, 1);
});

test("Stop during retry wait aborts promptly and no later request is sent", async () => {
  const controller = new AbortController();
  let calls = 0;
  const states = [];
  await assert.rejects(synthesizeSpeech(body, controller.signal, (waiting) => {
    states.push(waiting);
    if (waiting) setTimeout(() => controller.abort(), 20);
  }, { fetchSpeech: async () => { calls++; return unavailable(); } }), { name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(calls, 1);
  assert.deepEqual(states, [true, false]);
});

test("one total deadline ends Retry-After waiting without another request", async () => {
  let calls = 0;
  await assert.rejects(synthesizeSpeech(body, signal(), undefined, {
    timeoutMs: 30,
    fetchSpeech: async () => { calls++; return Response.json({ code: "INFERENCE_UNAVAILABLE" }, { status: 503, headers: { "Retry-After": "600" } }); },
  }), { name: "TimeoutError", message: "Speech engine startup timed out. Please try again." });
  assert.equal(calls, 1);
});

test("attempt budget ends persistent unavailability", async () => {
  let calls = 0;
  await assert.rejects(synthesizeSpeech(body, signal(), undefined, {
    maxAttempts: 2, fetchSpeech: async () => { calls++; return unavailable(); },
  }), /still unavailable/);
  assert.equal(calls, 2);
});

test("Stop cancels an in-flight request; the deadline also covers a pending response body", async () => {
  for (const abortCaller of [true, false]) {
    const controller = new AbortController();
    const pending = synthesizeSpeech(body, controller.signal, undefined, {
      timeoutMs: 30,
      fetchSpeech: async (_url, { signal }) => ({ ok: true, arrayBuffer: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }) }),
    });
    if (abortCaller) setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, { name: abortCaller ? "AbortError" : "TimeoutError" });
  }
});
