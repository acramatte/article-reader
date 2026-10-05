import { test, expect } from "@playwright/test";
import { mockNarration, startPasted } from "./narration-fixture.mjs";

for (const width of [1280, 390, 320]) {
  test(`idle voice disclosure is compact, keyboard accessible and synchronized: ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    let speech;
    await page.route("**/api/article", (route) => route.fulfill({ json: {
      title: "Selected settings", byline: "", url: "https://example.com/article", text: "Read with my selected voice and speed.",
    } }));
    await page.route("**/api/streaming", (route) => {
      speech = route.request().postDataJSON();
      return route.fulfill({ status: 502, json: { error: "Settings speech error fixture" } });
    });
    await page.goto("/");
    await expect(page.locator("#url")).toHaveAttribute("placeholder", width <= 520 ? "Paste a link…" : "Paste an article link…");
    const summary = page.locator("#voice-settings summary");
    await expect(page.locator("#listening-card")).toBeHidden();
    await expect(summary).toHaveText("Heart · 1×");
    await expect(page.locator("#voice")).toBeHidden();
    await expect(summary).toHaveAccessibleName("Voice and speed: Heart · 1×");
    await expect(page.locator("#paste-fallback")).toHaveText("Paste text instead");
    await expect(page.locator("#url-hint")).toHaveCount(0);
    const input = await page.locator("#url").boundingBox();
    const submit = await page.locator("#read-url").boundingBox();
    expect(input.y).toBeCloseTo(submit.y, 0);
    expect(input.x + input.width).toBeLessThanOrEqual(submit.x);
    expect(submit.height).toBeGreaterThanOrEqual(44);
    const fallback = await page.locator("#paste-fallback").boundingBox();
    const trigger = await summary.boundingBox();
    expect(trigger.y).toBeCloseTo(fallback.y, 0);
    expect(fallback.x + fallback.width).toBeLessThanOrEqual(trigger.x);
    await page.locator("#paste-fallback").focus();
    await page.keyboard.press("Tab");
    await expect(summary).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(page.locator("#voice")).toBeFocused();
    const expandedTrigger = await summary.boundingBox();
    const expandedFallback = await page.locator("#paste-fallback").boundingBox();
    expect(expandedTrigger).toEqual(trigger);
    expect(expandedFallback).toEqual(fallback);
    const panel = await page.locator(".settings-panel").boundingBox();
    const form = await page.locator("#url-form").boundingBox();
    expect(panel.y).toBeGreaterThanOrEqual(trigger.y + trigger.height);
    expect(panel.width).toBeCloseTo(form.width, 0);
    await page.locator("#voice").selectOption("af_nicole");
    await page.keyboard.press("Tab");
    await expect(page.locator("#speed")).toBeFocused();
    await page.locator("#speed").selectOption("1.5");
    await expect(summary).toHaveText("Nicole · 1.5×");
    await expect(summary).toHaveAccessibleName("Voice and speed: Nicole · 1.5×");
    await expect(page.locator("#listening-card")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`settings-expanded-${width}.png`), fullPage: true });
    await summary.focus();
    await page.keyboard.press("Space");
    await expect(page.locator("#voice")).toBeHidden();
    await expect(summary).toHaveText("Nicole · 1.5×");
    await expect(summary).toHaveAccessibleName("Voice and speed: Nicole · 1.5×");
    await page.screenshot({ path: test.info().outputPath(`settings-collapsed-${width}.png`), fullPage: true });
    await page.locator("#url").fill("https://example.com/article");
    await page.locator("#read-url").click();
    await expect(page.locator("#status")).toContainText("Settings speech error fixture");
    await expect(page.locator("#listening-card")).toBeVisible();
    await expect(page.locator("#read-start")).toBeEnabled();
    await expect(page.locator("#fallback-advice")).toBeHidden();
    await expect(summary).toHaveText("Nicole · 1.5×");
    await expect(summary).toHaveAccessibleName("Voice and speed: Nicole · 1.5×");
    expect(speech).toMatchObject({ voice: "af_nicole", speed: 1.5 });
  });
}

test("URL placeholder follows viewport changes without replacing the focused input", async ({ page }) => {
  await page.setViewportSize({ width: 521, height: 844 });
  await page.goto("/");
  const input = page.locator("#url");
  await expect(input).toHaveAttribute("placeholder", "Paste an article link…");
  await input.fill("https://example.com/article");
  await input.evaluate((element) => { window.originalUrlInput = element; });
  await page.setViewportSize({ width: 520, height: 844 });
  await expect(input).toHaveAttribute("placeholder", "Paste a link…");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("https://example.com/article");
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(input).toHaveAttribute("placeholder", "Paste an article link…");
  await expect(input).toBeFocused();
  expect(await input.evaluate((element) => element === window.originalUrlInput)).toBe(true);
});

for (const failure of ["unsupported", "playback"]) {
  test(`pre-session ${failure} audio error reveals visible feedback without playback`, async ({ page }) => {
    await page.addInitScript((mode) => {
      if (mode === "unsupported") HTMLMediaElement.prototype.canPlayType = () => "";
      else HTMLMediaElement.prototype.play = () => Promise.reject(new Error("Audio device unavailable fixture"));
    }, failure);
    const fixture = await mockNarration(page);
    await startPasted(page);
    await expect(page.locator("#listening-card")).toBeVisible();
    await expect(page.locator("#status")).toContainText(failure === "unsupported" ? "does not support MP3 audio playback" : "Audio device unavailable fixture");
    await expect(page.locator("#read-url")).toBeEnabled();
    expect(fixture.requests).toHaveLength(failure === "unsupported" ? 0 : 1);
  });
}

test("native autoplay denial exposes explicit Resume without regenerating speech (SYNTHETIC/UI-only)", async ({ page }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    let denied = false;
    HTMLMediaElement.prototype.play = function () {
      if (!denied) { denied = true; return Promise.reject(new DOMException("Gesture needed", "NotAllowedError")); }
      return play.call(this);
    };
  });
  const fixture = await mockNarration(page);
  await startPasted(page);
  await expect(page.locator("#status")).toHaveText("Tap Resume to start audio.");
  await expect(page.locator("#pause")).toHaveText("Resume");
  await page.locator("#pause").click();
  await expect(page.locator("#status")).toHaveText("Playing");
  expect(fixture.requests).toHaveLength(1);
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Stopped");
});
