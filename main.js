import { chunkText } from "./chunks.mjs";
import { Narrator } from "./narrator.mjs";
import { synthesizeSpeech } from "./tts-client.mjs";

const $ = (selector) => document.querySelector(selector);
const textArea = $("#text");
const status = $("#status");
const statusText = $("#status-text");
let narrator = null;
let active = false;
let source = "url";
let hasReadText = false;
let sessionHasText = false;

function renderSource() {
  // Keep the same URL input mounted and focusable throughout the reveal.
  if ($("#url").readOnly !== active) $("#url").readOnly = active;
  setDisabled($("#read-url"), active);
  setDisabled($("#paste-fallback"), active);
  setText($("#read-start"), hasReadText || source === "url" ? "Read again" : "Read text");
  setText($("#playback-hint"), active
    ? "Pause holds your place. Resume continues there; Stop discards the audio."
    : "Starts from the beginning and generates new audio each time. It does not replay saved audio.");
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
  setDisabled($("#read-start"), false);
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
  status.classList.remove("is-busy");
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
  for (const selector of ["#voice", "#speed", "#text"]) setDisabled($(selector), active);
  setDisabled($("#read-start"), active || (source === "url" && !sessionHasText));
  const extractionError = update.state === "error" && source === "url" && !sessionHasText;
  if ($("#fallback-advice").hidden !== !extractionError) $("#fallback-advice").hidden = !extractionError;
  if ($("#paste-fallback").classList.contains("recommended") !== extractionError) $("#paste-fallback").classList.toggle("recommended", extractionError);
  renderSource();
  setDisabled($("#stop"), !active);
  setDisabled($("#pause"), !active || update.state === "loading");
  setText($("#pause"), update.paused ? "Resume" : "Pause");
  const labels = { loading: source === "url" ? "Fetching and extracting article…" : "Preparing narration…", generating: "Generating first audio…", playing: "Playing", stopped: "Stopped", finished: "Finished", error: "Could not read article" };
  const state = update.paused ? "Paused" : update.warming ? "Speech engine is waking up…" : update.state === "playing" && update.bufferedSeconds < 0.05 ? "Buffering…" : labels[update.state];
  setText(statusText, update.error ? `${state}: ${update.error}` : state);
  const busy = Boolean(active && (update.warming || ["loading", "generating"].includes(update.state)) && !update.paused && !update.error);
  if (status.classList.contains("is-busy") !== busy) status.classList.toggle("is-busy", busy);
  setText($("#buffer"), `${update.bufferedSeconds.toFixed(1)} s`);
  setText($("#progress"), `${update.completed} / ${update.total}`);
  setText($("#first-audio"), update.firstAudioSeconds === null ? "—" : `${update.firstAudioSeconds.toFixed(2)} s`);
  setText($("#underruns"), String(update.underruns));
}

function read(fromUrl) {
  if (active) return;
  const input = fromUrl ? $("#url").value.trim() : textArea.value.trim();
  if (!input) { showFeedback(fromUrl ? "Enter a webpage URL first." : "Enter some text first."); return; }
  if (!fromUrl && input.length > 100_000) { showFeedback("Text exceeds the 100,000 character limit."); return; }
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) { showFeedback("This browser does not support Web Audio."); return; }
  const voice = $("#voice").value;
  const speed = Number($("#speed").value);
  try {
    const session = new Narrator({
      audioContext: new AudioContext(),
      synthesize: (text, signal, onWaiting) => synthesizeSpeech({ text, voice, speed }, signal, onWaiting),
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
      return chunkText(text);
    });
  } catch (error) { showFeedback(error.message); }
}

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
  setText($("#settings-summary"), `· ${$("#voice").selectedOptions[0].textContent} · ${$("#speed").selectedOptions[0].textContent}`);
}
for (const id of ["#voice", "#speed"]) $(id).addEventListener("change", updateSettingsSummary);
updateSettingsSummary();
$("#pause").addEventListener("click", () => void narrator?.togglePause());
$("#stop").addEventListener("click", () => {
  void narrator?.shutdown();
  $(sessionHasText || source === "text" ? "#read-start" : "#read-url").focus({ preventScroll: true });
});
window.addEventListener("pagehide", () => void narrator?.shutdown());
