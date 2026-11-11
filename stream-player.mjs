const validId = id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

// The player is in exactly one phase, and only the moves listed here happen:
//
//   loading → generating → playing ⇄ paused        playing → finished
//   loading or a connection drop → recovering → paused
//   any active phase → stopping → stopped, or → error
const TRANSITIONS = {
  loading: ["generating", "recovering", "stopping", "error"],
  generating: ["playing", "paused", "recovering", "finished", "stopping", "error"],
  playing: ["paused", "recovering", "finished", "stopping", "error"],
  paused: ["generating", "playing", "recovering", "finished", "stopping", "error"],
  recovering: ["paused", "stopping", "error"],
  stopping: ["stopped", "error"],
  stopped: [], finished: [], error: [], disposed: [],
};
// The recording is in use: its requests, status events and bookmark are live.
const ACTIVE = ["loading", "generating", "playing", "paused", "recovering"];
// Audio is sounding or about to; these are the phases Pause leaves and Resume returns to.
const PLAYABLE = ["generating", "playing"];
// Recovery steps in order, with the progress each one reports.
const RECOVERY_STEPS = { connecting: "connection", awaiting: "generation", attaching: "position", seeking: "position" };

// The native media element owns playback; SSE is diagnostics/recovery only.
export class StreamingPlayer {
  constructor({ audio, bookmarkReady, onUpdate, onRestore = () => {}, onTimeline = () => {}, fetchImpl = fetch,
    eventSource = url => new EventSource(url), now = () => performance.now() }) {
    Object.assign(this, { audio, onUpdate, onRestore, onTimeline, fetchImpl, eventSource, now });
    // Sentence [start, end] text offsets, and [start, end] recording seconds for those generated so far.
    this.sentences = [];
    this.timings = [];
    this.controller = new AbortController();
    this.statusRevision = 0;
    this.ready = bookmarkReady.then(bookmark => { this.bookmark = bookmark; });
    this.phase = "loading";
    this.resumeTo = null; // While paused: the phase Resume returns to.
    this.needsGesture = false; // While paused: autoplay was denied, so only a user gesture can resume.
    this.recovery = null; // While recovering: { step, target, seek }.
    this.recovered = false; // This player began from a bookmark instead of a new narration.
    this.retryAvailable = false;
    this.waiting = false;
    this.playRevision = 0;
    this.firstAudioSeconds = null;
    this.underruns = 0;
    this.timeOffset = 0; // Recording time at which the attached audio begins.
    this.startedAt = now();
    this.listeners = {
      playing: () => {
        if (this.phase !== "playing" && !this.enter("playing")) return;
        this.waiting = false;
        this.firstAudioSeconds ??= (this.now() - this.startedAt) / 1000;
        this.updateMediaSession();
        this.emit();
      },
      pause: () => {
        if (this.audio.ended) return;
        // The browser can pause media itself; recovery and the closed phases pause it on purpose.
        if (this.phase !== "paused" && !(PLAYABLE.includes(this.phase) && this.enter("paused"))) return;
        this.savePosition(true);
        this.updateMediaSession();
        this.emit();
      },
      waiting: () => {
        if (!this.waiting && this.phase === "playing" && this.firstAudioSeconds !== null) this.underruns++;
        this.waiting = true;
        this.emit();
      },
      timeupdate: () => { this.savePosition(); this.updateMediaSession(); this.emit(); },
      progress: () => { this.restorePosition(); this.emit(); },
      loadedmetadata: () => this.restorePosition(),
      durationchange: () => this.restorePosition(),
      seeked: () => { this.restorePosition(); this.savePosition(true); },
      ended: () => void this.finish(),
      error: async () => {
        if (!this.active || !this.audio.error) return;
        const code = this.audio.error.code;
        // Audio attached by a recovery failed as well: keep its target and attach again.
        if (this.recovery) this.recovery.step = "connecting";
        await this.refresh(); // Prefer the provider's explicit error over a truncated-stream media error.
        if (!this.active || !this.audio.error) return;
        if (!this.recovery) {
          if (code !== 2) return this.fail(`Audio playback failed (code ${code}).`, true);
          // Network failures retain the bookmark; a completed file can be recovered.
          this.savePosition(true);
          this.enter("recovering", { target: this.position() });
        }
        this.warning = "Audio connection failed. Retry to recover the existing recording.";
        this.retryAvailable = true;
        this.audio.pause();
        this.emit();
      },
    };
    for (const [name, listener] of Object.entries(this.listeners)) audio.addEventListener(name, listener);
  }

