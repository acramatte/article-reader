import { chunkText } from "./chunks.mjs";
import { Narrator } from "./narrator.mjs";
import { synthesizeSpeech } from "./tts-client.mjs";

const $ = (selector) => document.querySelector(selector);
const textArea = $("#text");
const status = $("#status");
const statusText = $("#status-text");
let narrator = null;

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

function render(update) {
  const active = !["stopped", "finished", "error"].includes(update.state);
  for (const selector of ["#read-url", "#read-text", "#voice", "#speed", "#url", "#text"]) setDisabled($(selector), active);
  setDisabled($("#stop"), !active);
  setDisabled($("#pause"), !active || update.state === "loading");
  setText($("#pause"), update.paused ? "Resume" : "Pause");
  const labels = { loading: "Fetching and extracting article…", generating: "Generating first audio…", playing: "Playing", stopped: "Stopped", finished: "Finished", error: "Could not read article" };
  const state = update.paused ? "Paused" : update.warming ? "Speech engine is waking up…" : update.state === "playing" && update.bufferedSeconds < 0.05 ? "Buffering…" : labels[update.state];
  setText(statusText, update.error ? `${state}: ${update.error}` : state);
  const busy = Boolean(active && (update.warming || update.state === "generating") && !update.paused && !update.error);
  if (status.classList.contains("is-busy") !== busy) status.classList.toggle("is-busy", busy);
  setText($("#buffer"), `${update.bufferedSeconds.toFixed(1)} s`);
  setText($("#progress"), `${update.completed} / ${update.total}`);
  setText($("#first-audio"), update.firstAudioSeconds === null ? "—" : `${update.firstAudioSeconds.toFixed(2)} s`);
  setText($("#underruns"), String(update.underruns));
}

function read(fromUrl) {
  const input = fromUrl ? $("#url").value.trim() : textArea.value.trim();
  if (!input) { statusText.textContent = fromUrl ? "Enter a webpage URL first." : "Enter some text first."; return; }
  if (!fromUrl && input.length > 100_000) { statusText.textContent = "Text exceeds the 100,000 character limit."; return; }
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) { statusText.textContent = "This browser does not support Web Audio."; return; }
  const voice = $("#voice").value;
  const speed = Number($("#speed").value);
  try {
    const session = new Narrator({
      audioContext: new AudioContext(),
      synthesize: (text, signal, onWaiting) => synthesizeSpeech({ text, voice, speed }, signal, onWaiting),
      onUpdate: (update) => { if (narrator === session) render(update); },
    });
    narrator = session;
    render({ state: "loading", paused: false, bufferedSeconds: 0, completed: 0, total: 0, firstAudioSeconds: null, underruns: 0 });
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
      }
      return chunkText(text);
    });
  } catch (error) { statusText.textContent = error.message; }
}

$("#url-form").addEventListener("submit", (event) => { event.preventDefault(); read(true); });
$("#read-text").addEventListener("click", () => read(false));
$("#pause").addEventListener("click", () => void narrator?.togglePause());
$("#stop").addEventListener("click", () => void narrator?.shutdown());
window.addEventListener("pagehide", () => void narrator?.shutdown());
