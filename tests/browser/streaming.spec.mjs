import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

// Real Pocket TTS speech and real MP3 decoding. No synthesis mocks in this acceptance test.
const text = [
  "This recording tests continuous streaming from the real speech engine. The first paragraph starts while the server is still preparing the following paragraphs. We should hear actual speech, not a synthetic test tone.",
  "The page will now be frozen deliberately through the browser debugging protocol. Generation must continue on the server, and the media player should advance without the page scheduling new audio chunks. This is not a physical Android test.",
  "After the page resumes, the report should show more generated chunks and a later playback position. Pausing and resuming must retain the same narration. The finished recording must decode to valid, non silent audio samples.",
].join("\n\n");

test("completed narration survives reload and a new tab, resumes its saved position without synthesis, and Stop forgets it", async ({ page, context, request }, testInfo) => {
  let creates = 0;
  context.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/streaming") creates++; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/streaming.html");
  await page.locator("#text").fill(text);
  await page.locator("#pace").uncheck();
  await page.locator("#start").click();
  await expect.poll(() => page.evaluate(() => window.streamingProbe().firstPlaybackSeconds)).not.toBeNull();
  const id = await page.evaluate(() => window.streamingProbe().id);
  await expect.poll(async () => (await request.get(`/api/streaming/${id}/status`).then(r => r.json())).state).toBe("ready");
  await page.locator("#audio").evaluate(async audio => {
    audio.pause();
    audio.currentTime = 6;
    await new Promise(resolve => audio.addEventListener("seeked", resolve, { once: true }));
  });
  await page.reload();
  await expect(page.locator("#resume")).toBeEnabled();
  const restored = await page.evaluate(() => window.streamingProbe());
  expect(restored.id).toBe(id);
  expect(restored.currentTime).toBeCloseTo(6, 0);
  expect(restored.paused).toBe(true);
  expect(restored.navigationType).toBe("reload");
  expect(typeof restored.wasDiscarded).toBe("boolean");
  expect(creates).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("recovered-mobile.png"), fullPage: true });
  await page.locator("#resume").click();
  await expect.poll(() => page.evaluate(() => window.streamingProbe().currentTime)).toBeGreaterThan(6.3);
  await page.locator("#audio").evaluate(audio => audio.pause());
  const pausedAt = await page.locator("#audio").evaluate(audio => audio.currentTime);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/streaming.html");
  await expect(reopened.locator("#resume")).toBeEnabled();
  expect(await reopened.evaluate(() => window.streamingProbe().id)).toBe(id);
  expect(await reopened.locator("#audio").evaluate(audio => audio.currentTime)).toBeCloseTo(pausedAt, 0);
  expect(creates).toBe(1);
  await reopened.locator("#stop").click();
  await expect(reopened.locator("#status")).toHaveText("Stopped.");
  await reopened.reload();
  await expect(reopened.locator("#start")).toBeEnabled();
  await expect(reopened.locator("#resume")).toBeHidden();
  expect(await reopened.evaluate(() => window.streamingProbe().id)).toBeNull();
  expect(creates).toBe(1);
});

async function recoveryFixture(page, request, paceSeconds = 0) {
  const response = await request.post("/api/streaming", { data: { text, voice: "jane", speed: 1, paceSeconds } });
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  if (!paceSeconds) await expect.poll(async () => (await request.get(`/api/streaming/${id}/status`).then(r => r.json())).state,
    { timeout: 90_000 }).toBe("ready");
  await page.goto("/streaming.html");
  await page.evaluate(id => localStorage.setItem("reader.streaming.resume.v1", JSON.stringify({
    id, title: "Recovery fixture", positionSeconds: 6, savedAt: Date.now() })), id);
  return id;
}

test("temporary reconnection failure preserves the bookmark and explicit retry restores it", async ({ page, request }) => {
  const id = await recoveryFixture(page, request);
  await page.route(`**/api/streaming/${id}/status`, route => route.abort("failed")); // Deliberate transport failure only.
  await page.reload();
  await expect(page.locator("#status")).toContainText("bookmark is retained");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("reader.streaming.resume.v1")).positionSeconds)).toBe(6);
  await page.unroute(`**/api/streaming/${id}/status`);
  await page.locator("#refresh").click();
  await expect(page.locator("#resume")).toBeEnabled();
  expect(await page.evaluate(() => window.streamingProbe().currentTime)).toBeCloseTo(6, 0);
  expect(await page.evaluate(() => window.streamingProbe().paused)).toBe(true);
  await page.locator("#stop").click();
});

