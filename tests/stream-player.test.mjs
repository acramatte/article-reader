import test from "node:test";
import assert from "node:assert/strict";
import { StreamingPlayer } from "../stream-player.mjs";
import { PlaybackBookmark } from "../public/streaming-state.js";

const id = "81b16cd8-fab8-4ed9-b855-7f127299e944";
const content = { text: "Recover this article without generating it again.", title: "A saved article", byline: "Fixture", sourceUrl: "https://example.com/article", voice: "bill_boerst", speed: 1.2 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Unit-only media model. Browser tests separately exercise actual native MP3 playback.
class MediaFixture extends EventTarget {
  constructor() {
    super();
    this.paused = true;
    this.ended = false;
    this.duration = 12;
    this.position = 0;
    this.seeking = false;
    this.playbackRate = 1;
    this.playCalls = 0;
    this.buffered = { length: 1, start: () => 0, end: () => 12 };
  }
  get currentTime() { return this.position; }
  set currentTime(value) { this.position = value; this.dispatchEvent(new Event("seeked")); }
  play() { this.playCalls++; this.paused = false; this.dispatchEvent(new Event("playing")); return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event("pause")); } }
  load() { if (this.src) this.dispatchEvent(new Event("loadedmetadata")); else this.position = 0; }
  getAttribute(name) { return this[name] || null; }
  removeAttribute(name) { delete this[name]; }
}

function fixture(t, handler) {
  const values = new Map();
  const bookmark = new PlaybackBookmark({ storage: () => ({ getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }) });
  const audio = new MediaFixture();
  const calls = [], updates = [], restored = [];
  const player = new StreamingPlayer({ audio, bookmarkReady: Promise.resolve(bookmark), pollMs: 100_000,
    onUpdate: update => updates.push(update), onRestore: article => restored.push(article),
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      const result = await handler(path, options);
      return { ok: !result.status || result.status === 200, status: result.status || 200, json: async () => result.body ?? result };
    },
  });
  t.after(() => player.dispose());
  return { player, bookmark, audio, calls, updates, restored };
}

const ready = { state: "ready", generated: 2, total: 2, warming: false };
const standard = path => path.endsWith("/status") ? ready : path.endsWith("/content") ? content : { id };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("session requests do not bind a native fetch implementation to the player", async t => {
  const { player } = fixture(t, standard);
  const send = player.fetchImpl;
  player.fetchImpl = function (...args) {
    assert.equal(this, undefined, "browser fetch rejects an unrelated receiver");
    return send(...args);
  };
  await player.start(async () => content);
  await tick();
  assert.equal(player.error, undefined);
  assert.equal(player.state, "playing");
});

test("Stop clears stale provider warmup status before exposing a fresh start", async t => {
  const { player, updates } = fixture(t, standard);
  await player.ready;
  player.id = id;
  player.snapshot = { state: "generating", warming: true };
  player.emit();
  assert.equal(updates.at(-1).warming, true);
  await player.shutdown();
  assert.equal(updates.at(-1).state, "stopped");
  assert.equal(updates.at(-1).warming, false);
});

test("a rejected native play waits for server failure status instead of masking its cause", async t => {
  const gate = deferred();
  const { player, audio } = fixture(t, async path => {
    if (path.endsWith("/status")) { await gate.promise; return { state: "error", error: "Speech engine connection failed." }; }
    return standard(path);
  });
  audio.play = () => Promise.reject(new Error("No supported source"));
  const start = player.start(async () => content);
  await tick();
  gate.resolve();
  await start;
  assert.equal(player.state, "error");
  assert.equal(player.error, "Speech engine connection failed.");
});

test("native media starts from a server session; pause/resume never creates another narration", async t => {
  const { player, audio, calls, bookmark, updates } = fixture(t, standard);
  await player.start(async () => content);
  await tick();
  assert.equal(audio.src, `/api/streaming/${id}/audio`);
  assert.equal(updates.at(-1).state, "playing");
  audio.currentTime = 4;
  await player.togglePause();
  assert.equal(bookmark.load().positionSeconds, 4);
  await player.togglePause();
  assert.equal(audio.playCalls, 2);
  assert.equal(calls.filter(call => call.path === "/api/streaming").length, 1);
});

