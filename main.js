import { StreamingPlayer } from "./stream-player.mjs";
import { NarrationHighlight } from "./narration-highlight.mjs";
import { controls, hasText, isActive, settle, status as playerStatus } from "./reader-mode.mjs";
import { PlaybackBookmark } from "./public/streaming-state.js";
import { loadTtsSettings } from "./public/tts-settings.js";

// Bundle the same validated bookmark used by the diagnostic player.
const bookmarkReady = Promise.resolve(new PlaybackBookmark());

const $ = (selector) => document.querySelector(selector);
const textArea = $("#text");
const status = $("#status");
const statusText = $("#status-text");
let narrator = null;
// The page's state lives here; the DOM is only written from it.
const reader = { mode: "landing", hasRead: false, ready: false };
let active = false; // The current narration has not ended.
let article = null; // Title, byline and URL of the extracted article the text came from; edits keep them.
let shown = null; // The text in the article panel, once it is visible.
let indicator = null;
let pauseAnimations = [];
const highlight = new NarrationHighlight({ container: $("#article-body"), audio: $("#narration-audio"),
  position: () => narrator?.position() ?? 0 });

// The article panel always shows exactly the narrated text: sentence offsets address its text node.
// Pasted text has no title, byline or source of its own.
function showNarratedText(text) {
  setText($("#article-title"), article ? article.title : "Pasted text");
  if (article) {
    setText($("#byline"), article.byline);
    setText($("#source"), article.url);
    $("#source").href = article.url;
  }
  for (const element of [$("#byline"), $("#source").parentElement]) element.hidden = !article;
  setText($("#article-body"), shown = text);
  $("#article-panel").hidden = false;
  setText($("#editor-summary"), "Edit article text");
}

function renderControls() {
  const view = controls(reader, active);
  // Keep the same URL input mounted and focusable throughout the reveal.
  if ($("#url").readOnly !== view.locked) $("#url").readOnly = view.locked;
  for (const id of ["#paste-fallback", "#text"]) setDisabled($(id), view.locked);
  for (const id of ["#read-url", "#voice", "#speed"]) setDisabled($(id), !view.canStart);
  setDisabled($("#read-start"), !view.canReadText);
  setText($("#read-start"), view.readTextLabel);
  for (const id of ["#playback", "#listen-title"]) {
    if ($(id).hidden === view.playback) $(id).hidden = !view.playback;
  }
  if (!view.playback) $("#diagnostics").hidden = true;
  if ($("#fallback-advice").hidden === view.advice) $("#fallback-advice").hidden = !view.advice;
  $("#paste-fallback").classList.toggle("recommended", view.advice);
}

function revealWorkspace() {
  $("#workspace").hidden = false;
  $("#reader").classList.add("is-revealed");
}

function openFallback() {
  if (active) return;
  reader.mode = "editing";
  $("#listening-card").hidden = false;
  revealWorkspace();
  $("#editor").open = true;
  $("#paste-fallback").setAttribute("aria-expanded", "true");
  if (shown === null) setText($("#editor-summary"), "Paste article text");
  renderControls();
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
  setIndicator(null);
}

function setIndicator(next) {
  if (next === indicator) return;
  // Capture the visible frame before removing the playback CSS animations.
  const fallingBars = next === "paused" && indicator === "playing" && !matchMedia("(prefers-reduced-motion: reduce)").matches
    ? [...status.querySelectorAll(".status-equalizer span")].map((bar) => ({ bar, clip: getComputedStyle(bar).clipPath })) : [];
  for (const animation of pauseAnimations) animation.cancel();
  for (const name of ["busy", "playing", "paused"]) status.classList.toggle(`is-${name}`, name === next);
  pauseAnimations = fallingBars.map(({ bar, clip }) => bar.animate(
    [{ clipPath: clip }, { clipPath: "inset(12px 0px 0px)" }],
    { duration: 450, easing: "ease-out" },
  ));
  indicator = next;
}

function render(update) {
  $("#listening-card").hidden = false;
  active = isActive(update);
  reader.mode = settle(reader.mode, update);
  if (active) highlight.update(); // Player updates include recovery offset changes, not only media events.
  else highlight.clear();
  renderControls();
  const view = playerStatus(reader.mode, update);
  setDisabled($("#stop"), !view.canStop);
  setDisabled($("#pause"), !view.canPause);
  setText($("#pause"), view.pauseLabel);
  setText(statusText, view.text);
  setIndicator(view.indicator);
  $("#recovery-note").hidden = !update.warning;
  if (update.warning) setText($("#recovery-note"), update.warning);
  $("#reconnect").hidden = !update.retryAvailable;
  setText($("#buffer"), `${update.bufferedSeconds.toFixed(1)} s`);
  setText($("#progress"), `${update.completed} / ${update.total}`);
  setText($("#first-audio"), update.firstAudioSeconds === null ? "—" : `${update.firstAudioSeconds.toFixed(2)} s`);
  setText($("#underruns"), String(update.underruns));
}

