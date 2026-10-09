import { PlaybackBookmark } from "./streaming-state.js";
import { loadTtsSettings } from "./tts-settings.js";

const $ = selector => document.querySelector(selector);
const audio = $("#audio");
let id = null;
let snapshot = null;
let events = null;
let starting = false;
let settingsLoaded = false;
let startedAt = 0;
let firstPlaybackSeconds = null;
let message = "Loading voices…";
let extraction = null;
let requestController = null;
let pendingCreation = null;
let stopping = false;
let pageHides = 0;
let failures = [];
const bookmark = new PlaybackBookmark();
let narrationTitle = "Locked-screen narration test";
let recovery = null;
let restoring = false;
let seekTarget = null;
let restoredPositionSeconds = null;
let revision = 0;
const wasDiscarded = document.wasDiscarded === true;
const navigationType = performance.getEntriesByType("navigation")[0]?.type || "unknown";

function savePosition(force = false) {
  if (!id || restoring || stopping || ["stopped", "error"].includes(snapshot?.state)) return;
  bookmark.save({ id, title: narrationTitle, positionSeconds: audio.currentTime }, force);
}

function forgetRecovery(messageText) {
  revision++;
  bookmark.clear();
  closeStatus();
  id = null;
  snapshot = null;
  audio.removeAttribute("src");
  audio.load();
  audio.controls = true;
  recovery = null;
  restoring = false;
  message = messageText;
  render();
}

function finishRecovery() {
  restoredPositionSeconds = audio.currentTime;
  restoring = false;
  audio.controls = true;
  message = `Recording restored at ${audio.currentTime.toFixed(1)} seconds. Tap Resume saved recording.`;
  savePosition(true);
  render();
}

function restorePosition() {
  if (!restoring || !recovery || stopping || audio.readyState < 1) return;
  const complete = snapshot?.state === "ready";
  if (complete ? !Number.isFinite(audio.duration) : !(snapshot?.audioSecondsGenerated >= recovery.positionSeconds)) return;
  if (seekTarget === null) {
    seekTarget = complete
      ? Math.min(recovery.positionSeconds, Math.max(0, audio.duration - 0.05))
      : recovery.positionSeconds;
    if (Math.abs(audio.currentTime - seekTarget) < 0.05) return finishRecovery();
    audio.currentTime = seekTarget;
  } else if (!audio.seeking && Math.abs(audio.currentTime - seekTarget) < 0.5) finishRecovery();
}

function attachRecoveredAudio() {
  if (!restoring || (audio.getAttribute("src") && !audio.error)) return;
  audio.controls = false; // Prevent playback from zero before the saved seek completes.
  audio.preload = "auto";
  seekTarget = null;
  audio.src = `/api/streaming/${id}/audio`;
  mediaSession(narrationTitle);
  message = "Restoring the saved position…";
  audio.load();
}

function text(selector, value) {
  if ($(selector).textContent !== value) $(selector).textContent = value;
}

async function post(path, body, signal) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function render() {
  text("#status", message);
  const active = starting || stopping || (id && snapshot?.state !== "stopped" && snapshot?.state !== "error");
  $("#start").disabled = Boolean(active) || !settingsLoaded;
  $("#voice").disabled = !settingsLoaded;
  $("#stop").disabled = !active || stopping;
  $("#mark").disabled = !id || audio.paused || snapshot?.state === "stopped" || snapshot?.state === "error";
  $("#refresh").disabled = !id;
  $("#resume").hidden = !recovery;
  $("#resume").disabled = restoring || stopping || !id || !["generating", "ready"].includes(snapshot?.state) || !audio.paused;
  if (snapshot) {
    const playedBeyondMark = Boolean(snapshot.mark && audio.currentTime > snapshot.mark.audioSecondsGenerated + 0.2);
    text("#evidence", !snapshot.mark ? "When speech starts, mark the test and lock your phone."
      : `Chunks generated after mark: ${snapshot.generatedAfterMark}. Playback beyond the pre-mark generated audio: ${playedBeyondMark ? "yes" : "not yet"}.`);
    text("#report", JSON.stringify({ ...snapshot, playbackSeconds: audio.currentTime, paused: audio.paused,
      firstPlaybackSeconds, pageHides, playedBeyondMark, mediaSession: "mediaSession" in navigator,
      recovered: Boolean(recovery), restoredPositionSeconds, wasDiscarded, navigationType,
      recoveryStorageWarning: bookmark.warning,
      playbackErrors: failures, userAgent: navigator.userAgent }, null, 2));
  }
}

