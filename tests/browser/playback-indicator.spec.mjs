import { test, expect } from "@playwright/test";

// Synthetic WAV fixture exercises real Web Audio playback, not speech quality or HF availability.
function wav(seconds = 4) {
  const rate = 8000;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 220 * i / rate)), 44 + i * 2);
  return buffer;
}

for (const width of [1280, 390, 320]) {
  test(`equalizer animates only during playback, without status mutations: ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route("**/api/tts", (route) => route.fulfill({ contentType: "audio/wav", body: wav() }));
    await page.goto("/");
    const equalizer = page.locator(".status-equalizer");
    await expect(equalizer).toBeHidden();
    await page.locator("#paste-fallback").click();
    await page.locator("#text").fill("A short synthetic audio fixture exercises the playback indicator.");
    await page.locator("#read-start").click();
    await expect(page.locator("#status")).toHaveText("Playing");
    await expect(page.locator("#status")).toHaveClass("is-playing");
    await expect(equalizer).toBeVisible();
    await expect(equalizer).toHaveAttribute("aria-hidden", "true");
    await expect(equalizer.locator("span")).toHaveCount(4);
    await expect(page.locator(".status-spinner")).toBeHidden();
    const segments = await equalizer.locator("span").evaluateAll((bars) => bars.map((bar) => {
      const style = getComputedStyle(bar);
      return { width: bar.getBoundingClientRect().width, height: bar.getBoundingClientRect().height,
        background: style.backgroundImage, transform: style.transform, clip: style.clipPath };
    }));
    for (const segment of segments) {
      expect(segment.width).toBe(3);
      expect(segment.height).toBe(15);
      expect(segment.background).toContain("repeating-linear-gradient");
      expect(segment.background).toContain("3px");
      expect(segment.background).toContain("4px");
      expect(segment.transform).toBe("none");
      expect(segment.clip).toMatch(/^inset\((?:0px|(4|8|12)px 0px 0px)\)$/);
    }
    const rhythms = await equalizer.locator("span").evaluateAll((bars) => bars.map((bar) => {
      const style = getComputedStyle(bar);
      return { name: style.animationName, duration: style.animationDuration, timing: style.animationTimingFunction };
    }));
    expect(new Set(rhythms.map((rhythm) => rhythm.name)).size).toBe(4);
    expect(new Set(rhythms.map((rhythm) => rhythm.duration)).size).toBe(4);
    expect(rhythms.every((rhythm) => rhythm.timing === "steps(1)")).toBe(true);
    const motion = await page.locator("#status").evaluate(async (status) => {
      const bar = status.querySelector(".status-equalizer span");
      const before = getComputedStyle(bar).clipPath;
      const text = status.querySelector("#status-text").firstChild;
      const rect = status.getBoundingClientRect();
      let mutations = 0;
      const observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(status, { subtree: true, childList: true, characterData: true, attributes: true });
      await new Promise((resolve) => setTimeout(resolve, 250));
      observer.disconnect();
      return { before, after: getComputedStyle(bar).clipPath, mutations,
        sameText: text === status.querySelector("#status-text").firstChild,
        sameWidth: rect.width === status.getBoundingClientRect().width,
        levels: [...status.querySelectorAll(".status-equalizer span")].map((span) => getComputedStyle(span).clipPath),
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(motion.after).not.toBe(motion.before);
    expect(new Set(motion.levels).size).toBeGreaterThan(1);
    expect(motion.mutations).toBe(0);
    expect(motion.sameText).toBe(true);
    expect(motion.sameWidth).toBe(true);
    expect(motion.overflow).toBe(false);
    await page.screenshot({ path: test.info().outputPath(`equalizer-${width}.png`), fullPage: true });
    const transport = page.locator(".transport button");
    const buttonRects = (buttons) => buttons.map((button) => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return { x, y, width, height };
    });
    const playingRects = await transport.evaluateAll(buttonRects);
    const fall = await equalizer.evaluate(async (element) => {
      const bars = [...element.querySelectorAll("span")];
      // Freeze a known playback frame so the drop is deterministic.
      for (const bar of bars) for (const animation of bar.getAnimations()) {
        animation.pause();
        animation.currentTime = 0;
      }
      const initial = bars.map((bar) => getComputedStyle(bar).clipPath);
      document.querySelector("#pause").click();
      while (!element.parentElement.classList.contains("is-paused")) {
        await new Promise(requestAnimationFrame);
      }
      const animations = bars.map((bar) => bar.getAnimations()[0]);
      const from = animations.map((animation) => animation.effect.getKeyframes()[0].clipPath);
      const frames = [];
      const started = performance.now();
      while (performance.now() - started < 550) {
        frames.push(bars.map((bar) => Number.parseFloat(getComputedStyle(bar).clipPath.slice(6))));
        await new Promise(requestAnimationFrame);
      }
      return { initial, from, frames };
    });
    expect(fall.from).toEqual(fall.initial);
    expect(fall.frames.some((frame) => frame.some((level) => level > 0 && level < 12 && ![4, 8].includes(level)))).toBe(true);
    for (let i = 1; i < fall.frames.length; i++) {
      for (let bar = 0; bar < 4; bar++) expect(fall.frames[i][bar]).toBeGreaterThanOrEqual(fall.frames[i - 1][bar]);
    }
    expect(fall.frames.at(-1)).toEqual([12, 12, 12, 12]);
    await expect(page.locator("#status")).toHaveText("Paused");
    await expect(equalizer).toBeVisible();
    await expect(page.locator("#status")).toHaveClass("is-paused");
    expect(await transport.evaluateAll(buttonRects)).toEqual(playingRects);
    const paused = await equalizer.evaluate(async (element) => {
      const bars = [...element.querySelectorAll("span")];
      const snapshot = () => bars.map((bar) => ({
        clip: getComputedStyle(bar).clipPath, animation: getComputedStyle(bar).animationName,
      }));
      const before = snapshot();
      let mutations = 0;
      const observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(element.parentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      await new Promise((resolve) => setTimeout(resolve, 250));
      observer.disconnect();
      return { before, after: snapshot(), mutations, width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height };
    });
    expect(paused.before).toEqual(Array(4).fill({ clip: "inset(12px 0px 0px)", animation: "none" }));
    expect(paused.after).toEqual(paused.before);
    expect(paused.mutations).toBe(0);
    expect(paused.width).toBe(15);
    expect(paused.height).toBe(15);
    await page.screenshot({ path: test.info().outputPath(`equalizer-paused-${width}.png`), fullPage: true });
    const pausedElement = await equalizer.elementHandle();
    await page.locator("#pause").click();
    await expect(equalizer).toBeVisible();
    await expect(page.locator("#status")).toHaveClass("is-playing");
    expect(await transport.evaluateAll(buttonRects)).toEqual(playingRects);
    expect(await equalizer.evaluate((element, previous) => element === previous, pausedElement)).toBe(true);
    expect(await equalizer.locator("span").first().evaluate((bar) => getComputedStyle(bar).animationName)).toBe("status-levels-a");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await equalizer.locator("span").first().evaluate((bar) => getComputedStyle(bar).animationName)).toBe("none");
    const before = await equalizer.locator("span").first().evaluate((bar) => getComputedStyle(bar).clipPath);
    await page.waitForTimeout(250);
    expect(await equalizer.locator("span").first().evaluate((bar) => getComputedStyle(bar).clipPath)).toBe(before);
    await page.locator("#pause").click();
    await expect(page.locator("#status")).toHaveText("Paused");
    expect(await equalizer.locator("span").evaluateAll((bars) => bars.map((bar) => ({
      clip: getComputedStyle(bar).clipPath, animations: bar.getAnimations().length,
    })))).toEqual(Array(4).fill({ clip: "inset(12px 0px 0px)", animations: 0 }));
    await page.locator("#stop").click();
    await expect(page.locator("#status")).toHaveText("Stopped");
    await expect(equalizer).toBeHidden();
    await page.locator("#read-start").click();
    await expect(equalizer).toBeVisible();
    await expect(page.locator("#status")).toHaveText("Finished");
    await expect(equalizer).toBeHidden();
  });
}

test("equalizer hides during an underrun, returns with audio, and clears on error", async ({ page }) => {
  let calls = 0;
  let release;
  let fail;
  const pending = new Promise((resolve) => { release = resolve; });
  const failure = new Promise((resolve) => { fail = resolve; });
  await page.route("**/api/tts", async (route) => {
    calls++;
    if (calls === 1) await route.fulfill({ contentType: "audio/wav", body: wav(1) });
    else if (calls === 2) { await pending; await route.fulfill({ contentType: "audio/wav", body: wav(4) }); }
    else { await failure; await route.fulfill({ status: 502, json: { error: "Deliberate synthesis error fixture" } }); }
  });
  await page.goto("/");
  await page.locator("#paste-fallback").click();
  await page.locator("#text").fill("This sentence provides enough text to require multiple audio chunks. ".repeat(70));
  await page.locator("#read-start").click();
  await expect(page.locator(".status-equalizer")).toBeVisible();
  await expect(page.locator("#status")).toHaveText("Buffering…");
  await expect(page.locator(".status-equalizer")).toBeHidden();
  await page.locator("#pause").click(); // Hold production after the second in-flight result.
  release();
  await expect(page.locator("#first-audio")).not.toHaveText("—");
  await expect.poll(async () => Number.parseFloat(await page.locator("#buffer").textContent())).toBeGreaterThan(3);
  await expect(page.locator(".status-equalizer")).toBeVisible();
  await expect(page.locator("#status")).toHaveClass("is-paused");
  await page.locator("#pause").click();
  await expect(page.locator("#status")).toHaveText("Playing");
  await expect(page.locator(".status-equalizer")).toBeVisible();
  fail();
  await expect(page.locator("#status")).toContainText("Deliberate synthesis error fixture");
  await expect(page.locator(".status-equalizer")).toBeHidden();
  await expect(page.locator("#status")).not.toHaveClass(/is-playing|is-busy/);
});