test("Stop during recovery ignores a late ready status and cannot recreate the bookmark", async ({ page, request }) => {
  const id = await recoveryFixture(page, request);
  let release;
  let acknowledge;
  const gate = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { acknowledge = resolve; });
  await page.route(`**/api/streaming/${id}/status`, async route => {
    const response = await route.fetch(); // Retain the real pre-Stop response until cancellation is acknowledged.
    acknowledge();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.reload();
    await received;
    await page.locator("#stop").click();
    await expect(page.locator("#status")).toHaveText("Stopped.");
    release();
    await page.waitForTimeout(250);
    await expect(page.locator("#start")).toBeEnabled();
    expect(await page.evaluate(() => window.streamingProbe().snapshot.state)).toBe("stopped");
    expect(await page.evaluate(() => localStorage.getItem("reader.streaming.resume.v1"))).toBeNull();
  } finally { release(); }
});

test("in-progress recovery waits for completed audio before seeking without recreating narration", async ({ page, request }) => {
  const id = await recoveryFixture(page, request, 5);
  await page.reload();
  await expect(page.locator("#status")).toContainText("still generating");
  await expect(page.locator("#resume")).toBeDisabled();
  expect(await page.locator("#audio").getAttribute("src")).toBeNull();
  await expect(page.locator("#resume")).toBeEnabled({ timeout: 90_000 });
  expect(await page.evaluate(() => window.streamingProbe().id)).toBe(id);
  expect(await page.evaluate(() => window.streamingProbe().currentTime)).toBeCloseTo(6, 0);
  expect(await page.evaluate(() => window.streamingProbe().paused)).toBe(true);
  await page.locator("#stop").click();
});

test("missing recording is reported as expired without silently regenerating", async ({ page }) => {
  let creates = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/streaming") creates++; });
  await page.goto("/streaming.html");
  // Deliberately stale local bookmark; the server returns its actual missing-session 404.
  await page.evaluate(() => localStorage.setItem("reader.streaming.resume.v1", JSON.stringify({
    id: "81b16cd8-fab8-4ed9-b855-7f127299e944", title: "Expired test", positionSeconds: 6, savedAt: Date.now() })));
  await page.reload();
  await expect(page.locator("#status")).toContainText("expired");
  await expect(page.locator("#start")).toBeEnabled();
  await expect(page.locator("#resume")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("reader.streaming.resume.v1"))).toBeNull();
  expect(creates).toBe(0);
});

test("Stop waits for delayed creation acknowledgement and cancels the admitted session", async ({ page, request }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let acknowledge;
  const admitted = new Promise(resolve => { acknowledge = resolve; });
  let creates = 0;
  await page.route("**/api/streaming", async route => {
    if (++creates !== 1) return route.continue();
    const response = await route.fetch(); // Actual admitted server session; only delivery is delayed.
    acknowledge(await response.json());
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto("/streaming.html");
    await page.locator("#text").fill("A short real speech test after cancellation.");
    await page.locator("#pace").uncheck();
    await page.getByRole("button", { name: "Start streaming test" }).click();
    const session = await admitted;
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start streaming test" })).toBeDisabled();
    release();
    await expect(page.locator("#status")).toHaveText("Stopped.");
    expect((await request.get(`/api/streaming/${session.id}/status`).then(r => r.json())).state).toBe("stopped");
    await page.getByRole("button", { name: "Start streaming test" }).click();
    await expect.poll(() => page.evaluate(() => window.streamingProbe().firstPlaybackSeconds)).not.toBeNull();
    expect(await page.evaluate(() => window.streamingProbe().id)).not.toBe(session.id);
    expect(creates).toBe(2);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.locator("#status")).toHaveText("Stopped.");
  } finally { release(); }
});

