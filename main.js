import { StreamingPlayer } from "./stream-player.mjs";
import { PlaybackBookmark } from "./public/streaming-state.js";
import { loadTtsSettings } from "./public/tts-settings.js";

// Bundle the same validated bookmark used by the diagnostic player.
const bookmarkReady = Promise.resolve(new PlaybackBookmark());

const $ = (selector) => document.querySelector(selector);
const textArea = $("#text");
const status = $("#status");
const statusText = $("#status-text");
let narrator = null;
let active = false;
let settingsLoaded = false;
let source = "url";
let hasReadText = false;
let sessionHasText = false;
let pauseAnimations = [];

function renderSource() {
  // Keep the same URL input mounted and focusable throughout the reveal.
  if ($("#url").readOnly !== active) $("#url").readOnly = active;
  setDisabled($("#read-url"), active || !settingsLoaded);
  setDisabled($("#paste-fallback"), active);
  for (const id of ["#voice", "#speed"]) setDisabled($(id), active || !settingsLoaded);
  setDisabled($("#read-start"), active || !settingsLoaded || (source === "url" && !sessionHasText));
  setText($("#read-start"), hasReadText || source === "url" ? "Read again" : "Read text");
}

function revealWorkspace() {
  $("#workspace").hidden = false;
  $("#reader").classList.add("is-revealed");
}

function openFallback() {
  if (active) return;
  source = "text";
  $("#listening-card").hidden = false;
  revealWorkspace();
  $("#playback").hidden = false;
  $("#listen-title").hidden = false;
  $("#editor").open = true;
  $("#paste-fallback").setAttribute("aria-expanded", "true");
  if ($("#article-panel").hidden) setText($("#editor-summary"), "Paste article text");
  renderSource();
  textArea.focus({ preventScroll: true });
}

async function post(path, body, signal) {
  const response = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new Error(problem.error || `Request failed (HTTP ${response.status}). Is the app backend running?`);
  }
  return response;
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function setDisabled(element, disabled) {
  if (element.disabled !== disabled) element.disabled = disabled;
}

function showFeedback(message) {
  $("#listening-card").hidden = false;
  setText(statusText, message);
  for (const animation of pauseAnimations) animation.cancel();
  pauseAnimations = [];
  status.classList.remove("is-busy", "is-playing", "is-paused");
}

function playbackLabel(update) {
  if (update.recovering) {
    return { connection: "Reconnecting to your recording…", generation: "Recording is still generating. Waiting to restore the saved position…", position: "Restoring your saved position…" }[update.recoveryPhase];
  }
  if (update.needsGesture) return "Tap Resume to start audio.";
  if (update.recovered && update.paused && update.firstAudioSeconds === null) return "Saved recording ready. Press Resume.";
  if (update.paused) return "Paused";
  if (update.warming) return "Speech engine is waking up…";
  if (update.state === "playing" && update.bufferedSeconds < 0.05) return "Buffering…";
  return { loading: source === "url" ? "Fetching and extracting article…" : "Preparing narration…", generating: "Generating first audio…", playing: "Playing", stopping: "Stopping…", stopped: "Stopped", finished: "Finished", error: "Could not read article" }[update.state];
}

