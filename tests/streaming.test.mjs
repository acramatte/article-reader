import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createStreamingApp } from "../streaming-server.mjs";
import { pcmFromWav, StreamingNarrations } from "../streaming.mjs";

// Deliberately synthetic tone. Tests exercise real FFmpeg, not speech quality.
function wav(seconds = 3) {
  const samples = Math.round(seconds * 24_000);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24); bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(4000 * Math.sin(i * 2 * Math.PI * 440 / 24_000)), 44 + i * 2);
  return bytes;
}

async function app(t, options = {}) {
  const spoolDir = await mkdtemp(join(tmpdir(), "reader-stream-test-"));
  const server = createStreamingApp({ spoolDir, synthesizeChunk: async () => wav(), ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await server.narrations.close();
    await rm(spoolDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: "POST",
    headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const create = async (extra = {}) => {
    const response = await post("/api/streaming", { text: "One paragraph.\n\nAnother paragraph.", voice: "jane", speed: 1, ...extra });
    assert.equal(response.status, 201);
    return response.json();
  };
  return { base, post, create, server, spoolDir };
}

async function until(fn, accept, timeout = 5000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await fn();
    if (accept(value)) return value;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail("Streaming state did not reach expected condition");
}

// Decode with real FFmpeg into the same 24 kHz mono PCM16 layout as the source fixture.
async function decodeMp3(bytes) {
  const decoder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "mp3", "-i", "pipe:0",
    "-f", "s16le", "-ar", "24000", "-ac", "1", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
  const pieces = [];
  decoder.stdout.on("data", piece => pieces.push(piece));
  const closed = once(decoder, "close");
  decoder.stdin.end(bytes);
  const [code] = await closed;
  assert.equal(code, 0, "MP3 decodes");
  const pcm = Buffer.concat(pieces);
  return Int16Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2));
}

// Frequency from hysteresis zero crossings over a central window, away from encoder padding and chunk joins.
function centralFrequency(samples, windowSeconds = 0.4) {
  const length = Math.round(windowSeconds * 24_000);
  const start = Math.floor((samples.length - length) / 2);
  let crossings = 0;
  let sign = 0;
  for (let i = start; i < start + length; i++) {
    const next = samples[i] > 500 ? 1 : samples[i] < -500 ? -1 : sign;
    if (sign && next !== sign) crossings++;
    sign = next;
  }
  return crossings / 2 / windowSeconds;
}

const status = (base, id) => fetch(`${base}/api/streaming/${id}/status`).then(r => r.json());
const recordingEntries = async directory => (await readdir(directory)).filter(name => name !== ".reader-instance.lock");

test("spool ownership lock stays inside its writable mount on a read-only runtime", async t => {
  const parent = await mkdtemp(join(tmpdir(), "reader-readonly-"));
  const spoolDir = join(parent, "spool");
  await mkdir(spoolDir);
  const engine = new StreamingNarrations({ spoolDir, synthesizeChunk: async () => wav() });
  t.after(async () => { await chmod(parent, 0o700); await engine.close(); await rm(parent, { recursive: true, force: true }); });
  await chmod(parent, 0o500);
  const session = await engine.create({ text: "Writable spool fixture.", voice: "jane", speed: 1 });
  await session.done;
  assert.equal(session.state, "ready");
  assert.equal(engine.lockPath, join(spoolDir, ".reader-instance.lock"));
});

test("spike root opens the experiment and test assets are not cached", async (t) => {
  const { base } = await app(t, { staticDir: "public" });
  const root = await fetch(base, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/streaming.html");
  const page = await fetch(base + "/streaming.html");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("x-reader-experiment"), "continuous-mp3-v1");
  assert.match(await page.text(), /Mark test, then lock phone/);
  assert.equal((await fetch(base + "/streaming.js")).headers.get("cache-control"), "no-store");
});

test("malformed request targets stay inside the HTTP error boundary", async (t) => {
  const { server } = await app(t);
  let code;
  const response = { setHeader() {}, writeHead(status) { code = status; }, end() {} };
  await assert.doesNotReject(server.listeners("request")[0]({ url: "//[", method: "GET", headers: {} }, response));
  assert.equal(code, 400);
});

test("first creation after a hard crash removes abandoned recordings without deleting unrelated directories", async (t) => {
  const { create, spoolDir } = await app(t);
  await mkdir(join(spoolDir, "unrelated"));
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { StreamingNarrations } from "./streaming.mjs";
    const engine = new StreamingNarrations({ spoolDir: ${JSON.stringify(spoolDir)},
      synthesizeChunk: async () => Buffer.from(${JSON.stringify(wav(0.1).toString("base64"))}, "base64") });
    const session = await engine.create({ text: "A ready recording", voice: "jane", speed: 1 });
    await session.done;
    if (session.state !== "ready") throw new Error(session.error);
    console.log(JSON.stringify({ directory: session.directory }));
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const exited = once(child, "exit");
  const [data] = await Promise.race([once(child.stdout, "data"), exited.then(() => { throw new Error("Recording child exited before readiness"); })]);
  const { directory } = JSON.parse(data.toString());
  child.kill("SIGKILL");
  await exited;
  assert.ok((await readdir(directory)).includes("audio.mp3"));
  await create();
  const entries = await readdir(spoolDir);
  assert.ok(!entries.includes(directory.split("/").at(-1)), "crashed process recording was cleaned up");
  assert.ok(entries.includes("unrelated"), "unrelated files were left alone");
});

test("ready paused recordings outlive generation/disconnect deadlines and expire only after retention", async t => {
  const { base, create, server, spoolDir } = await app(t, { generationMs: 500, retentionMs: 1000, disconnectMs: 300 });
  const { id } = await create({ text: "A ready paused recording", title: "Saved" });
  const session = server.narrations.sessions.get(id);
  await session.done;
  assert.equal(session.state, "ready");
  assert.ok(session.expiresAt >= session.readyAt + 1000);
  await delay(550);
  assert.equal((await status(base, id)).state, "ready");
  assert.equal((await (await fetch(`${base}/api/streaming/${id}/content`)).json()).text, "A ready paused recording");
  const audio = await fetch(`${base}/api/streaming/${id}/audio`);
  assert.equal(audio.status, 200); assert.ok((await audio.arrayBuffer()).byteLength > 0);
  await until(() => fetch(`${base}/api/streaming/${id}/status`), r => r.status === 404);
  assert.equal(session.text, null);
  assert.deepEqual(await recordingEntries(spoolDir), []);
});

test("disconnect grace applies to unfinished generation only and clears its text", async t => {
  const { base, create, server, spoolDir } = await app(t, { disconnectMs: 100, generationMs: 1000,
    synthesizeChunk: async (_body, signal) => { await delay(10000, undefined, { signal }); return wav(); } });
  const { id } = await create();
  const session = server.narrations.sessions.get(id);
  await until(() => status(base, id), s => s.state === "stopped");
  await session.done;
  assert.equal(session.text, null);
  assert.deepEqual(await recordingEntries(spoolDir), []);
});

test("disconnect expiry rechecks consumers and terminal state before stopping", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engine = new StreamingNarrations({ disconnectMs: 100, synthesizeChunk: async () => wav() });
  const stop = t.mock.method(engine, "stop", async () => {});
  for (const change of [{ consumers: 1 }, { state: "ready" }, {}]) {
    const session = { consumers: 0, state: "generating" };
    engine.armDisconnect(session);
    Object.assign(session, change);
    t.mock.timers.tick(100);
  }
  assert.equal(stop.mock.callCount(), 1, "only a still-generating disconnected session is stopped");
});