test("Stop waits for delayed admission, cancels its acknowledged session, then permits restart", async t => {
  const admitted = deferred();
  const { player, audio, calls, bookmark, updates } = fixture(t, path => path === "/api/streaming" ? admitted.promise : { state: "stopped" });
  const starting = player.start(async () => content);
  await tick();
  const stopping = player.shutdown();
  assert.equal(updates.at(-1).state, "stopping");
  admitted.resolve({ id });
  await Promise.all([starting, stopping]);
  assert.equal(calls.filter(call => call.path.endsWith("/stop")).length, 1);
  assert.equal(audio.playCalls, 0);
  assert.equal(bookmark.load(), null);
  assert.equal(updates.at(-1).state, "stopped");
});

test("dispose cancels late admission once without attaching media or emitting updates", async t => {
  const admitted = deferred();
  const { player, audio, calls, bookmark, updates } = fixture(t, path => path === "/api/streaming" ? admitted.promise : { state: "stopped" });
  const starting = player.start(async () => content);
  await tick();
  const disposing = player.dispose();
  assert.equal(player.dispose(), disposing);
  const updateCount = updates.length;
  admitted.resolve({ id });
  await Promise.all([starting, disposing]);
  assert.equal(calls.filter(call => call.path.endsWith("/stop")).length, 1);
  assert.equal(audio.src, undefined);
  assert.equal(audio.playCalls, 0);
  assert.equal(bookmark.load(), null);
  assert.equal(updates.length, updateCount);
});

test("dispose during preparation prevents admission", async t => {
  const prepared = deferred();
  const { player, calls } = fixture(t, standard);
  const starting = player.start(() => prepared.promise);
  await tick();
  await player.dispose();
  prepared.resolve(content);
  await starting;
  assert.equal(calls.length, 0);
});

test("dispose preserves acknowledged recordings and their recovery position", async t => {
  const { player, audio, bookmark, calls } = fixture(t, standard);
  await player.start(async () => content);
  audio.currentTime = 4;
  await player.dispose();
  assert.equal(bookmark.load().positionSeconds, 4);
  assert.equal(calls.filter(call => call.path.endsWith("/stop")).length, 0);
});

test("dispose overlapping Stop leaves pending admission cancellation to Stop", async t => {
  const admitted = deferred();
  const { player, calls } = fixture(t, path => path === "/api/streaming" ? admitted.promise : { state: "stopped" });
  const starting = player.start(async () => content);
  await tick();
  const stopping = player.shutdown();
  player.dispose();
  admitted.resolve({ id });
  await Promise.all([starting, stopping]);
  assert.equal(calls.filter(call => call.path.endsWith("/stop")).length, 1);
});

test("failed disposal cancellation is handled without clearing another recovery bookmark", async t => {
  const admitted = deferred();
  const { player, bookmark } = fixture(t, path => {
    if (path === "/api/streaming") return admitted.promise;
    throw new Error("Offline fixture");
  });
  const starting = player.start(async () => content);
  await tick();
  const disposing = player.dispose();
  bookmark.save({ id, title: content.title, positionSeconds: 6 }, true);
  admitted.resolve({ id });
  await Promise.all([starting, disposing]);
  assert.match(player.warning, /Could not confirm cancellation: Offline fixture/);
  assert.equal(bookmark.load().positionSeconds, 6);
});

test("recovery restores content and position but requires an explicit play action", async t => {
  const { player, audio, calls, bookmark, restored, updates } = fixture(t, standard);
  bookmark.save({ id, title: content.title, positionSeconds: 6 }, true);
  assert.equal(await player.restore(), true);
  assert.deepEqual(restored, [content]);
  assert.equal(audio.currentTime, 6);
  assert.equal(audio.playCalls, 0);
  assert.equal(updates.at(-1).recovering, false);
  assert.equal(updates.at(-1).paused, true);
  await player.togglePause();
  assert.equal(audio.playCalls, 1);
  assert.equal(calls.filter(call => call.path === "/api/streaming").length, 0);
});