function closeStatus() {
  events?.close();
  events = null;
}

function applyStatus(result) {
  revision++;
  snapshot = result;
  if (["ready", "error", "stopped"].includes(snapshot.state)) closeStatus();
  if (snapshot.state === "error") { bookmark.clear(); restoring = false; recovery = null; message = `Generation failed: ${snapshot.error}`; }
  else if (snapshot.state === "stopped") {
    if (recovery) return forgetRecovery("Recording was stopped. Start a new narration explicitly.");
    message = "Stopped.";
  }
  else if (restoring) {
    attachRecoveredAudio();
    message = snapshot.state === "ready" || snapshot.audioSecondsGenerated >= recovery.positionSeconds
      ? "Restoring the saved position…" : "Recording is still generating. Waiting for audio at the saved position…";
    restorePosition();
  }
  else if (snapshot.warming) message = "Speech engine is waking up…";
  else if (!recovery && !firstPlaybackSeconds && audio.paused) message = "Preparing audio. If playback does not start, tap Play in the player.";
  render();
}

function connectStatus() {
  if (events || !id || stopping || ["ready", "error", "stopped"].includes(snapshot?.state)) return;
  const source = events = new EventSource(`/api/streaming/${id}/events`);
  source.addEventListener("status", event => {
    if (events === source && !stopping) applyStatus(JSON.parse(event.data));
  });
  source.onerror = () => {
    if (events !== source || stopping) return;
    message = "Status connection interrupted. Reconnecting; the bookmark is retained.";
    render();
    if (source.readyState === EventSource.CLOSED) { closeStatus(); void refresh({ reconnect: false }); }
  };
}

async function refresh({ reconnect = true } = {}) {
  if (!id) return;
  const current = id;
  const version = revision;
  try {
    const response = await fetch(`/api/streaming/${current}/status`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    const result = await response.json();
    if (id !== current || version !== revision || stopping) return;
    if (response.status === 404) return forgetRecovery("Recording expired or the server restarted. Start a new narration explicitly.");
    if (!response.ok) throw new Error(result.error);
    applyStatus(result);
    if (reconnect) connectStatus();
    else if (snapshot?.state === "generating") {
      message = "Status connection closed. Refresh report to reconnect; audio playback can continue.";
      render();
    }
  } catch (error) {
    if (id === current && version === revision && !stopping) { message = recovery ? `Could not reconnect: ${error.message}. Refresh report to retry; the bookmark is retained.` : error.message; render(); }
  }
}

function mediaSession(title) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist: "Article Reader" });
  for (const [action, handler] of [["play", () => { if (!restoring && !stopping) void audio.play().catch(playError); }], ["pause", () => audio.pause()]]) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Browser-dependent actions. */ }
  }
}

function playError(error) {
  if (requestController?.signal.aborted || stopping) return;
  failures.push(error.message);
  message = "Audio needs a tap: press Play in the player below.";
  render();
}

