import { test, expect } from "@playwright/test";
import { mockNarration, deferred, startPasted, nativeTime } from "./narration-fixture.mjs";

// SYNTHETIC/UI-only migration of the former Web Audio startup/tick regressions.
// Provider 503/retry behavior is tested at the server boundary, not by these routes.
test("provider failure wins over a native unsupported-source rejection (UI-only)", async ({ page }) => {
  const fixture = await mockNarration(page);
  const statusGate = deferred();
  fixture.statusGate = statusGate;
  fixture.status = { state: "error", error: "Speech engine connection failed (UND_ERR_SOCKET).", warming: false };
  await page.route("**/api/streaming/*/audio", route => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: fixture.status.error }) }));
  await startPasted(page);
  await page.waitForFunction(() => Boolean(document.querySelector("#narration-audio").error));
  statusGate.resolve();
  await expect(page.locator("#status")).toHaveText(`Could not read article: ${fixture.status.error}`);
  expect(fixture.stops).toHaveLength(0);
});

test("native playback ticks preserve unchanged labels and disabled attributes (UI-only)", async ({ page }) => {
  await mockNarration(page);
  await startPasted(page);
  await expect(page.locator("#status")).toHaveText("Playing");
  const observe = () => page.evaluate(async () => {
    const elements = ["status", "pause", "progress", "first-audio", "underruns"].map(id => document.getElementById(id));
    const children = elements.map(element => element.firstChild);
    const mutations = [];
    const observer = new MutationObserver(records => mutations.push(...records.map(record => record.type)));
    for (const element of elements) observer.observe(element, { childList: true, characterData: true, subtree: true });
    for (const id of ["read-start", "read-url", "paste-fallback", "voice", "speed", "url", "text", "pause", "stop"]) {
      observer.observe(document.getElementById(id), { attributes: true, attributeFilter: ["disabled"] });
    }
    const bufferBefore = document.getElementById("buffer").textContent;
    await new Promise(resolve => setTimeout(resolve, 1300));
    observer.disconnect();
    return { mutations, sameTextNodes: elements.every((element, i) => element.firstChild === children[i]),
      bufferBefore, bufferAfter: document.getElementById("buffer").textContent };
  });
  const playing = await observe();
  expect(playing.mutations).toEqual([]);
  expect(playing.sameTextNodes).toBe(true);
  expect(playing.bufferAfter).not.toBe(playing.bufferBefore);
  await page.locator("#pause").click();
  await expect(page.locator("#status")).toHaveText("Paused");
  const paused = await observe();
  expect(paused.mutations).toEqual([]);
  expect(paused.sameTextNodes).toBe(true);
  expect(paused.bufferAfter).toBe(paused.bufferBefore);
  await page.locator("#pause").click();
  await expect(page.locator("#status")).toHaveText("Playing");
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Stopped");
});

test("native SSE pushes paused progress and recovers a dropped status connection without polling", async ({ page }) => {
  const fixture = await mockNarration(page, { state: "generating", generated: 1, total: 4, seconds: 30 });
  await startPasted(page);
  await expect(page.locator("#status")).toHaveText("Playing");
  await expect(page.locator("#progress")).toHaveText("1 / 4");
  const before = await nativeTime(page);
  fixture.disconnectStatus();
  await expect(page.locator("#recovery-note")).toContainText("Reconnecting");
  await expect.poll(() => nativeTime(page)).toBeGreaterThan(before + 0.3);
  await page.locator("#pause").click();
  fixture.status.generated = 3; // Updates missed during disconnect are recovered from the next snapshot.
  await expect(page.locator("#progress")).toHaveText("3 / 4");
  await expect(page.locator("#status")).toHaveText("Paused");
  await expect(page.locator("#recovery-note")).toBeHidden();
  fixture.status = { state: "ready", generated: 4, total: 4, warming: false };
  await expect(page.locator("#progress")).toHaveText("4 / 4");
  await page.waitForTimeout(1500);
  expect(fixture.eventReads).toHaveLength(2);
  expect(fixture.statusReads).toHaveLength(0);
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.stops).toHaveLength(0);
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Stopped");
});

test("a permanent SSE rejection reports expiry without an automatic request loop", async ({ page }) => {
  const fixture = await mockNarration(page, { state: "generating", generated: 0 });
  fixture.statusCode = 404;
  await startPasted(page);
  await expect(page.locator("#status")).toContainText("Recording expired or the server restarted");
  await expect(page.locator("#read-start")).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("reader.streaming.resume.v1"))).toBeNull();
  await page.waitForTimeout(1500);
  expect(fixture.eventReads).toHaveLength(1);
  expect(fixture.statusReads).toHaveLength(1);
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.stops).toHaveLength(0);
});

