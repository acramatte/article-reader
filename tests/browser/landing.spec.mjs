import { test, expect } from "@playwright/test";

const article = { title: "The article behind the link", byline: "Extraction fixture", url: "https://example.com/article", text: "Only reveal actual extracted content. This fixture checks the layout transition, not speech quality." };

for (const [width, reducedMotion] of [[1280, "no-preference"], [390, "no-preference"], [320, "no-preference"], [390, "reduce"]]) {
  test(`successful extraction moves the URL upward with focus preserved: ${width}px, ${reducedMotion}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion });
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/article", async (route) => {
      await pending;
      await route.fulfill({ json: article });
    });
    // Explicit startup fixture avoids relying on synthesis latency for motion measurements.
    await page.route("**/api/tts", (route) => route.fulfill({ status: 503, json: { code: "INFERENCE_UNAVAILABLE" }, headers: { "Retry-After": "5" } }));
    await page.goto("/");
    await page.locator("#url").fill(article.url);
    await page.evaluate(() => {
      const url = document.getElementById("url");
      window.__urlInput = url;
      window.__motion = new Promise((resolve) => {
        const reader = document.getElementById("reader");
        const before = url.getBoundingClientRect().top;
        const observer = new MutationObserver(() => {
          if (!reader.classList.contains("is-revealed")) return;
          observer.disconnect();
          const tops = [];
          const overflow = [];
          const started = performance.now();
          const sample = () => {
            tops.push(url.getBoundingClientRect().top);
            overflow.push(document.documentElement.scrollWidth > innerWidth);
            if (performance.now() - started < 800) requestAnimationFrame(sample);
            else resolve({ before, tops, overflow, focused: document.activeElement === url, sameInput: window.__urlInput === document.getElementById("url"), scrollY,
              transitionDuration: getComputedStyle(document.querySelector(".hero")).transitionDuration,
              animationName: getComputedStyle(document.getElementById("workspace")).animationName });
          };
          requestAnimationFrame(sample);
        });
        observer.observe(reader, { attributes: true, attributeFilter: ["class"] });
      });
    });
    await page.locator("#url").press("Enter");
    await expect(page.locator("#status")).toHaveText("Fetching and extracting article…");
    await expect(page.locator("#article-panel")).toBeHidden();
    await expect(page.locator("#workspace")).toBeHidden();
    await expect(page.locator("#article-title")).toHaveText("");
    await expect(page.locator("#url")).toBeFocused();
    release();
    await expect(page.locator("#article-panel")).toBeVisible();
    await expect(page.locator("#article-title")).toHaveText(article.title);
    await expect(page.locator("#article-body")).toHaveText(article.text);
    await expect(page.locator("#text")).toBeHidden();
    const motion = await page.evaluate(() => window.__motion);
    const finalTop = motion.tops.at(-1);
    await expect(page.locator(".eyebrow")).toHaveText("Article Reader · Your listening desk");
    await expect(page.locator("#page-title")).toHaveText("Give a good article your full attention.");
    expect((await page.locator("#page-title").innerText()).split("\n").map((line) => line.trim())).toEqual(["Give a good article", "your full attention."]);
    const headlineLines = await page.locator("#page-title").evaluate((heading) => [...heading.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .flatMap((node) => { const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()].filter((rect) => rect.width > 1); }).length);
    expect(headlineLines).toBe(2);
    expect(finalTop).toBeLessThan(motion.before - 30);
    expect(motion.focused).toBe(true);
    expect(motion.sameInput).toBe(true);
    expect(motion.scrollY).toBe(0);
    expect(motion.overflow.every((value) => !value)).toBe(true);
    if (reducedMotion === "reduce") {
      expect(motion.transitionDuration).toBe("0s");
      expect(motion.animationName).toBe("none");
      expect(motion.tops.every((top) => Math.abs(top - finalTop) < 1)).toBe(true);
    } else {
      expect(new Set(motion.tops.map((top) => Math.round(top))).size).toBeGreaterThan(4);
      expect(motion.tops.some((top) => top > finalTop + 10 && top < motion.before - 10)).toBe(true);
    }
    console.log("REVEAL MOTION", JSON.stringify({ width, reducedMotion, before: motion.before, finalTop, frames: motion.tops.length, focusPreserved: motion.focused }));
    await page.screenshot({ path: test.info().outputPath(`revealed-${width}-${reducedMotion}.png`), fullPage: true });
    await page.locator("#stop").click();
    await expect(page.locator("#read-start")).toBeFocused();
    await expect(page.locator("#read-start")).toHaveText("Read again");
  });
}

test("extraction error keeps the landing intact and offers a keyboard-accessible manual fallback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/article", (route) => route.fulfill({ status: 422, json: { error: "No readable article found on this page." } }));
  await page.route("**/api/tts", (route) => route.fulfill({ status: 502, json: { error: "Deliberate speech error fixture" } }));
  await page.goto("/");
  await page.locator("#url").fill(article.url);
  await page.locator("#read-url").click();
  await expect(page.locator("#listening-card")).toBeVisible();
  await expect(page.locator("#status")).toContainText("No readable article found");
  await expect(page.locator("#reader")).not.toHaveClass("is-revealed");
  await expect(page.locator("#article-panel")).toBeHidden();
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(page.locator("#fallback-advice")).toBeVisible();
  await expect(page.locator("#playback")).toBeHidden();
  await expect(page.locator("#paste-fallback")).toHaveClass(/recommended/);
  await page.screenshot({ path: test.info().outputPath("mobile-extraction-error.png"), fullPage: true });
  await page.locator("#url").fill("invalid retained URL");
  await page.locator("#paste-fallback").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#text")).toBeFocused();
  await page.locator("#text").fill("Manual text works independently of the invalid retained URL.");
  await page.locator("#read-start").click();
  await expect(page.locator("#listening-card")).toBeVisible();
  await expect(page.locator("#fallback-advice")).toBeHidden();
  await expect(page.locator("#status")).toContainText("Deliberate speech error fixture");
  await expect(page.locator("#article-panel")).toBeHidden();
  await expect(page.locator("#read-start")).toBeEnabled();
});