test("in-progress recovery waits for completion without playing or overwriting the saved position", async t => {
  let complete = false;
  const { player, audio, bookmark, calls } = fixture(t, path => path.endsWith("/status") ? { ...ready, state: complete ? "ready" : "generating" } : content);
  bookmark.save({ id, title: content.title, positionSeconds: 6 }, true);
  await player.restore();
  assert.equal(audio.src, undefined);
  assert.equal(bookmark.load().positionSeconds, 6);
  await player.togglePause();
  assert.equal(audio.playCalls, 0);
  complete = true;
  await player.refresh();
  assert.equal(audio.currentTime, 6);
  assert.equal(calls.filter(call => call.path.endsWith("/content")).length, 1);
});

test("transient recovery failures retain the bookmark for retry; confirmed expiry clears it", async t => {
  let mode = "offline";
  const { player, bookmark, updates } = fixture(t, path => {
    if (mode === "offline") throw new Error("Offline fixture");
    if (mode === "expired") return { status: 404, body: { error: "Missing" } };
    return standard(path);
  });
  bookmark.save({ id, title: content.title, positionSeconds: 6 }, true);
  await player.restore();
  assert.equal(bookmark.load().positionSeconds, 6);
  assert.equal(updates.at(-1).retryAvailable, true);
  mode = "expired";
  await player.refresh();
  assert.equal(bookmark.load(), null);
  assert.match(updates.at(-1).error, /expired or the server restarted/);
});

test("Stop invalidates late restoration responses and cannot reattach canceled media", async t => {
  const delayed = deferred();
  const { player, bookmark, audio, restored } = fixture(t, path => path.endsWith("/status") ? delayed.promise : { state: "stopped" });
  bookmark.save({ id, title: content.title, positionSeconds: 6 }, true);
  const restoring = player.restore();
  await tick();
  await player.shutdown();
  delayed.resolve(ready);
  await restoring;
  assert.equal(audio.src, undefined);
  assert.equal(bookmark.load(), null);
  assert.deepEqual(restored, []);
});

test("autoplay denial is recoverable with Resume, not a failed or regenerated recording", async t => {
  const { player, audio, bookmark, updates } = fixture(t, standard);
  const play = audio.play.bind(audio);
  audio.play = () => Promise.reject(new DOMException("Gesture required fixture", "NotAllowedError"));
  await player.start(async () => content);
  assert.equal(updates.at(-1).needsGesture, true);
  assert.equal(bookmark.load().id, id);
  audio.play = play;
  await player.togglePause();
  assert.equal(updates.at(-1).state, "playing");
  assert.equal(updates.at(-1).needsGesture, false);
});

test("natural completion clears the bookmark without changing server readiness to cancellation", async t => {
  const { player, bookmark, calls, updates } = fixture(t, standard);
  await player.start(async () => content);
  await tick();
  await player.finish();
  assert.equal(bookmark.load(), null);
  assert.equal(updates.at(-1).state, "finished");
  assert.equal(calls.filter(call => call.path.endsWith("/stop")).length, 0);
});

test("Pause before admission is acknowledged prevents automatic playback on its late response", async t => {
  const admitted = deferred();
  const { player, audio } = fixture(t, path => path === "/api/streaming" ? admitted.promise : ready);
  const starting = player.start(async () => content);
  await tick();
  await player.togglePause();
  admitted.resolve({ id });
  await starting;
  assert.equal(audio.playCalls, 0);
  await player.togglePause();
  assert.equal(audio.playCalls, 1);
});

test("a play rejection interrupted by Pause is not a fatal playback error", async t => {
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const { player, audio, updates } = fixture(t, standard);
  audio.play = () => pending;
  const starting = player.start(async () => content);
  await tick();
  await player.togglePause();
  reject(new DOMException("Interrupted fixture", "AbortError"));
  await starting;
  assert.equal(updates.at(-1).paused, true);
  assert.equal(updates.at(-1).error, undefined);
});

test("completion awaits an already pending status response instead of reporting a false generation error", async t => {
  const delayed = deferred();
  const { player, updates } = fixture(t, path => path.endsWith("/status") ? delayed.promise : { id });
  await player.start(async () => content);
  const finishing = player.finish();
  delayed.resolve(ready);
  await finishing;
  assert.equal(updates.at(-1).state, "finished");
  assert.equal(updates.at(-1).error, undefined);
});
