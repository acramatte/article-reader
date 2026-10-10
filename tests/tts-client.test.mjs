import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeSpeech, retryDelay } from "../tts-client.mjs";

const body = { text: "Hello", voice: "jane", speed: 1 };
const unavailable = () => Response.json({ code: "INFERENCE_UNAVAILABLE" }, { status: 503 });
const busy = (headers = {}) => Response.json({ code: "INFERENCE_BUSY", error: "Pocket TTS is busy." }, { status: 429, headers });
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

test("auth, unclassified 429/503, and network failures are never retried", async () => {
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

test("Stop during a startup or busy retry wait aborts promptly and no later request is sent", async () => {
  for (const [rejection, waiting] of [[unavailable, true], [busy, false]]) {
    const controller = new AbortController();
    let calls = 0;
    const states = [];
    const started = Date.now();
    await assert.rejects(synthesizeSpeech(body, controller.signal, (state) => {
      states.push(state);
      if (states.length === 1) setTimeout(() => controller.abort(), 20);
    }, { fetchSpeech: async () => { calls++; return rejection(); } }), { name: "AbortError" });
    assert.ok(Date.now() - started < 500, "Stop does not wait for Retry-After");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(calls, 1);
    assert.deepEqual(states, [waiting, false]);
  }
});

test("a busy engine is retried within the deadline without counting as startup or warming", async () => {
  const responses = [unavailable, () => busy({ "Retry-After": "1" }), () => new Response(new Uint8Array([1, 2]))];
  const states = [];
  const bodies = [];
  const started = Date.now();
  const result = await synthesizeSpeech(body, signal(), (waiting) => states.push(waiting), {
    // Only one startup attempt may be retried; the busy rejection must not use it up.
    maxAttempts: 2,
    fetchSpeech: async (_url, options) => { bodies.push(JSON.parse(options.body)); return responses[bodies.length - 1](); },
  });
  assert.deepEqual(new Uint8Array(result), new Uint8Array([1, 2]));
  assert.deepEqual(bodies, [body, body, body]);
  assert.deepEqual(states, [true, false, false], "warming ends once the engine answers busy");
  assert.ok(Date.now() - started >= 2000, "Retry-After is honoured");
});

test("busy retries poll at 1 then 2 seconds, never backing off to the startup cap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  let calls = 0;
  const pending = synthesizeSpeech(body, signal(), undefined, {
    maxAttempts: 1,
    fetchSpeech: async () => ++calls === 6 ? new Response(new Uint8Array([1])) : busy({ "Retry-After": "1" }),
  });
  await settle();
  for (const delay of [1000, 2000, 2000, 2000, 2000]) {
    const before = calls;
    t.mock.timers.tick(delay - 1);
    await settle();
    assert.equal(calls, before, `no retry before ${delay} ms`);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(calls, before + 1, `retry after ${delay} ms`);
  }
  assert.deepEqual(new Uint8Array(await pending), new Uint8Array([1]));
});

test("one total deadline ends Retry-After waiting without another request", async () => {
  let calls = 0;
  await assert.rejects(synthesizeSpeech(body, signal(), undefined, {
    timeoutMs: 30,
    fetchSpeech: async () => { calls++; return Response.json({ code: "INFERENCE_UNAVAILABLE" }, { status: 503, headers: { "Retry-After": "600" } }); },
  }), { name: "TimeoutError", message: "Speech engine startup timed out. Please try again." });
  assert.equal(calls, 1);
});

test("the same deadline ends a persistently busy engine with a busy, not startup, error", async () => {
  let calls = 0;
  await assert.rejects(synthesizeSpeech(body, signal(), undefined, {
    timeoutMs: 30, maxAttempts: 1, fetchSpeech: async () => { calls++; return busy({ "Retry-After": "600" }); },
  }), { name: "TimeoutError", message: "Speech engine stayed busy. Please try again." });
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
