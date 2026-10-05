import { test, expect } from "@playwright/test";

const articleText = "Listening should be simple. All the controls belong together, so you can pause, continue where you left off, or stop and start again from the beginning.";

test("URL auto-start, pause/resume, Stop → Read again generates the editor text without refetching", async ({ page }) => {
  let extractions = 0;
  const requests = [];
  // Extraction fixture only: speech still uses the actual backend and Kokoro.
  await page.route("**/api/article", (route) => {
    extractions++;
    return route.fulfill({ json: { title: "A simpler listening space", byline: "Reader fixture", url: "https://example.com/article", text: articleText } });
  });
  await page.route("**/api/streaming", (route) => {
    requests.push(route.request().postDataJSON());
    return route.continue();
  });
  await page.goto("/");
  await expect(page.locator("#workspace")).toBeHidden();
  await page.getByLabel("Webpage URL").fill("https://example.com/article");
  await page.getByLabel("Webpage URL").press("Enter");
  await expect(page.locator("#status")).toHaveText("Playing", { timeout: 60_000 });
  await expect(page.locator("#text")).toHaveValue(articleText);
  await expect(page.locator("#paste-fallback")).toBeDisabled();
  await expect(page.getByRole("group", { name: "Playback controls" }).getByRole("button")).toHaveCount(3);
  await expect(page.locator("#article-body")).toHaveText(articleText);
  await page.locator("#pause").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#status")).toHaveText("Paused");
  await expect(page.locator("#pause")).toHaveText("Resume");
  expect(requests).toHaveLength(1);
  await page.keyboard.press("Space");
  await expect(page.locator("#status")).toHaveText("Playing");
  expect(requests).toHaveLength(1);
  await page.locator("#stop").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#read-start")).toBeFocused();
  await expect(page.locator("#read-start")).toHaveText("Read again");
  await expect(page.locator("#playback-hint")).toHaveCount(0);
  await expect(page.locator("#pause")).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("desktop-stopped.png"), fullPage: true });
  await page.keyboard.press("Enter");
  await expect(page.locator("#status")).toHaveText("Playing", { timeout: 60_000 });
  expect(extractions).toBe(1);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Stopped");
  const edited = "Edited text is used for the next narration, rather than saved audio.";
  await page.locator("#editor-summary").click();
  await page.locator("#text").fill(edited);
  await page.locator("#read-start").click();
  await expect(page.locator("#status")).toHaveText("Finished", { timeout: 30_000 });
  expect(requests[2].text).toBe(edited);
  expect(extractions).toBe(1);
});

test("URL-first landing, fallback and compact settings are keyboard reachable at desktop/mobile widths", async ({ page }) => {
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator(".eyebrow")).toHaveText("Article Reader · Your listening desk");
    await expect(page.locator("#page-title")).toHaveText("Give a good article your full attention.");
    expect((await page.locator("#page-title").innerText()).split("\n").map((line) => line.trim())).toEqual(["Give a good article", "your full attention."]);
    const headlineLines = await page.locator("#page-title").evaluate((heading) => [...heading.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .flatMap((node) => { const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()].filter((rect) => rect.width > 1); }).length);
    expect(headlineLines).toBe(2);
    await expect(page.locator("#url")).toBeVisible();
    await expect(page.locator("#read-url")).toBeVisible();
    await expect(page.locator("#text")).toBeHidden();
    await expect(page.locator("#article-panel")).toBeHidden();
    await expect(page.locator("#listening-card")).toBeHidden();
    await expect(page.getByText("Ready when you are.", { exact: true })).toHaveCount(0);
    await expect(page.locator("#voice-settings summary")).toHaveText("Heart · 1×");
    await expect(page.locator("#playback")).toBeHidden();
    await expect(page.locator("#diagnostics")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`landing-${width}.png`), fullPage: true });
    await page.locator("#url").fill("not-a-valid-url");
    await page.locator("#paste-fallback").focus();
    await page.keyboard.press("Space");
    await expect(page.locator("#text")).toBeFocused();
    await expect(page.locator("#editor")).toHaveAttribute("open", "");
    await expect(page.locator("#playback-hint")).toHaveCount(0);
    await expect(page.locator('[aria-describedby~="playback-hint"]')).toHaveCount(0);
    await expect(page.locator("#article-panel")).toBeHidden();
    await page.locator("#read-start").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#status")).toContainText("Enter some text first");
    await page.locator("#voice-settings summary").focus();
    await expect(page.locator("#voice-settings summary")).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(page.locator("#voice")).toBeFocused();
    await page.locator("#voice").selectOption("af_bella");
    await page.locator("#speed").selectOption("1.2");
    await expect(page.locator("#settings-summary")).toHaveText("Bella · 1.2×");
    await page.locator("#text").fill("Pasted text is a fallback, not an extracted article.");
    await expect(page.locator("#read-start")).toHaveText("Read text");
    await expect(page.locator("#article-panel")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator("#workspace")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: test.info().outputPath(`fallback-${width}.png`), fullPage: true });
  }
});

test("listening card keeps its responsive width when playback details are toggled", async ({ page }) => {
  await page.route("**/api/article", (route) => route.abort());
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.locator("#paste-fallback").click();
    // Show the real diagnostics markup without requiring speech inference.
    await page.locator("#diagnostics").evaluate((details) => { details.hidden = false; });
    await expect(page.locator("#diagnostics")).toHaveCSS("border-top-width", "0px");
    const card = page.locator("#listening-card");
    const closedWidth = (await card.boundingBox()).width;
    const readerWidth = (await page.locator("#reader").boundingBox()).width;
    expect(closedWidth).toBeCloseTo(Math.min(700, readerWidth), 0);
    await page.locator("#diagnostics summary").click();
    expect((await card.boundingBox()).width).toBeCloseTo(closedWidth, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator("#diagnostics summary").click();
    expect((await card.boundingBox()).width).toBeCloseTo(closedWidth, 0);
  }
});

test("Stop during URL extraction cancels the pending article and keeps URL retry discoverable", async ({ page }) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/article", async (route) => {
    await pending;
    await route.fulfill({ json: { title: "Late article", byline: "", url: "https://example.com", text: articleText } }).catch(() => {});
  });
  await page.goto("/");
  await page.locator("#url").fill("https://example.com");
  await page.locator("#read-url").click();
  await expect(page.locator("#listening-card")).toBeVisible();
  await expect(page.locator("#status")).toHaveText("Fetching and extracting article…");
  await expect(page.locator("#article-panel")).toBeHidden();
  await expect(page.locator("#reader")).not.toHaveClass("is-revealed");
  await expect(page.locator("#pause")).toBeDisabled();
  await page.locator("#stop").click();
  await expect(page.locator("#read-url")).toHaveText("Read");
  await expect(page.locator("#read-url")).toBeFocused();
  await expect(page.locator("#playback")).toBeHidden();
  release();
  await page.waitForTimeout(300);
  await expect(page.locator("#text")).toHaveValue("");
  await expect(page.locator("#status")).toHaveText("Stopped");
});