function read(fromUrl) {
  if (active || !reader.ready) return;
  const input = fromUrl ? $("#url").value.trim() : textArea.value.trim();
  if (!input) { showFeedback(fromUrl ? "Enter a webpage URL first." : "Enter some text first."); return; }
  if (!$("#narration-audio").canPlayType("audio/mpeg")) { showFeedback("This browser does not support MP3 audio playback."); return; }
  const voice = $("#voice").value;
  const speed = Number($("#speed").value);
  try {
    narrator?.dispose();
    highlight.clear();
    let narrated = input;
    const session = new StreamingPlayer({
      audio: $("#narration-audio"), bookmarkReady,
      onUpdate: (update) => { if (narrator === session) render(update); },
      onTimeline: () => {
        if (narrator !== session) return;
        // Pasted text moves from the editor to the article panel once the narration is accepted.
        if (shown !== narrated) {
          showNarratedText(narrated);
          $("#editor").open = false;
        }
        highlight.setTimeline(session.sentences, session.timings);
      },
    });
    const trigger = document.activeElement;
    narrator = session;
    reader.mode = fromUrl ? "fetching" : "text";
    if (!fromUrl) reader.hasRead = true;
    $("#diagnostics").hidden = false;
    render({ state: "loading", paused: false, bufferedSeconds: 0, completed: 0, total: 0, firstAudioSeconds: null, underruns: 0 });
    if (trigger === $("#read-url") || trigger === $("#read-start")) $("#stop").focus({ preventScroll: true });
    void session.start(async (signal) => {
      let text = input;
      if (fromUrl) {
        const extracted = await (await post("/api/article", { url: input }, signal)).json();
        signal.throwIfAborted();
        textArea.value = text = extracted.text;
        article = { title: extracted.title, byline: extracted.byline, url: extracted.url };
        reader.mode = "article";
        reader.hasRead = true;
        showNarratedText(text);
        revealWorkspace();
        $("#editor").open = false;
        $("#paste-fallback").setAttribute("aria-expanded", "false");
      } else if (article) showNarratedText(text);
      narrated = text;
      return { text, voice, speed, title: article ? article.title.slice(0, 200) : "Pasted text",
        byline: article ? article.byline.slice(0, 500) : "", ...(article ? { sourceUrl: article.url } : {}) };
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
  reader.mode = "editing";
  if (shown !== null) setText($("#article-body"), shown = textArea.value);
  renderControls();
});
function updateSettingsSummary() {
  const selection = `${$("#voice").selectedOptions[0].textContent} · ${$("#speed").selectedOptions[0].textContent}`;
  setText($("#settings-summary"), selection);
  $("#voice-settings summary").setAttribute("aria-label", `Voice and speed: ${selection}`);
}
for (const id of ["#voice", "#speed"]) $(id).addEventListener("change", updateSettingsSummary);
renderControls();
$("#pause").addEventListener("click", () => void narrator?.togglePause());
$("#stop").addEventListener("click", async () => {
  await narrator?.shutdown();
  $(hasText(reader.mode) ? "#read-start" : "#read-url").focus({ preventScroll: true });
});
$("#reconnect").addEventListener("click", () => void narrator?.refresh());
// Leaving the page must not cancel server-owned synthesis or native playback.
window.addEventListener("pagehide", () => narrator?.savePosition(true));
document.addEventListener("visibilitychange", () => { if (document.hidden) narrator?.savePosition(true); });
window.addEventListener("pageshow", () => void narrator?.refresh());

const recovery = new StreamingPlayer({
  audio: $("#narration-audio"), bookmarkReady,
  onUpdate: update => { if (narrator === recovery) render(update); },
  onTimeline: () => { if (narrator === recovery) highlight.setTimeline(recovery.sentences, recovery.timings); },
  onRestore: content => {
    if (narrator !== recovery) return;
    reader.mode = content.sourceUrl ? "article" : "text";
    reader.hasRead = true;
    textArea.value = content.text;
    $("#voice").value = content.voice;
    $("#speed").value = String(content.speed);
    updateSettingsSummary();
    if (content.sourceUrl) {
      $("#url").value = content.sourceUrl;
      article = { title: content.title, byline: content.byline, url: content.sourceUrl };
    }
    showNarratedText(content.text);
    $("#diagnostics").hidden = false;
    revealWorkspace();
  },
});
narrator = recovery;
void loadTtsSettings($("#voice")).then(async () => {
  reader.ready = true;
  updateSettingsSummary();
  renderControls();
  // Recovery must set the saved voice only after its option exists.
  const restored = await recovery.restore();
  if (!restored && narrator === recovery && recovery.bookmark.warning) showFeedback(recovery.bookmark.warning);
}).catch(error => {
  if (narrator !== recovery) return;
  if (!reader.ready) {
    setText($("#settings-summary"), "Voices unavailable");
    $("#voice-settings summary").setAttribute("aria-label", "Voice and speed: voices unavailable");
  }
  showFeedback(`${error.message} Reload to retry.`);
});
