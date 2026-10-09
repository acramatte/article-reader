import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect } from "@playwright/test";

export const BOOKMARK_KEY = "reader.streaming.resume.v1";
export const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// SYNTHETIC/UI-only: real native media decoding, never Pocket TTS/provider acceptance.
function syntheticWav(seconds) {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(rate, 24);
  audio.writeUInt32LE(rate * 2, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) audio.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 220 * i / rate)), 44 + i * 2);
  return audio;
}

export async function mockNarration(page, { seconds = 12, state = "ready", generated = 1, total = 1,
  warming = false, mediaGate, stopGate, statusGate, admissionGate } = {}) {
  const fixture = { requests: [], stops: [], contentReads: [], mediaReads: [], statusReads: [], sessions: new Map(),
    status: { state, generated, total, warming }, statusCode: 200, admissionError: null,
    mediaGate, stopGate, statusGate, admissionGate };
  // Playwright fulfill buffers entire responses. Use a real HTTP stream so native
  // EventSource receives pushes and reconnects without a test-side polling timer.
  const observers = new Set();
  fixture.eventReads = [];
  const send = response => {
    response.write(`event: status\ndata: ${JSON.stringify(fixture.status)}\n\n`);
    if (["ready", "error", "stopped"].includes(fixture.status.state)) response.end();
  };
  const publish = () => { for (const response of observers) if (!response.writableEnded) send(response); };
  let snapshot;
  Object.defineProperty(fixture, "status", {
    get: () => snapshot,
    set: value => {
      snapshot = new Proxy(value, { set(target, key, next) { target[key] = next; publish(); return true; } });
      publish();
    },
  });
  fixture.status = { state, generated, total, warming };
  fixture.disconnectStatus = () => { for (const response of observers) response.destroy(); };
  const eventServer = createServer(async (request, response) => {
    const id = request.url.split("/")[3];
    fixture.eventReads.push(id);
    if (fixture.statusGate) await fixture.statusGate.promise;
    if (response.destroyed) return;
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (!fixture.sessions.has(id) || fixture.statusCode !== 200) {
      response.writeHead(fixture.sessions.has(id) ? fixture.statusCode : 404, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ error: "Synthetic recording expired" }));
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    observers.add(response);
    response.on("close", () => observers.delete(response));
    send(response);
  }).listen(0, "127.0.0.1");
  await once(eventServer, "listening");
  page.on("close", () => { eventServer.closeAllConnections(); eventServer.close(); });
  const body = syntheticWav(seconds);
  await page.route("**/api/streaming{,/**}", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/streaming" && request.method() === "POST") {
      const content = request.postDataJSON();
      fixture.requests.push(content);
      if (fixture.admissionGate) await fixture.admissionGate.promise;
      if (fixture.admissionError) return route.fulfill({ status: 502, json: { error: fixture.admissionError } });
      const id = randomUUID();
      fixture.sessions.set(id, content);
      fixture.id = id;
      return route.fulfill({ status: 201, json: { id } });
    }
    const [, id, action] = path.match(/^\/api\/streaming\/([^/]+)\/(status|events|content|audio|stop)$/) || [];
    if (action === "events") return route.continue({ url: `http://127.0.0.1:${eventServer.address().port}${path}` });
    if (!id || !fixture.sessions.has(id)) return route.fulfill({ status: 404, json: { error: "Synthetic recording expired" } });
    if (action === "status") {
      fixture.statusReads.push(id);
      if (fixture.statusGate) await fixture.statusGate.promise;
      return route.fulfill({ status: fixture.statusCode, json: fixture.status });
    }
    if (action === "content") {
      fixture.contentReads.push(id);
      return route.fulfill({ json: fixture.sessions.get(id) });
    }
    if (action === "stop") {
      fixture.stops.push(id);
      if (fixture.stopGate) await fixture.stopGate.promise;
      return route.fulfill({ json: { stopped: true } });
    }
    fixture.mediaReads.push(id);
    if (fixture.mediaGate) await fixture.mediaGate.promise;
    // Range support matters for completed-file recovery seeks.
    const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: "audio/wav",
      headers: { "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${end}/${body.length}` } : {}) },
      body: body.subarray(start, end + 1) });
  });
  return fixture;
}

export async function startPasted(page, text = "SYNTHETIC/UI-only narration fixture.") {
  await page.goto("/");
  await page.locator("#paste-fallback").click();
  await page.locator("#text").fill(text);
  await page.locator("#read-start").click();
}

export const nativeTime = (page) => page.locator("#narration-audio").evaluate((audio) => audio.currentTime);
export const bookmark = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), BOOKMARK_KEY);

export async function finishNativeFixture(page) {
  await page.locator("#narration-audio").evaluate((audio) => { audio.currentTime = audio.duration - 0.15; });
  await expect(page.locator("#status")).toHaveText("Finished");
}

// Explicit synthetic media events test UI transitions, not actual stream starvation.
export async function mediaEvent(page, name) {
  await page.locator("#narration-audio").evaluate((audio, event) => audio.dispatchEvent(new Event(event)), name);
}
