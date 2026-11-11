// What the reader page offers is one mode; what the player is doing arrives separately in its updates.
//
//   landing ──Read URL──▶ fetching ──article──▶ article ──ended──▶ editing ──Read again──▶ text ──ended──▶ editing
//      ▲                     │ └─error──▶ failed
//      └──────stopped────────┘
//   Paste text instead, or typing in the editor, enters editing from any idle mode.
//
//   landing   nothing to read yet            fetching  a URL read is waiting for its article
//   failed    that article was not extracted  editing   text is ready to read
//   article   narrating an extracted article  text      narrating pasted or edited text
const ENDED = ["stopped", "finished", "error"];

export const isActive = (update) => !ENDED.includes(update.state);
export const hasText = (mode) => ["editing", "article", "text"].includes(mode);

// A narration ending is the only thing the player does that moves the reader.
export function settle(mode, update) {
  if (isActive(update)) return mode;
  if (mode === "fetching") return update.state === "error" ? "failed" : "landing";
  return mode === "article" || mode === "text" ? "editing" : mode;
}

// Everything the mode decides, for main.js to apply. `active` is the player's side: a narration is in flight.
export function controls({ mode, hasRead, ready }, active) {
  return {
    locked: active,
    canStart: !active && ready,
    canReadText: !active && ready && hasText(mode),
    readTextLabel: mode === "editing" && !hasRead ? "Read text" : "Read again",
    playback: active || hasText(mode),
    advice: !active && mode === "failed",
  };
}

// activity: [status text, indicator]
const STATUS = {
  connection: ["Reconnecting to your recording…", "paused"],
  generation: ["Recording is still generating. Waiting to restore the saved position…", "paused"],
  position: ["Restoring your saved position…", "paused"],
  gesture: ["Tap Resume to start audio.", "paused"],
  ready: ["Saved recording ready. Press Resume.", "paused"],
  paused: ["Paused", "paused"],
  warming: ["Speech engine is waking up…", "busy"],
  buffering: ["Buffering…", null],
  fetching: ["Fetching and extracting article…", "busy"],
  loading: ["Preparing narration…", "busy"],
  generating: ["Generating first audio…", "busy"],
  playing: ["Playing", "playing"],
  stopping: ["Stopping…", null],
  stopped: ["Stopped", null],
  finished: ["Finished", null],
  error: ["Could not read article", null],
};

// Most specific first: a recovering player also reports itself paused, and a paused one reports the state it resumes to.
function activity(mode, update) {
  if (update.recovering) return update.recoveryPhase;
  if (update.needsGesture) return "gesture";
  if (update.paused) return update.recovered && update.firstAudioSeconds === null ? "ready" : "paused";
  if (update.warming) return "warming";
  if (update.state === "playing" && update.bufferedSeconds < 0.05) return "buffering";
  if (update.state === "loading" && (mode === "fetching" || mode === "article")) return "fetching";
  return update.state;
}

export function status(mode, update) {
  const [text, indicator] = STATUS[activity(mode, update)];
  const active = isActive(update);
  return {
    text: update.error ? `${text}: ${update.error}` : text,
    indicator: update.error ? null : indicator,
    pauseLabel: update.paused ? "Resume" : "Pause",
    canPause: active && !["loading", "stopping"].includes(update.state) && !update.recovering,
    canStop: active && update.state !== "stopping",
  };
}