$("#form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!settingsLoaded || starting || (id && !["stopped", "error"].includes(snapshot?.state))) return;
  revision++;
  closeStatus();
  bookmark.clear();
  recovery = null;
  restoring = false;
  seekTarget = null;
  restoredPositionSeconds = null;
  audio.controls = true;
  audio.preload = "none";
  requestController = new AbortController();
  const signal = requestController.signal;
  starting = true;
  startedAt = performance.now();
  firstPlaybackSeconds = null;
  pageHides = 0;
  failures = [];
  snapshot = null;
  id = null;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  message = "Preparing streaming test…";
  render();
  try {
    let narrationText = $("#text").value;
    let title = "Locked-screen narration test";
    const url = $("#url").value.trim();
    if (url) {
      message = "Fetching and extracting article…"; render();
      extraction = await post("/api/article", { url }, signal);
      narrationText = extraction.text;
      title = extraction.title;
      $("#text").value = narrationText;
    }
    // Keep admission acknowledgement alive after Stop so its session can be cancelled explicitly.
    pendingCreation = post("/api/streaming", { text: narrationText, voice: $("#voice").value,
      speed: Number($("#speed").value), paceSeconds: $("#pace").checked ? 5 : 0 }, AbortSignal.timeout(30_000));
    const session = await pendingCreation;
    if (signal.aborted) return; // The Stop handler owns cancellation, including delayed admission.
    id = session.id;
    narrationTitle = title.slice(0, 200);
    starting = false;
    savePosition(true);
    audio.src = session.audioUrl;
    mediaSession(title);
    message = "Generating first audio…";
    render();
    connectStatus();
    await audio.play().catch(playError);
  } catch (error) {
    if (!signal.aborted) { message = error.message; starting = false; render(); }
  } finally { pendingCreation = null; }
});

$("#stop").addEventListener("click", async () => {
  if (stopping) return;
  revision++;
  stopping = true;
  bookmark.clear();
  recovery = null;
  restoring = false;
  audio.controls = true;
  requestController?.abort();
  message = "Stopping…";
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  closeStatus();
  render();
  try {
    const session = id ? { id } : await pendingCreation;
    if (session) {
      id = session.id;
      snapshot = await post(`/api/streaming/${id}/stop`, {});
    }
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
    message = "Stopped.";
  } catch (error) { message = `Could not confirm cancellation: ${error.message}`; }
  finally { starting = false; stopping = false; render(); }
});

$("#mark").addEventListener("click", async () => {
  try {
    snapshot = await post(`/api/streaming/${id}/mark`, { playbackSeconds: audio.currentTime });
    message = "Test marked. Lock the phone now and keep listening.";
    render();
  } catch (error) { message = error.message; render(); }
});
$("#refresh").addEventListener("click", refresh);
$("#resume").addEventListener("click", () => {
  if (!restoring && ["generating", "ready"].includes(snapshot?.state)) void audio.play().catch(playError);
});
for (const event of ["loadedmetadata", "durationchange", "seeked", "progress"]) audio.addEventListener(event, restorePosition);
audio.addEventListener("timeupdate", () => savePosition());
audio.addEventListener("seeked", () => savePosition(true));

for (const event of ["playing", "pause", "waiting", "ended", "error"]) {
  audio.addEventListener(event, () => {
    if (!id || stopping) return;
    if (restoring && event !== "error") return;
    if (event === "playing") {
      if (!recovery && firstPlaybackSeconds === null) firstPlaybackSeconds = (performance.now() - startedAt) / 1000;
      message = "Playing continuous MP3 audio.";
    } else if (event === "pause" && !audio.ended) message = "Paused. Preparation may continue.";
    else if (event === "waiting") message = "Buffering…";
    else if (event === "ended") { message = "Playback finished. Refresh the report to check generation status."; closeStatus(); }
    else if (event === "error") { message = `Media playback failed (code ${audio.error?.code}).`; failures.push(message); }
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
    savePosition(true);
    render();
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) { pageHides++; savePosition(true); }
  else void refresh();
});
window.addEventListener("pagehide", () => savePosition(true));
window.addEventListener("pageshow", event => { if (event.persisted) void refresh(); });

// Read-only inspection handle for browser/device acceptance, not a playback dependency.
window.streamingProbe = () => ({ id, snapshot, firstPlaybackSeconds, currentTime: audio.currentTime,
  paused: audio.paused, readyState: audio.readyState, pageHides, failures,
  recovered: Boolean(recovery), restoring, restoredPositionSeconds, wasDiscarded, navigationType });
void loadTtsSettings($("#voice")).then(tts => {
  settingsLoaded = true;
  text("#tts-engine", tts.name);
  recovery = bookmark.load();
  if (recovery) {
    id = recovery.id;
    narrationTitle = recovery.title;
    restoring = true;
    message = "Checking saved recording…";
    void refresh();
  } else message = bookmark.warning || "Ready to test.";
  render();
}).catch(error => { message = `${error.message} Reload to retry.`; render(); });
render();