test("synthetic startup status clears when native audio starts without a second creation", async ({ page }) => {
  const mediaGate = deferred();
  const fixture = await mockNarration(page, { state: "generating", generated: 0, warming: true, mediaGate });
  await startPasted(page);
  await expect(page.locator("#status")).toHaveText("Speech engine is waking up…");
  await expect(page.locator("#stop")).toBeEnabled();
  expect(fixture.requests).toHaveLength(1);
  fixture.status = { state: "ready", generated: 1, total: 1, warming: false };
  mediaGate.resolve();
  await expect(page.locator("#status")).toHaveText("Playing");
  await expect.poll(() => nativeTime(page)).toBeGreaterThan(0.1);
  expect(fixture.requests).toHaveLength(1);
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Stopped");
});

test("first-audio generation uses the shared spinner through pause/resume (UI-only)", async ({ page }) => {
  const mediaGate = deferred();
  const fixture = await mockNarration(page, { state: "generating", generated: 0, mediaGate });
  await page.setViewportSize({ width: 390, height: 844 });
  await startPasted(page);
  await expect(page.locator("#status")).toHaveText("Generating first audio…");
  await expect(page.locator("#status")).toHaveClass("is-busy");
  expect(await page.locator(".status-spinner").evaluate(element => getComputedStyle(element, "::before").animationName)).toBe("status-dots");
  await page.screenshot({ path: test.info().outputPath("mobile-generating-spinner.png"), fullPage: true });
  await page.locator("#pause").click();
  await expect(page.locator("#status")).toHaveText("Paused");
  await expect(page.locator("#status")).not.toHaveClass("is-busy");
  await page.locator("#pause").click();
  await expect(page.locator("#status")).toHaveClass("is-busy");
  fixture.status = { state: "ready", generated: 1, total: 1, warming: false };
  mediaGate.resolve();
  await expect(page.locator("#status")).toHaveText("Playing");
  await expect(page.locator("#status")).not.toHaveClass("is-busy");
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Stopped");
});

test("waking spinner preserves live-region nodes and respects reduced motion (UI-only)", async ({ page }) => {
  const mediaGate = deferred();
  await mockNarration(page, { state: "generating", generated: 0, warming: true, mediaGate });
  await page.setViewportSize({ width: 390, height: 844 });
  await startPasted(page);
  await expect(page.locator("#status")).toHaveText("Speech engine is waking up…");
  await expect(page.locator(".status-spinner")).toHaveAttribute("aria-hidden", "true");
  const animation = await page.locator("#status").evaluate(async element => {
    const spinner = element.querySelector(".status-spinner");
    const before = getComputedStyle(spinner, "::before").content;
    const textNode = element.firstChild;
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true });
    await new Promise(resolve => setTimeout(resolve, 550));
    observer.disconnect();
    return { name: getComputedStyle(spinner, "::before").animationName, before,
      after: getComputedStyle(spinner, "::before").content, mutations, sameTextNode: textNode === element.firstChild };
  });
  expect(animation.name).toBe("status-dots");
  expect(animation.after).not.toBe(animation.before);
  expect(animation.mutations).toBe(0);
  expect(animation.sameTextNode).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-waking-spinner.png"), fullPage: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator(".status-spinner").evaluate(element => getComputedStyle(element, "::before").animationName)).toBe("none");
  await page.locator("#pause").click();
  await expect(page.locator("#status")).toHaveText("Paused");
  await expect(page.locator("#status")).not.toHaveClass("is-busy");
  await page.locator("#pause").click();
  await expect(page.locator("#status")).toHaveClass("is-busy");
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Stopped");
  await expect(page.locator("#status")).not.toHaveClass("is-busy");
  mediaGate.resolve();
});

test("Stop during synthetic warmup preserves cancellation and permits a fresh session", async ({ page }) => {
  const mediaGate = deferred();
  const fixture = await mockNarration(page, { state: "generating", generated: 0, warming: true, mediaGate });
  await startPasted(page);
  await expect(page.locator("#status")).toHaveText("Speech engine is waking up…");
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Stopped");
  expect(fixture.stops).toHaveLength(1);
  await page.waitForTimeout(1300);
  expect(fixture.requests).toHaveLength(1);
  mediaGate.resolve();
  fixture.mediaGate = null;
  fixture.status = { state: "ready", generated: 1, total: 1, warming: false };
  await page.locator("#read-start").click();
  await expect(page.locator("#status")).toHaveText("Playing");
  expect(fixture.requests).toHaveLength(2);
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Stopped");
});