  get active() { return ACTIVE.includes(this.phase); }
  get paused() { return this.phase === "paused" || this.phase === "recovering"; }
  // The reported state keeps "generating"/"playing" across a pause, alongside `paused`.
  get state() { return this.phase === "paused" ? this.resumeTo : this.phase; }

  // The only place the phase changes. A move the table does not allow changes nothing and returns false.
  enter(next, { target, needsGesture = false } = {}) {
    const from = this.phase;
    if (next !== "disposed" && !TRANSITIONS[from].includes(next)) return false;
    this.phase = next;
    // Data owned by one phase is built on entry and dropped on exit, so it cannot outlive that phase.
    this.resumeTo = next === "paused" ? (PLAYABLE.includes(from) ? from : "playing") : null;
    this.needsGesture = next === "paused" && needsGesture;
    this.recovery = next === "recovering" ? { step: "connecting", target, seek: null } : null;
    if (ACTIVE.includes(from) && !this.active) {
      this.controller.abort();
      this.closeStatus();
      this.warning = null;
      this.retryAvailable = false;
    }
    return true;
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
    if (this.phase === "disposed") return;
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
      warming: Boolean(this.snapshot?.warming && this.firstAudioSeconds === null && this.active),
      error: this.error, warning: this.warning || this.bookmark?.warning,
      recovering: this.phase === "recovering", recovered: this.recovered, recoveryPhase: RECOVERY_STEPS[this.recovery?.step],
      positionSeconds: this.position(), retryAvailable: this.retryAvailable, needsGesture: this.needsGesture,
    });
  }

  async start(prepare) {
    try {
      await this.ready;
      if (!this.active) return;
      this.bookmark.clear();
      const content = await prepare(this.controller.signal);
      if (!this.enter("generating")) return;
      this.title = content.title || "Pasted text";
      this.emit();
      // Do not abort admission on Stop: we need its acknowledged ID to cancel it.
      this.pendingCreation = this.json("/api/streaming", { method: "POST", body: content, admission: true });
      const result = await this.pendingCreation;
      if (!this.active) return;
      if (!validId(result.id)) throw new Error("The server returned an invalid recording identifier.");
      this.id = result.id;
      this.setTimeline(result.sentences);
      this.savePosition(true);
      this.audio.preload = "auto";
      this.audio.src = `/api/streaming/${this.id}/audio`;
      this.bindMediaSession();
      this.connectStatus();
      if (this.phase === "generating") await this.play(); // Not when Pause arrived before the admission did.
    } catch (error) {
      if (this.active) this.fail(error.message);
    }
  }

  async restore() {
    await this.ready;
    if (this.phase !== "loading") return false;
    const record = this.bookmark.load();
    if (!record) return false;
    this.id = record.id;
    this.title = record.title;
    this.recovered = true;
    this.enter("recovering", { target: record.positionSeconds });
    this.emit();
    this.connectStatus();
    await this.refresh();
    return true;
  }

  connectStatus() {
    if (this.events || !this.id || !this.active || ["ready", "error", "stopped"].includes(this.snapshot?.state)) return;
    const events = this.events = this.eventSource(`/api/streaming/${this.id}/events`);
    // Leaving the active phases closes the connection, so a stale source never matches.
    events.addEventListener("timing", event => {
      if (this.events !== events) return;
      const { from, timings } = JSON.parse(event.data);
      this.setTimeline(undefined, timings, from);
    });
    events.addEventListener("status", event => {
      if (this.events !== events) return;
      this.snapshotTask = this.applySnapshot(JSON.parse(event.data));
    });
    events.onerror = () => {
      if (this.events !== events) return;
      this.warning = "Status connection interrupted. Reconnecting; the playback bookmark is retained.";
      this.retryAvailable = this.phase === "recovering";
      this.emit();
      // Native EventSource retries transport errors. A permanent HTTP rejection
      // closes it; inspect the JSON endpoint once for an actionable expiry/error.
      if (events.readyState === 2) { this.closeStatus(); void this.refresh({ reconnect: false }); }
    };
  }

  setTimeline(sentences, timings = [], from = 0) {
    if (Array.isArray(sentences)) this.sentences = sentences;
    if (Array.isArray(timings)) timings.forEach((timing, i) => { this.timings[from + i] = timing; });
    this.onTimeline();
  }

  closeStatus() {
    this.events?.close();
    this.events = null;
  }

  async refresh({ reconnect = true } = {}) {
    if (!this.id || !this.active) return;
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = this.fetchStatus(reconnect);
    try { await this.refreshTask; }
    finally { this.refreshTask = null; }
  }

  async fetchStatus(reconnect) {
    const revision = this.statusRevision;
    try {
      const snapshot = await this.json(`/api/streaming/${this.id}/status`);
      if (!this.active) return;
      // A delayed GET must not overwrite a newer event (especially ready/error).
      if (revision !== this.statusRevision) return await this.snapshotTask;
      await this.applySnapshot(snapshot);
      if (reconnect) this.connectStatus();
      else if (this.active && snapshot.state === "generating") {
        this.warning = "Status connection closed. Retry to reconnect; audio playback can continue.";
        this.retryAvailable = true;
        this.emit();
      }
    } catch (error) {
      if (revision === this.statusRevision) this.statusFailure(error);
    }
  }

  async applySnapshot(snapshot) {
    if (!this.active) return;
    this.statusRevision++;
    try {
      this.snapshot = snapshot;
      if (["ready", "error", "stopped"].includes(snapshot.state)) this.closeStatus();
      if (["error", "stopped"].includes(snapshot.state)) return this.fail(snapshot.error || "Recording was stopped. Start a new narration explicitly.");
      this.warning = null;
      this.retryAvailable = false;
      if (this.recovery && !this.contentRestored) {
        const content = await (this.contentTask ??= this.json(`/api/streaming/${this.id}/content`));
        if (!this.active) return;
        if (!this.contentRestored) {
          this.onRestore(content);
          this.contentRestored = true;
          this.setTimeline(content.sentences, content.timings);
        }
      }
      const recovery = this.recovery; // A concurrent snapshot may have finished the recovery meanwhile.
      if (recovery?.step === "connecting" || recovery?.step === "awaiting") {
        const complete = this.snapshot.state === "ready";
        if (complete || this.snapshot.audioSecondsGenerated >= recovery.target) {
          // A growing MP3 has no known length, so seeking into it downloads the whole prefix.
          // Start the same recording at the saved position instead; completed files seek by Range.
          this.timeOffset = complete ? 0 : recovery.target;
          recovery.seek = complete ? null : 0;
          recovery.step = "attaching";
          this.audio.preload = "auto";
          this.audio.src = `/api/streaming/${this.id}/audio${this.timeOffset ? `?start=${this.timeOffset.toFixed(3)}` : ""}`;
          this.bindMediaSession();
          this.audio.load();
        } else recovery.step = "awaiting";
      }
      this.restorePosition();
      // SSE closes on readiness, and a status GET can report it before the final timing events arrived.
      if (this.snapshot.state === "ready" && this.snapshot.timed > this.timings.length) {
        const { timings } = await (this.timingTask ??= this.json(`/api/streaming/${this.id}/content`)
          .finally(() => { this.timingTask = null; }));
        if (!this.active) return;
        this.setTimeline(undefined, timings);
      }
      this.emit();
    } catch (error) {
      this.contentTask = null;
      this.statusFailure(error);
    }
  }

  statusFailure(error) {
    if (!this.active) return;
    if (error.status === 404) return this.fail("Recording expired or the server restarted. Start a new narration explicitly.");
    this.warning = `Could not reconnect: ${error.message}. The playback bookmark is retained.`;
    this.retryAvailable = this.phase === "recovering";
    this.emit();
  }

  // Recovery's last steps, driven by media events: the attached audio loads, seeks, then waits for Resume.
  restorePosition() {
    const recovery = this.recovery;
    if (!recovery || this.audio.readyState < 1) return;
    if (recovery.step === "attaching") {
      if (recovery.seek === null) {
        // Growing MP3 duration can be Infinity or an estimate of its current prefix.
        // Only a completed recording has a final duration to clamp against.
        if (!Number.isFinite(this.audio.duration)) return;
        recovery.seek = Math.min(recovery.target, Math.max(0, this.audio.duration - 0.05));
      }
      recovery.step = "seeking";
      if (Math.abs(this.audio.currentTime - recovery.seek) >= 0.05) {
        this.audio.currentTime = recovery.seek;
        return;
      }
    }
    if (recovery.step !== "seeking" || this.audio.seeking || Math.abs(this.audio.currentTime - recovery.seek) > 0.5) return;
    this.enter("paused");
    this.waiting = false;
    this.savePosition(true);
    this.emit();
  }

  savePosition(force = false) {
    // Recovery keeps the bookmark it is restoring until the position is reached.
    if (!this.bookmark || !this.id || !this.active || this.recovery) return;
    this.bookmark.save({ id: this.id, title: this.title.slice(0, 200), positionSeconds: this.position() }, force);
  }

  position() {
    return this.timeOffset + this.audio.currentTime;
  }

  async play() {
    if (this.phase === "paused") this.enter(this.resumeTo);
    else if (!PLAYABLE.includes(this.phase)) return;
    const version = ++this.playRevision;
    // A rejection only matters while this request is still the one meant to be playing.
    const wanted = () => version === this.playRevision && PLAYABLE.includes(this.phase);
    this.emit();
    try { await this.audio.play(); }
    catch (error) {
      if (!wanted()) return;
      if (error.name === "NotAllowedError") { this.enter("paused", { needsGesture: true }); this.emit(); }
      else {
        await this.refresh(); // An HTTP/provider error can reject play before its status reply arrives.
        if (wanted()) this.fail(error.message, true);
      }
    }
  }

  async togglePause() {
    if (this.phase === "paused") return this.play();
    if (!PLAYABLE.includes(this.phase)) return;
    this.enter("paused");
    this.audio.pause();
    this.savePosition(true);
    this.updateMediaSession();
    this.emit();
  }

  async finish() {
    await this.refresh();
    if (!this.active) return;
    if (this.snapshot?.state !== "ready") return this.fail("Recording ended before synthesis completed.", true);
    if (!this.enter("finished")) return;
    this.bookmark.clear();
    this.updateMediaSession();
    this.emit();
  }

  fail(message, cancel = false) {
    if (!this.active) return;
    this.error = message;
    // A recording the server may still be generating is cancelled first; the error is final once that settles.
    this.enter(cancel && this.id ? "stopping" : "error");
    this.bookmark?.clear();
    this.audio.pause();
    this.updateMediaSession();
    this.emit();
    if (this.phase !== "stopping") return;
    void this.json(`/api/streaming/${this.id}/stop`, { method: "POST", body: {}, admission: true })
      .catch(error => { this.warning = `Could not confirm cancellation: ${error.message}`; })
      .finally(() => { this.enter("error"); this.updateMediaSession(); this.emit(); });
  }

  async shutdown() {
    if (!this.enter("stopping")) return;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.emit();
    try {
      await this.ready;
      this.bookmark.clear();
      const session = this.id ? { id: this.id } : await this.pendingCreation;
      if (session && validId(session.id)) await this.json(`/api/streaming/${session.id}/stop`, { method: "POST", body: {}, admission: true });
      this.enter("stopped");
    } catch (error) {
      this.error = `Could not confirm cancellation: ${error.message}`;
      this.enter("error");
    } finally { this.updateMediaSession(); this.emit(); }
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
    navigator.mediaSession.playbackState = !this.active ? "none" : this.paused ? "paused" : "playing";
    if (!this.recovery && Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration: this.timeOffset + this.audio.duration, playbackRate: this.audio.playbackRate, position: this.timeOffset + Math.min(this.audio.currentTime, this.audio.duration) }); }
      catch { /* Some browsers do not implement position state. */ }
    }
  }

  dispose() {
    if (this.phase === "disposed") return this.disposal;
    this.savePosition(true);
    const stopping = this.phase === "stopping";
    this.enter("disposed");
    for (const [name, listener] of Object.entries(this.listeners)) this.audio.removeEventListener(name, listener);
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    // An unacknowledged admission has no bookmark to recover. Cancel only that orphan;
    // acknowledged recordings remain recoverable after local player disposal.
    if (this.pendingCreation && !this.id && !stopping) {
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
