const validId = id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

// The native media element owns playback; polling is diagnostics/recovery only.
export class StreamingPlayer {
  constructor({ audio, bookmarkReady, onUpdate, onRestore = () => {}, fetchImpl = fetch, now = () => performance.now(), pollMs = 1000 }) {
    Object.assign(this, { audio, onUpdate, onRestore, fetchImpl, now, pollMs });
    this.controller = new AbortController();
    this.ready = bookmarkReady.then(bookmark => { this.bookmark = bookmark; });
    this.state = "loading";
    this.paused = false;
    this.restoring = false;
    this.recovered = false;
    this.disposed = false;
    this.stopping = false;
    this.waiting = false;
    this.playRevision = 0;
    this.firstAudioSeconds = null;
    this.underruns = 0;
    this.startedAt = now();
    this.listeners = {
      playing: () => {
        if (this.restoring || this.stopping || this.disposed || ["error", "stopped", "finished"].includes(this.state)) return;
        this.paused = this.waiting = this.needsGesture = false;
        this.state = "playing";
        this.firstAudioSeconds ??= (this.now() - this.startedAt) / 1000;
        this.updateMediaSession();
        this.emit();
      },
      pause: () => {
        if (this.stopping || this.disposed || this.audio.ended || ["error", "stopped", "finished"].includes(this.state)) return;
        this.paused = true;
        this.savePosition(true);
        this.updateMediaSession();
        this.emit();
      },
      waiting: () => {
        if (!this.waiting && this.firstAudioSeconds !== null && !this.paused) this.underruns++;
        this.waiting = true;
        this.emit();
      },
      timeupdate: () => { this.savePosition(); this.updateMediaSession(); this.emit(); },
      progress: () => this.emit(),
      loadedmetadata: () => this.restorePosition(),
      durationchange: () => this.restorePosition(),
      seeked: () => { this.restorePosition(); this.savePosition(true); },
      ended: () => void this.finish(),
      error: async () => {
        if (this.stopping || this.disposed || !this.audio.error) return;
        const code = this.audio.error.code;
        await this.refresh(); // Prefer the provider's explicit error over a truncated-stream media error.
        if (this.controller.signal.aborted || this.stopping || this.disposed || !this.audio.error) return;
        // Network failures retain the bookmark; a completed file can be recovered.
        if (code === 2 || this.restoring) {
          this.savePosition(true);
          this.restoring = true;
          this.recovery ??= { id: this.id, title: this.title, positionSeconds: this.audio.currentTime };
          this.recoveryPhase = "connection";
          this.warning = "Audio connection failed. Retry to recover the existing recording.";
          this.retryAvailable = true;
          this.audio.pause();
          this.emit();
        } else this.fail(`Audio playback failed (code ${code}).`, true);
      },
    };
    for (const [name, listener] of Object.entries(this.listeners)) audio.addEventListener(name, listener);
  }

