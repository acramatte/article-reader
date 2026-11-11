import test from "node:test";
import assert from "node:assert/strict";
import { controls, isActive, settle, status } from "../reader-mode.mjs";

const update = (fields) => ({ state: "playing", paused: false, bufferedSeconds: 4, firstAudioSeconds: 0.8, ...fields });
const offered = (mode, { active = false, hasRead = true, ready = true } = {}) => controls({ mode, hasRead, ready }, active);

test("each idle mode offers exactly the controls it can honour", () => {
  // mode: [Read again shown, Read again usable, extraction advice]
  const expected = {
    landing: [false, false, false],
    failed: [false, false, true],
    editing: [true, true, false],
  };
  for (const [mode, [playback, canReadText, advice]] of Object.entries(expected)) {
    const view = offered(mode);
    assert.deepEqual([view.playback, view.canReadText, view.advice], [playback, canReadText, advice], mode);
    assert.equal(view.locked, false, mode);
    assert.equal(view.canStart, true, mode);
  }
});

test("a narration in flight locks every source and shows the transport in any mode", () => {
  for (const mode of ["landing", "fetching", "article", "text", "editing"]) {
    const view = offered(mode, { active: true });
    assert.deepEqual([view.locked, view.canStart, view.canReadText, view.playback, view.advice], [true, false, false, true, false], mode);
  }
});

test("nothing can be read before the voices load, and only never-read text is labelled Read text", () => {
  const waiting = offered("editing", { ready: false });
  assert.deepEqual([waiting.canStart, waiting.canReadText, waiting.playback], [false, false, true]);
  assert.equal(offered("editing", { hasRead: false }).readTextLabel, "Read text");
  assert.equal(offered("editing").readTextLabel, "Read again");
  for (const mode of ["landing", "fetching", "failed", "article", "text"]) assert.equal(offered(mode, { hasRead: false }).readTextLabel, "Read again", mode);
});

test("only a narration ending moves the reader, and where to depends on what it had", () => {
  const moves = [
    ["fetching", "error", "failed"], ["fetching", "stopped", "landing"],
    ["article", "stopped", "editing"], ["article", "finished", "editing"], ["article", "error", "editing"],
    ["text", "stopped", "editing"], ["text", "error", "editing"],
    // A restore that fails before its content arrives is not a failed extraction.
    ["landing", "error", "landing"], ["editing", "error", "editing"], ["failed", "stopped", "failed"],
  ];
  for (const [mode, state, next] of moves) assert.equal(settle(mode, update({ state })), next, `${mode} + ${state}`);
  for (const mode of ["landing", "fetching", "article", "text", "editing"]) {
    for (const state of ["loading", "generating", "playing", "recovering", "stopping"]) {
      assert.equal(isActive(update({ state })), true, state);
      assert.equal(settle(mode, update({ state })), mode, `${mode} + ${state}`);
    }
  }
});

test("the status names what the player is doing, most specific first", () => {
  const cases = [
    // [mode, update, text, indicator]
    ["fetching", { state: "loading", bufferedSeconds: 0, firstAudioSeconds: null }, "Fetching and extracting article…", "busy"],
    ["article", { state: "loading", bufferedSeconds: 0, firstAudioSeconds: null }, "Fetching and extracting article…", "busy"],
    ["text", { state: "loading", bufferedSeconds: 0, firstAudioSeconds: null }, "Preparing narration…", "busy"],
    ["text", { state: "generating", firstAudioSeconds: null }, "Generating first audio…", "busy"],
    ["text", { state: "generating", firstAudioSeconds: null, warming: true }, "Speech engine is waking up…", "busy"],
    ["text", {}, "Playing", "playing"],
    ["text", { bufferedSeconds: 0.04 }, "Buffering…", null],
    ["text", { bufferedSeconds: 0.05 }, "Playing", "playing"],
    // Paused reports the state it will resume to, so pausing outranks everything that state would say.
    ["text", { paused: true, bufferedSeconds: 0 }, "Paused", "paused"],
    ["text", { state: "generating", paused: true, warming: true, firstAudioSeconds: null }, "Paused", "paused"],
    ["text", { paused: true, needsGesture: true }, "Tap Resume to start audio.", "paused"],
    ["article", { paused: true, recovered: true, firstAudioSeconds: null }, "Saved recording ready. Press Resume.", "paused"],
    ["article", { paused: true, recovered: true }, "Paused", "paused"],
    // Recovery outranks pausing: a recovering player also reports itself paused.
    ["landing", { state: "recovering", paused: true, recovering: true, recovered: true, recoveryPhase: "connection", firstAudioSeconds: null }, "Reconnecting to your recording…", "paused"],
    ["article", { state: "recovering", paused: true, recovering: true, recovered: true, recoveryPhase: "generation", firstAudioSeconds: null }, "Recording is still generating. Waiting to restore the saved position…", "paused"],
    ["article", { state: "recovering", paused: true, recovering: true, recoveryPhase: "position" }, "Restoring your saved position…", "paused"],
    ["text", { state: "stopping" }, "Stopping…", null],
    ["editing", { state: "stopped" }, "Stopped", null],
    ["editing", { state: "finished" }, "Finished", null],
    ["failed", { state: "error", error: "No readable article found." }, "Could not read article: No readable article found.", null],
    // A failure being cancelled on the server is still stopping, and shows no activity.
    ["text", { state: "stopping", error: "Speech engine connection failed." }, "Stopping…: Speech engine connection failed.", null],
  ];
  for (const [mode, fields, text, indicator] of cases) {
    const view = status(mode, update(fields));
    assert.deepEqual([view.text, view.indicator], [text, indicator], `${mode} ${JSON.stringify(fields)}`);
  }
});

test("Pause and Stop are offered only while they can act", () => {
  const offers = (fields) => { const view = status("text", update(fields)); return [view.canPause, view.canStop, view.pauseLabel]; };
  assert.deepEqual(offers({}), [true, true, "Pause"]);
  assert.deepEqual(offers({ paused: true }), [true, true, "Resume"]);
  assert.deepEqual(offers({ state: "generating" }), [true, true, "Pause"]);
  assert.deepEqual(offers({ state: "loading" }), [false, true, "Pause"]);
  assert.deepEqual(offers({ state: "recovering", paused: true, recovering: true, recoveryPhase: "connection" }), [false, true, "Resume"]);
  assert.deepEqual(offers({ state: "stopping" }), [false, false, "Pause"]);
  for (const state of ["stopped", "finished", "error"]) assert.deepEqual(offers({ state }), [false, false, "Pause"], state);
});
