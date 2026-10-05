import { test, expect } from "@playwright/test";
import { mockNarration, deferred } from "./narration-fixture.mjs";

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
    // SYNTHETIC/UI-only startup status; no claim about provider retries.
    const mediaGate = deferred();
    await mockNarration(page, { state: "generating", generated: 0, warming: true, mediaGate });
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
    await expect(page.locator(".eyebrow")).toBeVisible();
    await expect(page.locator("#page-title")).toBeVisible();
    release();
    await expect(page.locator("#article-panel")).toBeVisible();
    await expect(page.locator("#article-title")).toHaveText(article.title);
    await expect(page.locator("#article-body")).toHaveText(article.text);
    await expect(page.locator("#text")).toBeHidden();
    const motion = await page.evaluate(() => window.__motion);
    const finalTop = motion.tops.at(-1);
    await expect(page.locator(".eyebrow")).toBeHidden();
    await expect(page.locator("#page-title")).toBeHidden();
    await expect(page.locator(".intro")).toBeHidden();
    expect((await page.locator(".hero-copy").boundingBox()).height).toBeLessThan(1);
    const readerBox = await page.locator("#reader").boundingBox();
    const urlBox = await page.locator("#url-form").boundingBox();
    const cardBox = await page.locator("#listening-card").boundingBox();
    const articleBox = await page.locator("#article-panel").boundingBox();
    const editorBox = await page.locator("#editor").boundingBox();
    expect(urlBox.width).toBeCloseTo(Math.min(800, readerBox.width), 0);
    expect(cardBox.width).toBeCloseTo(Math.min(700, readerBox.width), 0);
    for (const box of [articleBox, editorBox]) {
      expect(box.width).toBeCloseTo(cardBox.width, 0);
      expect(box.x).toBeCloseTo(cardBox.x, 0);
    }
    expect(urlBox.x + urlBox.width / 2).toBeCloseTo(cardBox.x + cardBox.width / 2, 0);
    const bodyBox = await page.locator("#article-body").boundingBox();
    expect(bodyBox.y).toBeLessThan(page.viewportSize().height - 50);
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
    await expect(page.locator("#status")).toHaveText("Stopped");
    mediaGate.resolve();
    await expect(page.locator("#read-start")).toBeFocused();
    await expect(page.locator("#read-start")).toHaveText("Read again");
  });
}

test("extraction error keeps the landing intact and offers a keyboard-accessible manual fallback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/article", (route) => route.fulfill({ status: 422, json: { error: "No readable article found on this page." } }));
  await page.route("**/api/streaming", (route) => route.fulfill({ status: 502, json: { error: "Deliberate speech error fixture" } }));
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
