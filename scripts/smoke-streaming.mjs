import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Requires a real, reachable Pocket TTS service. No fixture synthesis in this packaging test.
const [image = "article-reader:streaming-spike", ttsUrl, network] = process.argv.slice(2);
if (!ttsUrl || !network) throw new Error("Usage: node scripts/smoke-streaming.mjs IMAGE TTS_URL DOCKER_NETWORK");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const id = docker("run", "--detach", "--init", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
  "--memory=512m", "--cpus=1", "--pids-limit=128", "--network", network,
  "--tmpfs", "/spool:size=272m,mode=0700,uid=1000,gid=1000", "--publish", "127.0.0.1::3001",
  "--env", `TTS_URL=${ttsUrl}`, "--env", "STREAM_SPOOL_DIR=/spool", "--env", "PORT=3001", image);
const directory = await mkdtemp(join(tmpdir(), "reader-stream-smoke-"));
try {
  const port = docker("port", id, "3001/tcp").split(":").at(-1);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Readiness probe. */ }
    if (ready) break;
    await delay(250);
  }
  assert.ok(ready, "Streaming container did not become ready");
  assert.equal(docker("exec", id, "id", "-u"), "1000");
  const landing = await fetch(base + "/", { redirect: "manual" });
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /id="narration-audio"/);
  for (const [asset, type] of [["streaming.html", "text/html"], ["streaming.js", "text/javascript"], ["streaming-state.js", "text/javascript"]]) {
    const response = await fetch(`${base}/${asset}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), type);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const started = performance.now();
  const created = await post("/api/streaming", { voice: "jane", speed: 1, paceSeconds: 5,
    text: "This is real speech from the production inference image, encoded by the reader container. The first paragraph should arrive before the whole recording is generated.\n\nThe second paragraph tests continuous encoding of separate speech chunks. It should follow the first without a second media player or JavaScript audio scheduling." });
  assert.equal(created.status, 201);
  const session = await created.json();
  const response = await fetch(base + session.audioUrl, { signal: AbortSignal.timeout(120_000) });
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(first.value.length > 0);
  const firstSeconds = (performance.now() - started) / 1000;
  const early = await fetch(`${base}/api/streaming/${session.id}/status`).then(r => r.json());
  assert.ok(early.generated < early.total, "Stream waited for the whole narration");
  const pieces = [first.value];
  while (true) { const chunk = await reader.read(); if (chunk.done) break; pieces.push(chunk.value); }
  const path = join(directory, "real-stream.mp3");
  await writeFile(path, Buffer.concat(pieces));
  const decoded = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "pipe:1"], { maxBuffer: 20_000_000 });
  let sum = 0;
  for (let offset = 0; offset < decoded.length; offset += 4) sum += decoded.readFloatLE(offset) ** 2;
  const rms = Math.sqrt(sum / (decoded.length / 4));
  assert.ok(rms > 0.005, "Decoded real narration was silent");
  const complete = await fetch(`${base}/api/streaming/${session.id}/status`).then(r => r.json());
  assert.equal(complete.state, "ready");
  assert.equal(complete.generated, complete.total);
  assert.equal((await post(`/api/streaming/${session.id}/stop`, {})).status, 200);
  assert.equal(docker("exec", id, "node", "-e", 'process.stdout.write(JSON.stringify(require("fs").readdirSync("/spool")))'), '[".reader-instance.lock"]');
  console.log("Real streaming container smoke passed", JSON.stringify({ firstSeconds, earlyGenerated: early.generated,
    total: complete.total, bytes: complete.bytes, audioSeconds: complete.audioSecondsGenerated, rms }));
} catch (error) {
  console.error(docker("logs", id));
  console.error(docker("inspect", "--format", "{{json .State}}", id));
  throw error;
} finally {
  docker("rm", "--force", id);
  await rm(directory, { recursive: true, force: true });
}
