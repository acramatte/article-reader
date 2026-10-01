export class Narrator {
  constructor({ audioContext, synthesize, onUpdate = () => {}, targetSeconds = 45, now = () => performance.now() }) {
    this.context = audioContext;
    this.synthesize = synthesize;
    this.onUpdate = onUpdate;
    this.targetSeconds = targetSeconds;
    this.now = now;
    this.controller = new AbortController();
    this.sources = new Set();
    this.nextTime = this.context.currentTime;
    this.startedAt = now();
    this.generated = 0;
    this.completed = 0;
    this.total = 0;
    this.underruns = 0;
    this.paused = false;
    this.warming = false;
    this.state = "loading";
    this.firstAudioSeconds = null;
    this.timer = null;
  }

  get bufferedSeconds() { return Math.max(0, this.nextTime - this.context.currentTime); }

  update() {
    this.onUpdate({ state: this.state, paused: this.paused, warming: this.warming, bufferedSeconds: this.bufferedSeconds,
      generated: this.generated, completed: this.completed, total: this.total,
      firstAudioSeconds: this.firstAudioSeconds, underruns: this.underruns, error: this.error });
  }

  setWarming(warming) {
    if (this.controller.signal.aborted) return;
    this.warming = warming;
    this.update();
  }

  async start(loadChunks) {
    try {
      // Unlock audio in the original button gesture, before any network request.
      await this.context.resume();
      if (this.controller.signal.aborted) return;
      if (this.context.state !== "running") throw new Error("Audio is blocked. Tap Read again to enable playback.");
      const chunks = await loadChunks(this.controller.signal);
      if (this.controller.signal.aborted) return;
      if (!chunks.length) throw new Error("Enter some article text first.");
      this.total = chunks.length;
      this.state = "generating";
      this.timer = setInterval(() => this.update(), 250);
      this.update();
      for (const text of chunks) {
        // Pause also pauses production; at most one already-running request may finish.
        while (this.paused || this.bufferedSeconds >= this.targetSeconds) {
          await this.wait(100);
        }
        this.controller.signal.throwIfAborted();
        const wav = await this.synthesize(text, this.controller.signal, this.setWarming.bind(this));
        this.controller.signal.throwIfAborted();
        const buffer = await this.context.decodeAudioData(wav);
        this.controller.signal.throwIfAborted();
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) throw new Error("Kokoro returned empty audio.");
        this.schedule(buffer);
      }
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.error = error.message;
      await this.shutdown("error");
    }
  }

  wait(ms) {
    return new Promise((resolve, reject) => {
      const signal = this.controller.signal;
      signal.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  schedule(buffer) {
    const now = this.context.currentTime;
    if (this.generated > 0 && this.nextTime < now) this.underruns++;
    const startsAt = Math.max(this.nextTime, now + 0.05);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.sources.add(source);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      if (this.controller.signal.aborted) return;
      this.completed++;
      if (this.completed === this.total) void this.shutdown("finished");
      else this.update();
    };
    source.start(startsAt);
    this.nextTime = startsAt + buffer.duration;
    this.generated++;
    if (this.firstAudioSeconds === null) this.firstAudioSeconds = (this.now() - this.startedAt) / 1000 + startsAt - now;
    this.state = "playing";
    this.update();
  }

  async togglePause() {
    if (this.controller.signal.aborted) return;
    this.paused = !this.paused;
    try {
      if (this.paused) await this.context.suspend();
      else await this.context.resume();
      this.update();
    } catch (error) {
      if (!this.controller.signal.aborted) { this.error = error.message; await this.shutdown("error"); }
    }
  }

  async shutdown(state = "stopped") {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    clearInterval(this.timer);
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear();
    this.state = state;
    this.paused = false;
    this.warming = false;
    this.nextTime = this.context.currentTime;
    this.update();
    if (this.context.state !== "closed") await this.context.close();
  }
}