function render(update) {
  $("#listening-card").hidden = false;
  active = !["stopped", "finished", "error"].includes(update.state);
  if (!active && sessionHasText) source = "text";
  const hasPlayback = active || sessionHasText || source === "text";
  for (const id of ["#playback", "#listen-title"]) {
    if ($(id).hidden === hasPlayback) $(id).hidden = !hasPlayback;
  }
  if (!hasPlayback) $("#diagnostics").hidden = true;
  setDisabled(textArea, active);
  const extractionError = update.state === "error" && source === "url" && !sessionHasText && !update.recovered;
  if ($("#fallback-advice").hidden !== !extractionError) $("#fallback-advice").hidden = !extractionError;
  if ($("#paste-fallback").classList.contains("recommended") !== extractionError) $("#paste-fallback").classList.toggle("recommended", extractionError);
  renderSource();
  setDisabled($("#stop"), !active || update.state === "stopping");
  setDisabled($("#pause"), !active || ["loading", "stopping"].includes(update.state) || update.recovering);
  setText($("#pause"), update.paused ? "Resume" : "Pause");
  const state = playbackLabel(update);
  setText(statusText, update.error ? `${state}: ${update.error}` : state);
  $("#recovery-note").hidden = !update.warning;
  if (update.warning) setText($("#recovery-note"), update.warning);
  $("#reconnect").hidden = !update.retryAvailable;
  const busy = Boolean(active && (update.warming || ["loading", "generating"].includes(update.state)) && !update.paused && !update.error);
  if (status.classList.contains("is-busy") !== busy) status.classList.toggle("is-busy", busy);
  const playing = Boolean(active && update.state === "playing" && update.bufferedSeconds >= 0.05 && !busy && !update.paused && !update.error);
  const paused = Boolean(active && update.paused && !update.error);
  const pauseChanged = status.classList.contains("is-paused") !== paused;
  // Capture the visible frame before removing the playback CSS animations.
  const fallingBars = pauseChanged && paused && status.classList.contains("is-playing") && !matchMedia("(prefers-reduced-motion: reduce)").matches
    ? [...status.querySelectorAll(".status-equalizer span")].map((bar) => ({ bar, clip: getComputedStyle(bar).clipPath })) : [];
  if (pauseChanged) {
    for (const animation of pauseAnimations) animation.cancel();
    pauseAnimations = [];
  }
  if (status.classList.contains("is-playing") !== playing) status.classList.toggle("is-playing", playing);
  if (pauseChanged) status.classList.toggle("is-paused", paused);
  pauseAnimations = fallingBars.length ? fallingBars.map(({ bar, clip }) => bar.animate(
    [{ clipPath: clip }, { clipPath: "inset(12px 0px 0px)" }],
    { duration: 450, easing: "ease-out" },
  )) : pauseAnimations;
  setText($("#buffer"), `${update.bufferedSeconds.toFixed(1)} s`);
  setText($("#progress"), `${update.completed} / ${update.total}`);
  setText($("#first-audio"), update.firstAudioSeconds === null ? "—" : `${update.firstAudioSeconds.toFixed(2)} s`);
  setText($("#underruns"), String(update.underruns));
}

function read(fromUrl) {
  if (active || !settingsLoaded) return;
  const input = fromUrl ? $("#url").value.trim() : textArea.value.trim();
  if (!input) { showFeedback(fromUrl ? "Enter a webpage URL first." : "Enter some text first."); return; }
  if (!$("#narration-audio").canPlayType("audio/mpeg")) { showFeedback("This browser does not support MP3 audio playback."); return; }
  const voice = $("#voice").value;
  const speed = Number($("#speed").value);
  try {
    narrator?.dispose();
    const session = new StreamingPlayer({
      audio: $("#narration-audio"), bookmarkReady,
      onUpdate: (update) => { if (narrator === session) render(update); },
    });
    const trigger = document.activeElement;
    narrator = session;
    source = fromUrl ? "url" : "text";
    sessionHasText = !fromUrl;
    $("#playback").hidden = false;
    $("#listen-title").hidden = false;
    $("#diagnostics").hidden = false;
    if (sessionHasText) hasReadText = true;
    render({ state: "loading", paused: false, bufferedSeconds: 0, completed: 0, total: 0, firstAudioSeconds: null, underruns: 0 });
    if (trigger === $("#read-url") || trigger === $("#read-start")) $("#stop").focus({ preventScroll: true });
    void session.start(async (signal) => {
      let text = input;
      if (fromUrl) {
        const article = await (await post("/api/article", { url: input }, signal)).json();
        signal.throwIfAborted();
        $("#article-title").textContent = article.title;
        $("#byline").textContent = article.byline;
        $("#source").textContent = article.url;
        $("#source").href = article.url;
        textArea.value = text = article.text;
        sessionHasText = hasReadText = true;
        setText($("#article-body"), article.text);
        $("#article-panel").hidden = false;
        $("#editor").open = false;
        setText($("#editor-summary"), "Edit article text");
        $("#paste-fallback").setAttribute("aria-expanded", "false");
        revealWorkspace();
      }
      const hasArticle = !$("#article-panel").hidden;
      return { text, voice, speed, title: hasArticle ? $("#article-title").textContent.slice(0, 200) : "Pasted text",
        byline: hasArticle ? $("#byline").textContent.slice(0, 500) : "", ...(hasArticle ? { sourceUrl: $("#source").href } : {}) };
    });
  } catch (error) { showFeedback(error.message); }
}