test("real speech streams before completion and advances while page JavaScript is frozen", async ({ page, request }, testInfo) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/streaming.html");
  await page.locator("#text").fill(text);
  await page.locator("#pace").check();
  await page.getByRole("button", { name: "Start streaming test" }).click();
  await expect.poll(() => page.evaluate(() => window.streamingProbe().firstPlaybackSeconds)).not.toBeNull();
  const before = await page.evaluate(() => window.streamingProbe());
  const initial = await request.get(`/api/streaming/${before.id}/status`).then(r => r.json());
  expect(initial.generated).toBeLessThan(initial.total);
  expect(initial.state).toBe("generating");
  expect(before.paused).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Mark test, then lock phone" }).click();
  await expect.poll(() => page.evaluate(() => window.streamingProbe().snapshot.mark)).not.toBeUndefined();
  const marked = await request.get(`/api/streaming/${before.id}/status`).then(r => r.json());
  const beforeFreeze = await page.locator("#audio").evaluate(audio => audio.currentTime);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  let thawedAt;
  try {
    // Exhaust ALL audio that existed at the mark, not merely a few seconds of its initial buffer.
    await new Promise(resolve => setTimeout(resolve, Math.max(6000,
      (marked.mark.audioSecondsGenerated - beforeFreeze + 3) * 1000)));
    await expect.poll(async () => (await request.get(`/api/streaming/${before.id}/status`).then(r => r.json())).generated,
      { timeout: 30_000 }).toBeGreaterThan(marked.generated);
    // CPU synthesis may outrun the initial buffer only after a gap. Keep JS
    // frozen while the new MP3 bytes arrive and native playback consumes them.
    await new Promise(resolve => setTimeout(resolve, 3000));
  } finally {
    thawedAt = Date.now();
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
  }
  const after = await page.locator("#audio").evaluate(audio => audio.currentTime);
  const thawElapsedSeconds = (Date.now() - thawedAt) / 1000;
  expect(after - beforeFreeze).toBeGreaterThan(5);
  expect(after - marked.mark.audioSecondsGenerated).toBeGreaterThan(thawElapsedSeconds + 0.2);
  const generatedBeforePause = await request.get(`/api/streaming/${before.id}/status`).then(r => r.json());
  await page.locator("#audio").evaluate(audio => audio.pause());
  const pausedAt = await page.locator("#audio").evaluate(audio => audio.currentTime);
  await page.waitForTimeout(400);
  expect(await page.locator("#audio").evaluate(audio => audio.currentTime)).toBeCloseTo(pausedAt, 1);
  await page.locator("#audio").evaluate(audio => audio.play());
  expect(await page.evaluate(() => window.streamingProbe().id)).toBe(before.id);
  await expect.poll(async () => (await request.get(`/api/streaming/${before.id}/status`).then(r => r.json())).state).toBe("ready");
  const ready = await request.get(`/api/streaming/${before.id}/status`).then(r => r.json());
  const recording = await request.get(`/api/streaming/${before.id}/audio`);
  expect(recording.headers()["content-type"]).toBe("audio/mpeg");
  const path = testInfo.outputPath("real-pocket-tts-stream.mp3");
  await writeFile(path, await recording.body());
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "pipe:1"], { maxBuffer: 20_000_000 });
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 4) sum += pcm.readFloatLE(i) ** 2;
  const rms = Math.sqrt(sum / (pcm.length / 4));
  expect(rms).toBeGreaterThan(0.005);
  await page.getByRole("button", { name: "Refresh report" }).click();
  await page.locator("details").evaluate(details => { details.open = true; });
  await page.screenshot({ path: testInfo.outputPath("streaming-mobile.png"), fullPage: true });
  console.log("REAL STREAMING METRICS", JSON.stringify({ firstPlaybackSeconds: before.firstPlaybackSeconds,
    generatedAtPlayback: initial.generated, total: ready.total, frozenPlaybackAdvanceSeconds: after - beforeFreeze,
    preFreezeAudioSeconds: marked.mark.audioSecondsGenerated, playbackSecondsAfterThaw: after, thawElapsedSeconds,
    generatedAfterMark: ready.generatedAfterMark, bytes: ready.bytes, audioSecondsGenerated: ready.audioSecondsGenerated,
    rms, generatedBeforePause: generatedBeforePause.generated, recording: path }));
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Stopped.");
  await expect(page.getByRole("button", { name: "Start streaming test" })).toBeEnabled();
  expect(errors).toEqual([]);
});
