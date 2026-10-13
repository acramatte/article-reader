import { test, expect } from "./csp-fixture.mjs";
import { mockNarration, startPasted } from "./narration-fixture.mjs";

// SYNTHETIC/UI-only: sentence offsets and times are given by the fixture, not derived from speech.
const highlighted = page => page.evaluate(() => [...(CSS.highlights.get("narration") ?? [])].map(range => range.toString()));
const seek = (page, seconds) => page.locator("#narration-audio").evaluate((audio, at) => { audio.pause(); audio.currentTime = at; }, seconds);

function timeline(sentences, seconds) {
  let start = 0;
  const text = sentences.join(" ");
  const ranges = sentences.map(sentence => {
    const range = [text.indexOf(sentence, start), text.indexOf(sentence, start) + sentence.length];
    start = range[1];
    return range;
  });
  const step = seconds / sentences.length;
  return { text, sentences: ranges, timings: ranges.map((_, i) => [i * step, (i + 1) * step]) };
}

test("pasted text is shown in the article panel and the narrated sentence is highlighted", async ({ page }) => {
  const sentences = ["The first sentence is short.", "Then a second one follows.", "Finally the third ends it."];
  const { text, ...plan } = timeline(sentences, 12);
  await mockNarration(page, { seconds: 12, ...plan });
  await startPasted(page, text);
  await expect(page.locator("#article-panel")).toBeVisible();
  await expect(page.locator("#article-title")).toHaveText("Pasted text");
  await expect(page.locator("#byline")).toBeHidden();
  await expect(page.locator("#source")).toBeHidden();
  await expect(page.locator("#article-body")).toHaveText(text);
  await expect(page.locator("#editor")).not.toHaveAttribute("open", "");
  await expect(page.locator("#status")).toHaveText("Playing");
  await expect.poll(() => highlighted(page)).toEqual([sentences[0]]);
  await seek(page, 5);
  await expect.poll(() => highlighted(page)).toEqual([sentences[1]]);
  await seek(page, 9);
  await expect.poll(() => highlighted(page)).toEqual([sentences[2]]);
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Stopped");
  expect(await highlighted(page)).toEqual([]);
});

test("auto-follow keeps the sentence in view inside the article body and pauses after user scrolling", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); // Instant scrolling keeps the checks deterministic.
  const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i + 1} adds another line of text to read.`);
  const { text, ...plan } = timeline(sentences, 12);
  await mockNarration(page, { seconds: 12, ...plan });
  await startPasted(page, text);
  await expect(page.locator("#status")).toHaveText("Playing");
  const body = page.locator("#article-body");
  const pageScroll = await page.evaluate(() => scrollY);
  await seek(page, 11);
  await expect.poll(() => highlighted(page)).toEqual([sentences[55]]);
  const visible = () => page.evaluate(() => {
    const box = document.querySelector("#article-body").getBoundingClientRect();
    const rect = [...CSS.highlights.get("narration")][0].getBoundingClientRect();
    return rect.top >= box.top && rect.bottom <= box.bottom;
  });
  await expect.poll(visible).toBe(true);
  expect(await page.evaluate(() => scrollY)).toBe(pageScroll); // Only the article body scrolls.
  const followed = await body.evaluate(element => element.scrollTop);
  expect(followed).toBeGreaterThan(0);
  await body.hover();
  await page.mouse.wheel(0, -200);
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeLessThan(followed);
  const userScroll = await body.evaluate(element => element.scrollTop);
  await seek(page, 1);
  await expect.poll(() => highlighted(page)).toEqual([sentences[5]]);
  expect(await body.evaluate(element => element.scrollTop)).toBe(userScroll);
});
