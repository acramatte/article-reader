import { test, expect } from "@playwright/test";

const catalogs = {
  pocket: [
    { value: "jane", name: "Jane", group: "American English · Female" },
    { value: "bill_boerst", name: "Bill Boerst", group: "American English · Male" },
    { value: "estelle", name: "Estelle", group: "French · Female" },
  ],
  kokoro: [
    { value: "af_heart", name: "Heart", group: "American English · Female" },
    { value: "am_michael", name: "Michael", group: "American English · Male" },
    { value: "ff_siwis", name: "Siwis", group: "French · Female" },
  ],
};
const engine = process.env.TTS_ENGINE || "pocket";
const voices = catalogs[engine];

test(`reader and diagnostic page expose the same three language-labelled ${engine} voices`, async ({ page }) => {
  for (const path of ["/", "/streaming.html"]) {
    await page.goto(path);
    await expect(page.locator("#voice option")).toHaveCount(3);
    await expect(page.locator("#voice")).toBeEnabled();
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

test("loading or unavailable speech settings keep narration disabled without a fallback catalog", async ({ page }) => {
  for (const path of ["/", "/streaming.html"]) {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await page.route("**/api/config", async route => {
      await pending;
      return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    });
    await page.goto(path);
    try {
      await expect(page.locator(path === "/" ? "#read-url" : "#start")).toBeDisabled();
      await expect(page.locator("#voice option")).toHaveCount(0);
    } finally { release(); }
    await expect(page.locator(path === "/" ? "#status-text" : "#status")).toContainText("Reload to retry");
    await expect(page.locator(path === "/" ? "#read-url" : "#start")).toBeDisabled();
    await expect(page.locator("#voice")).toBeDisabled();
    await expect(page.locator("#voice option")).toHaveCount(0);
    if (path === "/") {
      await expect(page.locator("#settings-summary")).toHaveText("Voices unavailable");
      await page.locator("#paste-fallback").click();
      await page.locator("#text").fill("Text can be edited while speech settings are unavailable.");
      await expect(page.locator("#read-start")).toBeDisabled();
    }
    await page.unroute("**/api/config");
  }
});

for (const { value, name, group } of voices.slice(1)) {
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
    const text = group.startsWith("French")
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