const compactViewport = window.matchMedia("(max-width: 520px)");
const desktopUrlPlaceholder = $("#url").placeholder;
function updateUrlPlaceholder() {
  $("#url").placeholder = compactViewport.matches ? "Paste a link…" : desktopUrlPlaceholder;
}
compactViewport.addEventListener("change", updateUrlPlaceholder);
updateUrlPlaceholder();

$("#url-form").addEventListener("submit", (event) => { event.preventDefault(); read(true); });
$("#read-start").addEventListener("click", () => read(false));
$("#paste-fallback").addEventListener("click", openFallback);
$("#editor").addEventListener("toggle", () => {
  const expanded = String($("#editor").open);
  if ($("#paste-fallback").getAttribute("aria-expanded") !== expanded) $("#paste-fallback").setAttribute("aria-expanded", expanded);
});
textArea.addEventListener("input", () => {
  if (active) return;
  source = "text";
  if (!$("#article-panel").hidden) setText($("#article-body"), textArea.value);
  renderSource();
});
function updateSettingsSummary() {
  const selection = `${$("#voice").selectedOptions[0].textContent} · ${$("#speed").selectedOptions[0].textContent}`;
  setText($("#settings-summary"), selection);
  $("#voice-settings summary").setAttribute("aria-label", `Voice and speed: ${selection}`);
}
for (const id of ["#voice", "#speed"]) $(id).addEventListener("change", updateSettingsSummary);
renderSource();
$("#pause").addEventListener("click", () => void narrator?.togglePause());
$("#stop").addEventListener("click", async () => {
  await narrator?.shutdown();
  $(sessionHasText || source === "text" ? "#read-start" : "#read-url").focus({ preventScroll: true });
});
$("#reconnect").addEventListener("click", () => void narrator?.refresh());
// Leaving the page must not cancel server-owned synthesis or native playback.
window.addEventListener("pagehide", () => narrator?.savePosition(true));
document.addEventListener("visibilitychange", () => { if (document.hidden) narrator?.savePosition(true); });
window.addEventListener("pageshow", () => void narrator?.refresh());

const recovery = new StreamingPlayer({
  audio: $("#narration-audio"), bookmarkReady,
  onUpdate: update => { if (narrator === recovery) render(update); },
  onRestore: content => {
    if (narrator !== recovery) return;
    source = content.sourceUrl ? "url" : "text";
    sessionHasText = hasReadText = true;
    textArea.value = content.text;
    $("#voice").value = content.voice;
    $("#speed").value = String(content.speed);
    updateSettingsSummary();
    if (content.sourceUrl) {
      $("#url").value = content.sourceUrl;
      setText($("#article-title"), content.title);
      setText($("#byline"), content.byline);
      setText($("#source"), content.sourceUrl);
      $("#source").href = content.sourceUrl;
      setText($("#article-body"), content.text);
      $("#article-panel").hidden = false;
      setText($("#editor-summary"), "Edit article text");
    } else $("#editor").open = true;
    $("#diagnostics").hidden = false;
    revealWorkspace();
  },
});
narrator = recovery;
void loadTtsSettings($("#voice")).then(async () => {
  settingsLoaded = true;
  updateSettingsSummary();
  renderSource();
  // Recovery must set the saved voice only after its option exists.
  const restored = await recovery.restore();
  if (!restored && narrator === recovery && recovery.bookmark.warning) showFeedback(recovery.bookmark.warning);
}).catch(error => {
  if (narrator !== recovery) return;
  if (!settingsLoaded) {
    setText($("#settings-summary"), "Voices unavailable");
    $("#voice-settings summary").setAttribute("aria-label", "Voice and speed: voices unavailable");
  }
  showFeedback(`${error.message} Reload to retry.`);
});