test("capacity evicts inactive recordings, never an actively consumed recording", async t => {
  const { create, server, spoolDir } = await app(t, { maxSessions: 2 });
  const first = server.narrations.sessions.get((await create({ text: "First" })).id);
  await first.done;
  first.consumers = 1; // Deterministic reservation; actual audio disconnect is covered separately.
  t.after(() => { first.consumers = 0; });
  const second = server.narrations.sessions.get((await create({ text: "Second" })).id);
  await second.done;
  const third = server.narrations.sessions.get((await create({ text: "Third" })).id);
  await third.done;
  assert.ok(server.narrations.sessions.has(first.id));
  assert.ok(!server.narrations.sessions.has(second.id));
  assert.equal(second.text, null);
  assert.equal((await recordingEntries(spoolDir)).length, 2);
  third.consumers = 1;
  await assert.rejects(server.narrations.create({ text: "Fourth", voice: "jane", speed: 1 }), error => error.status === 429);
  third.consumers = 0;
});

test("each default app owns its spool; explicit spool cannot be shared by live instances", async t => {
  const first = new StreamingNarrations({ synthesizeChunk: async () => wav(0.1) });
  const second = new StreamingNarrations({ synthesizeChunk: async () => wav(0.1) });
  t.after(() => Promise.all([first.close(), second.close()]));
  assert.notEqual(first.spoolDir, second.spoolDir);
  const a = await first.create({ text: "First", voice: "jane", speed: 1 }); await a.done;
  const b = await second.create({ text: "Second", voice: "jane", speed: 1 }); await b.done;
  await first.close();
  assert.ok((await readdir(b.directory)).includes("audio.mp3"));
  const impostor = new StreamingNarrations({ spoolDir: second.spoolDir, synthesizeChunk: async () => wav(0.1) });
  t.after(() => impostor.close());
  await assert.rejects(impostor.create({ text: "Intruder", voice: "jane", speed: 1 }), /already owned/);
  assert.ok((await readdir(b.directory)).includes("audio.mp3"));
});

