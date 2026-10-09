import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { chunkText } from "./chunks.mjs";

const terminal = state => ["ready", "error", "stopped"].includes(state);

// WAV containers cannot be concatenated. Admit only the inference service's actual PCM contract.
export function pcmFromWav(bytes) {
  const wav = Buffer.from(bytes);
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE" ||
      wav.readUInt32LE(4) + 8 !== wav.length) throw new Error("Invalid or truncated WAV audio.");
  let format = false;
  let pcm;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const type = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error("Truncated WAV chunk.");
    if (type === "fmt ") {
      if (size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 ||
          wav.readUInt32LE(start + 4) !== 24_000 || wav.readUInt32LE(start + 8) !== 48_000 ||
          wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) {
        throw new Error("WAV must be mono 24-kHz PCM16 audio.");
      }
      format = true;
    }
    if (type === "data") {
      if (pcm || !size || size % 2) throw new Error("Invalid WAV sample data.");
      pcm = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!format || !pcm) throw new Error("WAV format or sample data missing.");
  return pcm;
}

export class StreamingNarrations {
  constructor({ spoolDir = process.env.STREAM_SPOOL_DIR, synthesizeChunk, ffmpegPath = "ffmpeg", maxAudioBytes = 64_000_000,
    generationMs = 1_200_000, retentionMs = 21_600_000, disconnectMs = 120_000, maxSessions = 4 }) {
    for (const [key, value] of Object.entries({ maxAudioBytes, generationMs, retentionMs, disconnectMs, maxSessions })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > (key === "maxSessions" ? 100 : key === "maxAudioBytes" ? 1_000_000_000 : 604_800_000)) {
        throw new Error(`${key} must be a positive bounded integer.`);
      }
    }
    this.defaultSpool = !spoolDir;
    this.spoolRoot = join(tmpdir(), "reader-streaming");
    spoolDir = resolve(spoolDir || join(this.spoolRoot, `instance-${process.pid}-${randomUUID()}`));
    Object.assign(this, { spoolDir, synthesizeChunk, ffmpegPath, maxAudioBytes, generationMs, retentionMs, disconnectMs, maxSessions });
    this.sessions = new Map();
    this.creating = false;
    this.spoolReady = null;
    this.closed = false;
  }

  async create(body) {
    if (this.closed) throw Object.assign(new Error("Narration server is shutting down."), { status: 503 });
    if (this.creating || [...this.sessions.values()].some(s => !terminal(s.state))) {
      throw Object.assign(new Error("Another narration is generating. Stop it or wait for completion."), { status: 429 });
    }
    this.creating = true;
    try { return await (this.creation = this.createSession(body)); }
    finally { this.creating = false; }
  }

  async prepareSpool() {
    if (this.defaultSpool) {
      await mkdir(this.spoolRoot, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(this.spoolRoot, { withFileTypes: true })) {
        const match = /^instance-(\d+)-[0-9a-f-]{36}$/.exec(entry.name);
        if (entry.isDirectory() && match && !this.processAlive(Number(match[1]))) {
          await rm(join(this.spoolRoot, entry.name), { recursive: true, force: true });
          await rm(join(this.spoolRoot, `${entry.name}.lock`), { force: true });
        }
      }
    }
    await mkdir(this.spoolDir, { recursive: true, mode: 0o700 });
    this.lockPath = join(this.spoolDir, ".reader-instance.lock");
    try {
      this.lock = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(await readFile(this.lockPath, "utf8"));
      if (!Number.isSafeInteger(owner) || owner < 1 || this.processAlive(owner)) throw new Error("Streaming spool is already owned by another app instance.");
      await rm(this.lockPath);
      this.lock = await open(this.lockPath, "wx", 0o600);
    }
    await this.lock.writeFile(String(process.pid));
    // The spool is exclusive to this instance. No sessions survive a process restart.
    for (const entry of await readdir(this.spoolDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^session-[A-Za-z0-9]{6}$/.test(entry.name)) {
        await rm(join(this.spoolDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  processAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
  }

  async createSession({ text, voice, speed, title = "", byline = "", sourceUrl = "", paceSeconds = 0 }) {
    const chunks = chunkText(text);
    if (!chunks.length) throw Object.assign(new Error("Narration requires at least one letter or number."), { status: 400 });
    await (this.spoolReady ??= this.prepareSpool());
    if (this.closed) throw Object.assign(new Error("Narration server is shutting down."), { status: 503 });
    if (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.values()].find(s => !s.consumers && terminal(s.state));
      if (!oldest) throw Object.assign(new Error("Streaming session capacity reached."), { status: 429 });
      await this.stop(oldest);
      this.sessions.delete(oldest.id);
    }
    const directory = await mkdtemp(join(this.spoolDir, "session-"));
    const path = join(directory, "audio.mp3");
    const file = await open(path, "wx", 0o600);
    await file.close();
    const session = { id: randomUUID(), directory, path, voice, speed, paceSeconds, text, title, byline, sourceUrl,
      chunks, controller: new AbortController(), state: "generating", warming: false,
      generated: 0, bytes: 0, audioSecondsGenerated: 0, startedAt: Date.now(), consumers: 0, firstByteSeconds: null,
      subscribers: new Set() };
    this.sessions.set(session.id, session);
    session.generationDeadline = Date.now() + this.generationMs;
    session.generationTimer = setTimeout(() => {
      session.error = "Narration generation timed out.";
      session.text = null;
      session.chunks.fill("");
      session.controller.abort(new Error(session.error));
      session.encoder?.kill("SIGKILL");
    }, this.generationMs);
    session.generationTimer.unref();
    this.armDisconnect(session);
    session.done = this.generate(session);
    return session;
  }

  snapshot(session) {
    return { id: session.id, state: session.state, warming: session.warming, generated: session.generated,
      total: session.chunks.length, bytes: session.bytes, audioSecondsGenerated: session.audioSecondsGenerated,
      firstByteSeconds: session.firstByteSeconds, elapsedSeconds: (Date.now() - session.startedAt) / 1000,
      consumers: session.consumers, error: session.error, mark: session.mark,
      voice: session.voice, speed: session.speed, title: session.title,
      generationDeadline: session.state === "generating" ? session.generationDeadline : null,
      expiresAt: session.expiresAt ?? null,
      generatedAfterMark: session.mark ? session.generated - session.mark.generated : null };
  }

  publish(session, { coalesce = false } = {}) {
    if (coalesce) {
      if (!session.subscribers.size || session.statusTimer) return;
      // Keep only one pending update, and snapshot the latest counters when it fires.
      session.statusTimer = setTimeout(() => {
        session.statusTimer = null;
        this.publish(session);
      }, 250);
      session.statusTimer.unref();
      return;
    }
    // Meaningful changes (including terminal states) flush pending counters immediately.
    clearTimeout(session.statusTimer);
    session.statusTimer = null;
    if (!session.subscribers.size) return;
    const snapshot = this.snapshot(session);
    for (const send of session.subscribers) send(snapshot);
  }

  events(session, response) {
    if (session.subscribers.size >= 4) {
      throw Object.assign(new Error("Too many status connections for this recording."), { status: 429 });
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
    response.flushHeaders();
    let heartbeat;
    const cleanup = () => {
      clearInterval(heartbeat);
      session.subscribers.delete(send);
      response.off("close", cleanup);
    };
    // A slow observer must not queue unbounded snapshots or block synthesis/audio.
    const write = data => {
      if (response.destroyed || response.writableEnded || !response.write(data)) {
        cleanup();
        response.destroy();
        return false;
      }
      return true;
    };
    const send = snapshot => {
      if (write(`event: status\ndata: ${JSON.stringify(snapshot)}\n\n`) && terminal(snapshot.state)) {
        cleanup();
        response.end();
      }
    };
    response.on("close", cleanup);
    session.subscribers.add(send);
    heartbeat = setInterval(() => write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    // No replay log is needed: every connection starts with the current state.
    send(this.snapshot(session));
  }

  armDisconnect(session) {
    clearTimeout(session.disconnectTimer);
    if (!session.consumers && !terminal(session.state)) {
      session.disconnectTimer = setTimeout(() => {
        if (!session.consumers && !terminal(session.state)) void this.stop(session);
      }, this.disconnectMs);
      session.disconnectTimer.unref();
    }
  }

  async collectOutput(session, encoder) {
    const file = await open(session.path, "r+");
    try {
      for await (const bytes of encoder.stdout) {
        if (session.bytes + bytes.length > this.maxAudioBytes) throw new Error("Generated audio exceeded the disk limit.");
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, session.bytes);
          if (!bytesWritten) throw new Error("Could not write generated audio.");
          offset += bytesWritten;
          session.bytes += bytesWritten;
        }
        const first = session.firstByteSeconds === null;
        if (first) session.firstByteSeconds = (Date.now() - session.startedAt) / 1000;
        this.publish(session, { coalesce: !first });
      }
    } finally { await file.close(); }
  }

  async generate(session) {
    const signal = session.controller.signal;
    let encoder;
    let output;
    let exited;
    try {
      encoder = spawn(this.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "24000", "-ac", "1",
        "-probesize", "32", "-analyzeduration", "1", "-i", "pipe:0",
        ...(session.speed === 1 ? [] : ["-af", `atempo=${session.speed}`]),
        "-c:a", "libmp3lame", "-b:a", "64k", "-write_xing", "0", "-id3v2_version", "0",
        "-flush_packets", "1", "-f", "mp3", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
      session.encoder = encoder;
      encoder.stdin.on("error", () => {}); // Write callbacks below report EPIPE; never crash the Node process.
      exited = new Promise((resolve, reject) => { encoder.once("close", resolve); encoder.once("error", reject); });
      exited.catch(() => {});
      await once(encoder, "spawn");
      signal.throwIfAborted();
      output = this.collectOutput(session, encoder);
      output.catch(error => { session.outputError = error; session.controller.abort(); encoder.kill("SIGKILL"); });
      for (const text of session.chunks) {
        if (session.generated && session.paceSeconds) await delay(session.paceSeconds * 1000, undefined, { signal });
        signal.throwIfAborted();
        const wav = await this.synthesizeChunk({ text, voice: session.voice, speed: 1 }, signal,
          warming => {
            if (session.warming !== warming) { session.warming = warming; this.publish(session); }
          });
        signal.throwIfAborted();
        const pcm = pcmFromWav(wav);
        await new Promise((resolve, reject) => encoder.stdin.write(pcm, error => error ? reject(error) : resolve()));
        session.generated++;
        session.audioSecondsGenerated += pcm.length / 48_000 / session.speed;
        this.publish(session);
      }
      encoder.stdin.end();
      const code = await exited;
      await output;
      signal.throwIfAborted();
      if (code !== 0 || !session.bytes) throw new Error("Audio encoder failed to produce a complete stream.");
      session.state = "ready";
      session.readyAt = Date.now();
      this.retain(session);
    } catch (error) {
      if (session.state !== "stopped") {
        session.state = "error";
        session.text = null;
        session.chunks.fill("");
        session.error ||= session.outputError?.message || (error.code === "ENOENT" ? "Audio encoder is unavailable." : error.message);
      }
    } finally {
      session.warming = false;
      clearTimeout(session.generationTimer);
      clearTimeout(session.disconnectTimer);
      encoder?.kill("SIGKILL");
      await Promise.allSettled([exited, output].filter(Boolean));
      if (session.state !== "ready") {
        session.text = null;
        await rm(session.directory, { recursive: true, force: true });
        if (session.state === "error") this.retain(session);
      }
      session.chunks.fill(""); // Only the bounded recovery snapshot retains ready-session text.
      this.publish(session);
    }
  }

  async stop(session) {
    clearTimeout(session.generationTimer);
    clearTimeout(session.retentionTimer);
    clearTimeout(session.disconnectTimer);
    session.expiresAt = null;
    session.text = null;
    session.chunks.fill("");
    session.state = "stopped";
    session.warming = false;
    this.publish(session);
    session.controller.abort();
    session.encoder?.kill("SIGKILL");
    await session.done;
    await rm(session.directory, { recursive: true, force: true });
  }

  retain(session) {
    session.expiresAt = Date.now() + this.retentionMs;
    session.retentionTimer = setTimeout(() => {
      void this.stop(session).then(() => this.sessions.delete(session.id)).catch(() => {});
    }, this.retentionMs);
    session.retentionTimer.unref();
  }

  close() {
    this.closed = true;
    return this.closePromise ??= (async () => {
      await this.creation?.catch(() => {});
      await Promise.all([...this.sessions.values()].map(session => this.stop(session)));
      this.sessions.clear();
      await this.lock?.close();
      if (this.lock) await rm(this.lockPath, { force: true });
      if (this.defaultSpool) await rm(this.spoolDir, { recursive: true, force: true });
    })();
  }

  async audio(session, request, response) {
    const controller = new AbortController();
    const signal = controller.signal;
    const disconnected = () => controller.abort();
    response.on("close", disconnected);
    session.consumers++;
    this.publish(session);
    clearTimeout(session.disconnectTimer);
    let file;
    try {
      while (!session.bytes && !terminal(session.state)) await delay(100, undefined, { signal });
      if (["stopped", "error"].includes(session.state)) {
        response.writeHead(session.state === "error" ? 502 : 410, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return response.end(JSON.stringify({ error: session.error || "Narration stopped." }));
      }
      let offset = 0;
      let end = Infinity;
      let status = 200;
      const headers = { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff" };
      if (session.state === "ready") {
        end = session.bytes;
        headers["Accept-Ranges"] = "bytes";
        if (request.headers.range) {
          const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
          if (!range || Number(range[1]) >= end || (range[2] && Number(range[2]) < Number(range[1]))) {
            response.writeHead(416, { ...headers, "Content-Range": `bytes */${end}` });
            return response.end();
          }
          offset = Number(range[1]);
          end = range[2] ? Math.min(end, Number(range[2]) + 1) : end;
          headers["Content-Range"] = `bytes ${offset}-${end - 1}/${session.bytes}`;
          status = 206;
        }
        headers["Content-Length"] = end - offset;
      } else if (request.headers.range && !/^bytes=0-$/.test(request.headers.range)) {
        response.writeHead(416, headers);
        return response.end();
      }
      file = await open(session.path, "r");
      response.writeHead(status, headers);
      response.flushHeaders();
      const buffer = Buffer.alloc(64 * 1024);
      while (!signal.aborted) {
        if (["error", "stopped"].includes(session.state)) { response.destroy(); break; }
        const available = Math.min(session.bytes, end) - offset;
        if (available > 0) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, available), offset);
          if (!bytesRead) throw new Error("Generated audio could not be read.");
          offset += bytesRead;
          // Copy before reusing the read buffer; a slow client must not corrupt queued frames.
          if (!response.write(Buffer.from(buffer.subarray(0, bytesRead)))) await once(response, "drain", { signal });
        } else if (session.state === "ready" || offset >= end) { response.end(); break; }
        else await delay(100, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) response.destroy(error);
    } finally {
      await file?.close();
      response.off("close", disconnected);
      session.consumers--;
      this.publish(session);
      this.armDisconnect(session);
    }
  }
}
