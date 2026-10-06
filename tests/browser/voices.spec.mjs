import { test, expect } from "@playwright/test";

const voices = [
  { value: "af_heart", name: "Heart", group: "American English · Female" },
  { value: "af_nicole", name: "Nicole", group: "American English · Female" },
  { value: "am_michael", name: "Michael", group: "American English · Male" },
  { value: "ff_siwis", name: "Siwis", group: "French · Female" },
];

test("reader and diagnostic page expose the same language-labelled voices without Bella", async ({ page }) => {
  for (const path of ["/", "/streaming.html"]) {
    await page.goto(path);
    if (path === "/") {
      await page.locator("#voice-settings summary").click();
      await page.screenshot({ path: test.info().outputPath("voices-desktop.png"), fullPage: true });
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("voices-mobile.png"), fullPage: true });
    }
    expect(await page.locator("#voice option").evaluateAll(options => options.map(option => ({
      value: option.value, name: option.textContent, group: option.parentElement.label,
    })))).toEqual(voices);
    for (const { value, name } of voices) {
      await page.locator("#voice").selectOption(value);
      await expect(page.locator("#voice")).toHaveValue(value);
      if (path === "/") await expect(page.locator("#settings-summary")).toHaveText(`${name} · 1×`);
    }
  }
});

for (const { value, name } of voices.filter(voice => ["am_michael", "ff_siwis"].includes(voice.value))) {
  test(`${name} produces real playable speech from the selected voice`, async ({ page }) => {
    const requests = [];
    await page.route("**/api/streaming", route => {
      requests.push(route.request().postDataJSON());
      return route.continue();
    });
    await page.goto("/");
    await page.locator("#voice-settings summary").click();
    await page.locator("#voice").selectOption(value);
    await expect(page.locator("#settings-summary")).toHaveText(`${name} · 1×`);
    await page.locator("#paste-fallback").click();
    const text = value === "ff_siwis"
      ? "Bonjour, cet article est lu en français. Nous pouvons écouter cette histoire avec une voix française."
      : "Hello, this article is read in English. We can listen to this story with an American male voice.";
    await page.locator("#text").fill(text);
    await page.locator("#read-start").click();
    await expect(page.locator("#status")).toHaveText("Playing", { timeout: 60_000 });
    await expect.poll(() => page.locator("#narration-audio").evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
    expect(requests).toEqual([{ text, voice: value, speed: 1, title: "Pasted text", byline: "" }]);
    await page.locator("#stop").click();
    await expect(page.locator("#status")).toHaveText("Stopped");
  });
}