  async json(path, { method = "GET", body, admission = false } = {}) {
    const signal = admission ? AbortSignal.timeout(30_000) : AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]);
    const fetchRequest = this.fetchImpl;
    const response = await fetchRequest(path, {
      method, cache: "no-store", signal,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || `Request failed (HTTP ${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  emit() {
    if (this.disposed) return;
    let bufferedSeconds = 0;
    for (let i = 0; i < this.audio.buffered.length; i++) {
      if (this.audio.buffered.start(i) <= this.audio.currentTime + 0.05 && this.audio.buffered.end(i) >= this.audio.currentTime) {
        bufferedSeconds = this.audio.buffered.end(i) - this.audio.currentTime;
        break;
      }
    }
    this.onUpdate({
      state: this.state, paused: this.paused, bufferedSeconds: this.waiting ? 0 : bufferedSeconds,
      completed: this.snapshot?.generated || 0, total: this.snapshot?.total || 0,
      firstAudioSeconds: this.firstAudioSeconds, underruns: this.underruns,
      warming: Boolean(this.snapshot?.warming && this.firstAudioSeconds === null && !this.controller.signal.aborted),
      error: this.error, warning: this.warning || this.bookmark?.warning,
      recovering: this.restoring, recovered: this.recovered, recoveryPhase: this.recoveryPhase,
      positionSeconds: this.audio.currentTime, retryAvailable: Boolean(this.retryAvailable), needsGesture: this.needsGesture,
    });
  }

  async start(prepare) {
    try {
      await this.ready;
      this.controller.signal.throwIfAborted();
      this.bookmark.clear();
      const content = await prepare(this.controller.signal);
      this.controller.signal.throwIfAborted();
      this.title = content.title || "Pasted text";
      this.state = "generating";
      this.emit();
      // Do not abort admission on Stop: we need its acknowledged ID to cancel it.
      this.pendingCreation = this.json("/api/streaming", { method: "POST", body: content, admission: true });
      const result = await this.pendingCreation;
      if (this.controller.signal.aborted) return;
      if (!validId(result.id)) throw new Error("The server returned an invalid recording identifier.");
      this.id = result.id;
      this.savePosition(true);
      this.audio.preload = "auto";
      this.audio.src = `/api/streaming/${this.id}/audio`;
      this.bindMediaSession();
      this.poll = setInterval(() => void this.refresh(), this.pollMs);
      void this.refresh();
      if (!this.paused) await this.play();
    } catch (error) {
      if (!this.controller.signal.aborted) this.fail(error.message);
    }
  }

  async restore() {
    await this.ready;
    if (this.controller.signal.aborted) return false;
    const record = this.bookmark.load();
    if (!record) return false;
    this.id = record.id;
    this.title = record.title;
    this.recovery = record;
    this.paused = this.restoring = this.recovered = true;
    this.state = "restoring";
    this.recoveryPhase = "connection";
    this.emit();
    this.poll = setInterval(() => void this.refresh(), this.pollMs);
    await this.refresh();
    return true;
  }

  async refresh() {
    if (!this.id || this.stopping || this.disposed) return;
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = this.fetchStatus();
    try { await this.refreshTask; }
    finally { this.refreshTask = null; }
  }

  async fetchStatus() {
    try {
      const snapshot = await this.json(`/api/streaming/${this.id}/status`);
      if (this.controller.signal.aborted) return;
      this.snapshot = snapshot;
      if (["error", "stopped"].includes(snapshot.state)) return this.fail(snapshot.error || "Recording was stopped. Start a new narration explicitly.");
      this.warning = null;
      this.retryAvailable = false;
      if (this.restoring) {
        if (!this.contentRestored) {
          const content = await this.json(`/api/streaming/${this.id}/content`);
          if (this.controller.signal.aborted) return;
          this.onRestore(content);
          this.contentRestored = true;
        }
        if (snapshot.state === "ready") {
          this.recoveryPhase = "position";
          if (!this.audio.getAttribute("src") || this.audio.error) {
            this.seekTarget = null;
            this.audio.preload = "auto";
            this.audio.src = `/api/streaming/${this.id}/audio`;
            this.bindMediaSession();
            this.audio.load();
          }
          this.restorePosition();
        } else this.recoveryPhase = "generation";
      }
      this.emit();
    } catch (error) {
      if (this.controller.signal.aborted) return;
      if (error.status === 404) return this.fail("Recording expired or the server restarted. Start a new narration explicitly.");
      this.warning = `Could not reconnect: ${error.message}. The playback bookmark is retained.`;
      this.retryAvailable = this.restoring;
      this.emit();
    }
  }

  restorePosition() {
    if (!this.restoring || this.stopping || this.disposed || this.snapshot?.state !== "ready" || !this.contentRestored || !Number.isFinite(this.audio.duration)) return;
    if (this.seekTarget == null) {
      this.seekTarget = Math.min(this.recovery.positionSeconds, Math.max(0, this.audio.duration - 0.05));
      if (Math.abs(this.audio.currentTime - this.seekTarget) >= 0.05) {
        this.audio.currentTime = this.seekTarget;
        return;
      }
    }
    if (this.audio.seeking || Math.abs(this.audio.currentTime - this.seekTarget) > 0.5) return;
    this.restoring = false;
    this.state = "playing";
    this.waiting = false;
    this.savePosition(true);
    this.emit();
  }

  savePosition(force = false) {
    if (!this.bookmark || !this.id || this.restoring || this.stopping || this.disposed || ["finished", "error", "stopped"].includes(this.state)) return;
    this.bookmark.save({ id: this.id, title: this.title.slice(0, 200), positionSeconds: this.audio.currentTime }, force);
  }

  async play() {
    if (this.restoring || this.stopping || this.disposed || ["error", "stopped", "finished"].includes(this.state)) return;
    const version = ++this.playRevision;
    this.paused = false;
    this.needsGesture = false;
    this.emit();
    try { await this.audio.play(); }
    catch (error) {
      if (this.controller.signal.aborted || this.stopping || this.disposed || version !== this.playRevision) return;
      if (error.name === "NotAllowedError") { this.paused = this.needsGesture = true; this.emit(); }
      else {
        await this.refresh(); // An HTTP/provider error can reject play before its status reply arrives.
        if (!this.controller.signal.aborted && !this.stopping && !this.disposed && version === this.playRevision) this.fail(error.message, true);
      }
    }
  }

  async togglePause() {
    if (this.restoring || this.stopping || this.disposed || ["error", "stopped", "finished"].includes(this.state)) return;
    if (this.paused) await this.play();
    else { this.playRevision++; this.paused = true; this.audio.pause(); this.savePosition(true); this.updateMediaSession(); this.emit(); }
  }

  async finish() {
    await this.refresh();
    if (this.controller.signal.aborted || this.stopping || this.disposed || ["error", "stopped", "finished"].includes(this.state)) return;
    if (this.snapshot?.state !== "ready") return this.fail("Recording ended before synthesis completed.", true);
    this.state = "finished";
    this.paused = false;
    clearInterval(this.poll);
    this.bookmark.clear();
    this.updateMediaSession();
    this.emit();
  }

  fail(message, cancel = false) {
    if (this.stopping || this.disposed) return;
    this.state = "error";
    this.error = message;
    this.restoring = this.paused = false;
    this.controller.abort();
    clearInterval(this.poll);
    this.bookmark?.clear();
    this.audio.pause();
    this.updateMediaSession();
    this.emit();
    if (cancel && this.id) {
      this.stopping = true;
      this.state = "stopping";
      this.emit();
      void this.json(`/api/streaming/${this.id}/stop`, { method: "POST", body: {}, admission: true })
        .catch(error => { this.warning = `Could not confirm cancellation: ${error.message}`; })
        .finally(() => { this.stopping = false; this.state = "error"; this.updateMediaSession(); this.emit(); });
    }
  }

  async shutdown() {
    if (this.stopping || this.disposed) return;
    this.stopping = true;
    this.state = "stopping";
    this.paused = false;
    this.controller.abort();
    clearInterval(this.poll);
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.emit();
    try {
      await this.ready;
      this.bookmark.clear();
      const session = this.id ? { id: this.id } : await this.pendingCreation;
      if (session && validId(session.id)) await this.json(`/api/streaming/${session.id}/stop`, { method: "POST", body: {}, admission: true });
      this.state = "stopped";
    } catch (error) { this.state = "error"; this.error = `Could not confirm cancellation: ${error.message}`; }
    finally { this.stopping = false; this.updateMediaSession(); this.emit(); }
  }

  bindMediaSession() {
    if (!("mediaSession" in navigator)) return;
    if (typeof MediaMetadata !== "undefined") navigator.mediaSession.metadata = new MediaMetadata({ title: this.title, artist: "Article Reader" });
    for (const [action, handler] of [["play", () => void this.play()], ["pause", () => { if (!this.paused) void this.togglePause(); }]]) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Browser-dependent action support. */ }
    }
    this.updateMediaSession();
  }

  updateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = ["error", "stopped", "finished"].includes(this.state) ? "none" : this.paused ? "paused" : "playing";
    if (!this.restoring && Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration: this.audio.duration, playbackRate: this.audio.playbackRate, position: Math.min(this.audio.currentTime, this.audio.duration) }); }
      catch { /* Some browsers do not implement position state. */ }
    }
  }

  dispose() {
    if (this.disposed) return this.disposal;
    this.savePosition(true);
    this.disposed = true;
    this.controller.abort();
    clearInterval(this.poll);
    for (const [name, listener] of Object.entries(this.listeners)) this.audio.removeEventListener(name, listener);
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    // An unacknowledged admission has no bookmark to recover. Cancel only that orphan;
    // acknowledged recordings remain recoverable after local player disposal.
    if (this.pendingCreation && !this.id && !this.stopping) {
      this.disposal = this.pendingCreation.then(async session => {
        if (validId(session.id)) await this.json(`/api/streaming/${session.id}/stop`, { method: "POST", body: {}, admission: true });
      }).catch(error => { this.warning = `Could not confirm cancellation: ${error.message}`; });
    }
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      for (const action of ["play", "pause"]) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* Browser-dependent action support. */ }
      }
    }
    return this.disposal;
  }
}