test("close cancels generation, clears files, is idempotent and rejects admission during spool startup", async t => {
  const { create, server, spoolDir } = await app(t, { synthesizeChunk: async (_body, signal) => {
    await delay(10000, undefined, { signal }); return wav();
  } });
  const session = server.narrations.sessions.get((await create()).id);
  await server.shutdown();
  assert.equal(session.text, null);
  assert.deepEqual(await readdir(spoolDir), []);
  assert.equal(server.narrations.sessions.size, 0);
  await server.shutdown();
  await assert.rejects(server.narrations.create({ text: "Late", voice: "jane", speed: 1 }), /shutting down/);
  const raced = new StreamingNarrations({ spoolDir: join(spoolDir, "raced"), synthesizeChunk: async () => wav() });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const prepare = raced.prepareSpool.bind(raced);
  raced.prepareSpool = async () => { await gate; await prepare(); };
  const admission = raced.create({ text: "Raced", voice: "jane", speed: 1 });
  const rejected = assert.rejects(admission, /shutting down/);
  const closed = raced.close();
  release();
  await Promise.all([rejected, closed]);
  assert.equal(raced.sessions.size, 0);
  assert.deepEqual(await readdir(raced.spoolDir), []);
});

test("normal server SIGTERM/SIGINT close connections, inference and the spool", async t => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const spool = await mkdtemp(join(tmpdir(), "reader-signal-test-"));
    t.after(() => rm(spool, { recursive: true, force: true }));
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { createApp, installShutdown } from "./server.mjs";
      import { once } from "node:events";
      import { setTimeout as delay } from "node:timers/promises";
      const server = createApp({ spoolDir: ${JSON.stringify(spool)}, synthesizeChunk: async (_body, signal) => {
        await delay(10000, undefined, { signal });
      } });
      installShutdown(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const session = await server.narrations.create({ text: "Pending work", voice: "jane", speed: 1 });
      console.log(JSON.stringify({ id: session.id }));
    `], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => child.kill("SIGKILL"));
    const exited = once(child, "exit");
    await Promise.race([once(child.stdout, "data"), exited.then(() => { throw new Error("Child exited before admission"); })]);
    child.kill(signal);
    const [code, exitSignal] = await exited;
    assert.equal(code, 0); assert.equal(exitSignal, null);
    assert.deepEqual(await readdir(spool), []);
    await assert.rejects(readdir(`${spool}.lock`), error => error.code === "ENOENT");
  }
});

test("WAV parsing validates actual PCM layout and chunk boundaries", () => {
  const bytes = wav();
  assert.equal(pcmFromWav(bytes).length, 144_000);
  for (const corrupt of [Buffer.from("not WAV"), bytes.subarray(0, bytes.length - 1)]) assert.throws(() => pcmFromWav(corrupt), /WAV/);
  const stereo = Buffer.from(bytes); stereo.writeUInt16LE(2, 22);
  assert.throws(() => pcmFromWav(stereo), /mono/);
  const wrongRate = Buffer.from(bytes); wrongRate.writeUInt32LE(44_100, 24);
  assert.throws(() => pcmFromWav(wrongRate), /24/);
});

test("streaming speed is applied once by FFmpeg atempo while upstream synthesis stays at speed 1", async t => {
  const sourceSeconds = [1, 2, 1.5]; // Independent expectation: the fixture durations, not PCM measured by the engine.
  const totalSource = sourceSeconds.reduce((sum, seconds) => sum + seconds, 0);
  for (const speed of [0.5, 1.5, 2]) {
    await t.test(`speed ${speed}`, async t => {
      const requests = [];
      const accountedBefore = [];
      const { base, post, server } = await app(t, { synthesizeChunk: async body => {
        const [session] = server.narrations.sessions.values();
        accountedBefore.push(session.audioSecondsGenerated);
        requests.push(body);
        return wav(sourceSeconds[requests.length - 1]);
      } });
      const response = await post("/api/streaming",
        { text: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.", voice: "estelle", speed });
      assert.equal(response.status, 201);
      const { id } = await response.json();
      await server.narrations.sessions.get(id).done;
      const ready = await status(base, id);
      assert.equal(ready.state, "ready");
      assert.equal(ready.generated, 3);

      // Session keeps the listener's selection; every upstream request is unmodified speed 1.
      assert.equal(ready.voice, "estelle"); assert.equal(ready.speed, speed);
      const content = await (await fetch(`${base}/api/streaming/${id}/content`)).json();
      assert.equal(content.voice, "estelle"); assert.equal(content.speed, speed);
      assert.deepEqual(requests, ["First paragraph.", "Second paragraph.", "Third paragraph."]
        .map(text => ({ text, voice: "estelle", speed: 1 })));

      // Accounting is cumulative output seconds: source seconds divided by speed, chunk by chunk.
      const cumulative = sourceSeconds.map((_, i) => sourceSeconds.slice(0, i).reduce((s, x) => s + x, 0) / speed);
      accountedBefore.forEach((value, i) => assert.ok(Math.abs(value - cumulative[i]) < 1e-9,
        `before chunk ${i + 1}: ${value} vs ${cumulative[i]}`));
      assert.ok(Math.abs(ready.audioSecondsGenerated - totalSource / speed) < 1e-9,
        `accounted ${ready.audioSecondsGenerated}s, expected ${totalSource / speed}s`);

      // Actual decoded audio duration matches source/speed (omitted, inverted or doubled tempo would be far off).
      const samples = await decodeMp3(Buffer.from(await (await fetch(`${base}/api/streaming/${id}/audio`)).arrayBuffer()));
      const actual = samples.length / 24_000;
      const expected = totalSource / speed;
      assert.ok(Math.abs(actual - expected) < Math.max(0.15, expected * 0.04),
        `decoded ${actual.toFixed(3)}s, expected about ${expected}s at speed ${speed}`);
      // Tempo change, not resampling: the 440 Hz tone keeps its pitch.
      const frequency = centralFrequency(samples);
      assert.ok(Math.abs(frequency - 440) < 22, `central pitch ${frequency} Hz, expected about 440 Hz`);
    });
  }
});

test("real MP3 bytes arrive before later chunks are generated; disconnected playback does not own synthesis", async (t) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let calls = 0;
  const { base, create } = await app(t, { synthesizeChunk: async () => { if (++calls === 2) await gate; return wav(); } });
  const { id } = await create();
  const abort = new AbortController();
  const response = await fetch(`${base}/api/streaming/${id}/audio`, { signal: abort.signal });
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(first.value.length > 0);
  const before = await status(base, id);
  assert.equal(before.generated, 1);
  assert.equal(before.state, "generating");
  assert.ok(before.bytes > 0);
  abort.abort();
  await reader.cancel().catch(() => {});
  release();
  const ready = await until(() => status(base, id), s => s.state === "ready");
  assert.equal(ready.generated, 2);
  assert.equal(ready.total, 2, "clearing completed chunk text preserves the diagnostic total");
  assert.equal(calls, 2);
  const replay = await fetch(`${base}/api/streaming/${id}/audio`);
  const audio = new Uint8Array(await replay.arrayBuffer());
  assert.equal(audio.length, ready.bytes);
  assert.equal(audio[0], 0xff); // MPEG frame sync, no invented content.
  assert.equal(calls, 2);
  const range = await fetch(`${base}/api/streaming/${id}/audio`, { headers: { Range: "bytes=10-29" } });
  assert.equal(range.status, 206);
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), audio.subarray(10, 30));
});

test("Stop cancels pending work, deletes spool and allows a fresh session", async (t) => {
  const { base, create, post, spoolDir } = await app(t, { synthesizeChunk: async (body, signal) => {
    await delay(10_000, undefined, { signal }); return wav();
  } });
  const { id } = await create();
  const stopped = await post(`/api/streaming/${id}/stop`, {});
  assert.equal(stopped.status, 200);
  assert.equal((await status(base, id)).state, "stopped");
  assert.equal((await fetch(`${base}/api/streaming/${id}/audio`)).status, 410);
  assert.deepEqual(await recordingEntries(spoolDir), []);
  assert.ok((await create()).id !== id);
});

test("bounded admission, validation and cross-origin rejection happen before inference", async (t) => {
  let calls = 0;
  const { post, create } = await app(t, { synthesizeChunk: async (body, signal) => {
    calls++; await delay(10_000, undefined, { signal }); return wav();
  } });
  for (const body of [null, {}, { text: " " }, { text: "x".repeat(100001), voice: "jane", speed: 1 },
    { text: "hello", voice: "unknown", speed: 1 }, { text: "hello", voice: "jane", speed: 3 },
    { text: "hello", voice: "jane", speed: 1, paceSeconds: 100 },
    ...["af_heart", "af_nicole", "am_michael", "ff_siwis"].map(voice => ({ text: "hello", voice, speed: 1 }))]) {
    assert.equal((await post("/api/streaming", body)).status, 400);
  }
  assert.equal((await post("/api/streaming", {}, { Origin: "https://evil.example" })).status, 403);
  assert.equal(calls, 0);
  await create();
  const busy = await post("/api/streaming", { text: "Another", voice: "jane", speed: 1 });
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "2");
});

test("concurrent creation cannot bypass single-generation admission", async (t) => {
  const { post } = await app(t, { synthesizeChunk: async (body, signal) => {
    await delay(10_000, undefined, { signal }); return wav();
  } });
  const results = await Promise.all(Array.from({ length: 3 }, () => post("/api/streaming", {
    text: "Concurrent narration", voice: "jane", speed: 1,
  })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 429, 429]);
});

test("encoder failures are reported, not mistaken for finished audio", async (t) => {
  const { base, create } = await app(t, { ffmpegPath: "/does/not/exist/ffmpeg" });
  const { id } = await create();
  const failed = await until(() => status(base, id), s => s.state === "error");
  assert.match(failed.error, /encoder/i);
  assert.equal((await fetch(`${base}/api/streaming/${id}/audio`)).status, 502);
});

test("disk limits and generation deadline report errors and clean up", async (t) => {
  const limited = await app(t, { maxAudioBytes: 100 });
  const { id } = await limited.create();
  const failed = await until(() => status(limited.base, id), s => s.state === "error");
  assert.match(failed.error, /limit/);
  await until(() => recordingEntries(limited.spoolDir), files => files.length === 0);
  const expired = await app(t, { generationMs: 80, synthesizeChunk: async (body, signal) => {
    await delay(10_000, undefined, { signal }); return wav();
  } });
  const session = await expired.create();
  const timedOut = await until(() => status(expired.base, session.id), s => s.state === "error");
  assert.match(timedOut.error, /generation timed out/);
  assert.equal(timedOut.total, 2, "clearing timed-out chunk text preserves the diagnostic total");
  await until(() => recordingEntries(expired.spoolDir), files => files.length === 0);
  assert.equal((await fetch(`${expired.base}/api/streaming/${session.id}/content`)).status, 410);
  assert.deepEqual(await recordingEntries(expired.spoolDir), []);
});
