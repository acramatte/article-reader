import { test, expect } from "@playwright/test";

for (const width of [1280, 390, 320]) {
  test(`idle voice disclosure is compact, keyboard accessible and synchronized: ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    let speech;
    await page.route("**/api/article", (route) => route.fulfill({ json: {
      title: "Selected settings", byline: "", url: "https://example.com/article", text: "Read with my selected voice and speed.",
    } }));
    await page.route("**/api/tts", (route) => {
      speech = route.request().postDataJSON();
      return route.fulfill({ status: 502, json: { error: "Settings speech error fixture" } });
    });
    await page.goto("/");
    const summary = page.locator("#voice-settings summary");
    await expect(page.locator("#listening-card")).toBeHidden();
    await expect(summary).toHaveText("Voice & speed · Heart · 1×");
    await expect(page.locator("#voice")).toBeHidden();
    await page.locator("#paste-fallback").focus();
    await page.keyboard.press("Tab");
    await expect(summary).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(page.locator("#voice")).toBeFocused();
    await page.locator("#voice").selectOption("af_nicole");
    await page.keyboard.press("Tab");
    await expect(page.locator("#speed")).toBeFocused();
    await page.locator("#speed").selectOption("1.5");
    await expect(summary).toHaveText("Voice & speed · Nicole · 1.5×");
    await expect(page.locator("#listening-card")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`settings-expanded-${width}.png`), fullPage: true });
    await summary.focus();
    await page.keyboard.press("Space");
    await expect(page.locator("#voice")).toBeHidden();
    await expect(summary).toHaveText("Voice & speed · Nicole · 1.5×");
    await page.screenshot({ path: test.info().outputPath(`settings-collapsed-${width}.png`), fullPage: true });
    await page.locator("#url").fill("https://example.com/article");
    await page.locator("#read-url").click();
    await expect(page.locator("#status")).toContainText("Settings speech error fixture");
    await expect(page.locator("#listening-card")).toBeVisible();
    await expect(page.locator("#read-start")).toBeEnabled();
    await expect(page.locator("#fallback-advice")).toBeHidden();
    await expect(summary).toHaveText("Voice & speed · Nicole · 1.5×");
    expect(speech).toMatchObject({ voice: "af_nicole", speed: 1.5 });
  });
}

for (const failure of ["unsupported", "constructor"]) {
  test(`pre-session ${failure} audio error reveals visible feedback without playback`, async ({ page }) => {
    await page.addInitScript((mode) => {
      window.webkitAudioContext = undefined;
      window.AudioContext = mode === "unsupported" ? undefined : class {
        constructor() { throw new Error("Audio device unavailable fixture"); }
      };
    }, failure);
    await page.goto("/");
    await expect(page.locator("#listening-card")).toBeHidden();
    await page.locator("#url").fill("https://example.com/article");
    await page.locator("#read-url").click();
    await expect(page.locator("#listening-card")).toBeVisible();
    await expect(page.locator("#status")).toContainText(failure === "unsupported" ? "does not support Web Audio" : "Audio device unavailable fixture");
    await expect(page.locator("#playback")).toBeHidden();
    await expect(page.locator("#read-url")).toBeEnabled();
    await expect(page.locator("#workspace")).toBeHidden();
  });
}
