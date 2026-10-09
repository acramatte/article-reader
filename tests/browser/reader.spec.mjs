import { test, expect } from "@playwright/test";
import { paragraphs } from "../fixture.mjs";
import { nativeTime, bookmark, BOOKMARK_KEY } from "./narration-fixture.mjs";

// Real end-to-end coverage: no synthetic media or /api/streaming routes here.
// Run the backend with TTS_URL=http://127.0.0.1:8027/tts.
test("real public URL → Readability → Pocket TTS → native continuous MP3 playback", async ({ page, request }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A regression to browser-owned Web Audio must fail even if audio is audible.
  await page.addInitScript(() => {
    window.AudioContext = class { constructor() { throw new Error("Normal reader must use native media"); } };
    window.webkitAudioContext = window.AudioContext;
  });
  await page.goto("/");
  const mediaResponse = page.waitForResponse(response => /\/api\/streaming\/[^/]+\/audio$/.test(new URL(response.url()).pathname));
  await page.getByLabel("Webpage URL").fill("https://www.paulgraham.com/greatwork.html");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(page.locator("#article-title")).toHaveText("How to Do Great Work");
  await page.getByText("Buffer & playback details", { exact: true }).click();
  await expect(page.locator("#first-audio")).not.toHaveText("—", { timeout: 60_000 });
  const saved = await bookmark(page);
  expect(saved).not.toBeNull();
  const statusPath = `/api/streaming/${saved.id}/status`;
  const firstStatus = await (await request.get(statusPath)).json();
  expect(firstStatus.total).toBeGreaterThan(2);
  expect(firstStatus.generated).toBeLessThan(firstStatus.total);
  const started = await nativeTime(page);
  await expect.poll(() => nativeTime(page)).toBeGreaterThan(started + 0.5);
  await expect.poll(async () => Number.parseInt(await page.locator("#progress").innerText()), { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
  const media = await mediaResponse;
  expect([200, 206]).toContain(media.status());
  expect(media.headers()["content-type"]).toContain("audio/mpeg");
  expect(firstStatus.bytes).toBeGreaterThan(0);
  const measurement = await page.locator("#narration-audio").evaluate((audio) => ({
    currentTime: audio.currentTime, paused: audio.paused, readyState: audio.readyState, src: audio.currentSrc,
    firstAudio: document.querySelector("#first-audio").textContent, prepared: document.querySelector("#progress").textContent,
    underruns: document.querySelector("#underruns").textContent, characters: document.querySelector("#text").value.length,
  }));
  expect(measurement.paused).toBe(false);
  expect(measurement.src).toContain(`/api/streaming/${saved.id}/audio`);
  console.log("REAL NATIVE ARTICLE METRICS", JSON.stringify({ ...measurement, firstStatus }));
  await page.locator("#pause").click();
  await expect(page.locator("#status")).toHaveText("Paused");
  const pausedAt = await nativeTime(page);
  await page.waitForTimeout(400);
  expect(await nativeTime(page)).toBeCloseTo(pausedAt, 2);
  await page.locator("#pause").click();
  await expect.poll(() => nativeTime(page)).toBeGreaterThan(pausedAt + 0.3);
  await page.screenshot({ path: test.info().outputPath("desktop-playing.png"), fullPage: true });
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Stopped");
  await expect(page.getByRole("button", { name: "Read again", exact: true })).toBeEnabled();
  expect(await bookmark(page)).toBeNull();
  expect(errors).toEqual([]);
});

test("mobile real native narration, stop/restart and natural completion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#paste-fallback").click();
  await page.getByLabel("Extracted or pasted text").fill(paragraphs.join("\n\n"));
  await page.locator("#read-start").click();
  await expect(page.locator("#first-audio")).not.toHaveText("—", { timeout: 60_000 });
  const at = await nativeTime(page);
  await expect.poll(() => nativeTime(page)).toBeGreaterThan(at + 0.3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-playing.png"), fullPage: true });
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Stopped");
  await expect(page.locator("#read-start")).toHaveText("Read again");
  await page.screenshot({ path: test.info().outputPath("mobile-stopped.png"), fullPage: true });
  await page.locator("#paste-fallback").click();
  await page.getByLabel("Extracted or pasted text").fill("This is a short test of the article reader. Thank you for listening.");
  await page.locator("#read-start").click();
  await expect(page.locator("#status")).toHaveText("Finished", { timeout: 60_000 });
  expect(await page.locator("#narration-audio").evaluate((audio) => audio.ended)).toBe(true);
  expect(await bookmark(page)).toBeNull();
});

test("default reader reload and a reopened tab restore the same real recording; explicit Resume only", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const article = { title: "A recoverable listening session", byline: "Extraction fixture", url: "https://example.com/recovery", text: paragraphs.join("\n\n") };
  // Extraction fixture ONLY: creation, synthesis, MP3 and completed-file seeking are real.
  let extractions = 0;
  await page.route("**/api/article", (route) => { extractions++; return route.fulfill({ json: article }); });
  const creations = [];
  const cancellations = [];
  page.context().on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/streaming") creations.push(req.postDataJSON());
    if (req.method() === "POST" && /\/api\/streaming\/[^/]+\/stop$/.test(new URL(req.url()).pathname)) cancellations.push(req.url());
  });
  await page.goto("/");
  await page.locator("#voice-settings summary").click();
  await page.locator("#voice").selectOption("bill_boerst");
  await page.locator("#speed").selectOption("1.2");
  await page.locator("#url").fill(article.url);
  await page.locator("#read-url").click();
  await expect(page.locator("#first-audio")).not.toHaveText("—", { timeout: 60_000 });
  await page.locator("#pause").click();
  await expect(page.locator("#status")).toHaveText("Paused");
  const saved = await bookmark(page);
  await expect.poll(async () => (await (await request.get(`/api/streaming/${saved.id}/status`)).json()).state, { timeout: 120_000 }).toBe("ready");
  await page.locator("#narration-audio").evaluate((audio) => { audio.currentTime = 2; });
  await expect.poll(async () => (await bookmark(page)).positionSeconds).toBeCloseTo(2, 1);
  await page.reload();
  await expect(page.locator("#status")).toHaveText("Saved recording ready. Press Resume.", { timeout: 30_000 });
  await expect(page.locator("#pause")).toHaveText("Resume");
  await expect(page.locator("#pause")).toBeEnabled();
  await expect(page.locator("#text")).toHaveValue(article.text);
  await expect(page.locator("#article-title")).toHaveText(article.title);
  await expect(page.locator("#article-body")).toHaveText(article.text);
  await expect(page.locator("#byline")).toHaveText(article.byline);
  await expect(page.locator("#url")).toHaveValue(article.url);
  await expect(page.locator("#voice")).toHaveValue("bill_boerst");
  await expect(page.locator("#speed")).toHaveValue("1.2");
  await expect(page.locator("#settings-summary")).toHaveText("Bill Boerst · 1.2×");
  expect((await bookmark(page)).id).toBe(saved.id);
  expect(creations).toHaveLength(1);
  expect(extractions).toBe(1);
  expect(cancellations).toEqual([]); // pagehide must not cancel server work.
  expect(await page.locator("#narration-audio").evaluate((audio) => audio.paused)).toBe(true);
  const pausedAt = await nativeTime(page);
  expect(pausedAt).toBeCloseTo(2, 1);
  await page.waitForTimeout(500);
  expect(await nativeTime(page)).toBeCloseTo(pausedAt, 2);
  await expect(page.locator("#first-audio")).toHaveText("—");
  await expect(page.locator("#workspace")).toHaveCSS("opacity", "1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-recovered.png"), fullPage: true });
  await page.locator("#pause").click();
  await expect.poll(() => nativeTime(page)).toBeGreaterThan(pausedAt + 0.3);
  await expect(page.locator("#first-audio")).not.toHaveText("—");
  expect(creations).toHaveLength(1);
  await page.locator("#pause").click();
  const reopenedPosition = await nativeTime(page);
  const context = page.context();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(reopened.locator("#status")).toHaveText("Saved recording ready. Press Resume.");
  expect((await bookmark(reopened)).id).toBe(saved.id);
  expect(await nativeTime(reopened)).toBeCloseTo(reopenedPosition, 1);
  await expect(reopened.locator("#article-body")).toHaveText(article.text);
  expect(creations).toHaveLength(1);
  expect(extractions).toBe(1);
  await reopened.locator("#stop").click();
  await expect(reopened.locator("#status")).toHaveText("Stopped");
  expect(cancellations).toHaveLength(1);
  expect(await reopened.evaluate((key) => localStorage.getItem(key), BOOKMARK_KEY)).toBeNull();
});

test("private URL is blocked and extraction failure can recover with pasted text", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Webpage URL").fill("http://127.0.0.1/secret");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(page.locator("#status")).toContainText("not allowed");
  await expect(page.locator("#read-url")).toBeEnabled();
  await expect(page.locator("#fallback-advice")).toBeVisible();
  await expect(page.locator("#article-panel")).toBeHidden();
  await page.route("**/api/streaming", (route) => route.fulfill({ status: 502, json: { error: "Pocket TTS is unavailable." } }));
  await page.locator("#paste-fallback").click();
  await page.getByLabel("Extracted or pasted text").fill("An article can still be pasted here after a failed extraction.");
  await page.locator("#read-start").click();
  await expect(page.locator("#status")).toContainText("Pocket TTS is unavailable.");
});
