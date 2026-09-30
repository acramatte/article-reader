import { test } from "node:test";
import assert from "node:assert/strict";
import { Narrator } from "../narrator.mjs";

function context(duration = 20) {
  return { currentTime: 0, state: "suspended", destination: {}, starts: [],
    async resume() { this.state = "running"; }, async suspend() { this.state = "suspended"; }, async close() { this.state = "closed"; },
    async decodeAudioData() { return { duration }; },
    createBufferSource() { const ctx = this; return { connect() {}, disconnect() {}, stop() {}, start(at) { ctx.starts.push({ at, source: this }); } }; },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 130));

test("schedules contiguous chunks and waits when buffer reaches target", async () => {
  const audioContext = context();
  let requests = 0;
  const narrator = new Narrator({ audioContext, synthesize: async () => { requests++; return new ArrayBuffer(1); } });
  const running = narrator.start(async () => ["one", "two", "three", "four"]);
  await tick();
  assert.equal(requests, 3);
  assert.deepEqual(audioContext.starts.map((s) => s.at), [0.05, 20.05, 40.05]);
  assert.ok(narrator.bufferedSeconds > 45 && narrator.bufferedSeconds < 66);
  audioContext.currentTime = 21;
  await running;
  assert.equal(requests, 4);
  assert.equal(narrator.underruns, 0);
  await narrator.shutdown();
});

test("pause suspends the clock and production; stop cancels and clears resources", async () => {
  const audioContext = context();
  const narrator = new Narrator({ audioContext, synthesize: async () => new ArrayBuffer(1) });
  const running = narrator.start(async () => ["one", "two", "three", "four"]);
  await tick();
  await narrator.togglePause();
  assert.equal(audioContext.state, "suspended");
  audioContext.currentTime = 40;
  await tick();
  assert.equal(narrator.generated, 3);
  await narrator.togglePause();
  await running;
  assert.equal(narrator.generated, 4);
  await narrator.shutdown();
  assert.equal(narrator.state, "stopped");
  assert.equal(narrator.controller.signal.aborted, true);
  assert.equal(narrator.sources.size, 0);
  assert.equal(audioContext.state, "closed");
});

test("stop during inference discards late audio and new sessions are independent", async () => {
  let finish;
  const audioContext = context();
  const narrator = new Narrator({ audioContext, synthesize: () => new Promise((resolve) => { finish = resolve; }) });
  const running = narrator.start(async () => ["one"]);
  await tick();
  await narrator.shutdown();
  finish(new ArrayBuffer(1));
  await running;
  assert.equal(audioContext.starts.length, 0);
  const next = new Narrator({ audioContext: context(), synthesize: async () => new ArrayBuffer(1) });
  await next.start(async () => ["new"]);
  assert.equal(next.generated, 1);
  await next.shutdown();
});

test("finish and errors close the context; underruns are counted", async () => {
  const audioContext = context();
  const narrator = new Narrator({ audioContext, synthesize: async () => { audioContext.currentTime += 30; return new ArrayBuffer(1); } });
  await narrator.start(async () => ["one", "two"]);
  assert.equal(narrator.underruns, 1);
  audioContext.starts.forEach(({ source }) => source.onended());
  assert.equal(narrator.state, "finished");
  assert.equal(audioContext.state, "closed");
  const broken = new Narrator({ audioContext: context(), synthesize: async () => { throw new Error("offline"); } });
  await broken.start(async () => ["one"]);
  assert.equal(broken.state, "error");
  assert.equal(broken.error, "offline");
});
