import { test, expect } from "@playwright/test";
import { paragraphs } from "../fixture.mjs";

// Instrument real Web Audio (not a mock) to verify decoded samples and scheduled continuity.
async function probe(page) {
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    window.__audio = { starts: [], decoded: [], context: null };
    window.AudioContext = class extends Original {
      constructor(...args) {
        super(...args);
        window.__audio.context = this;
        const decode = this.decodeAudioData.bind(this);
        this.decodeAudioData = async (...args) => {
          const buffer = await decode(...args);
          const samples = buffer.getChannelData(0);
          let sum = 0;
          for (const value of samples) sum += value * value;
          window.__audio.decoded.push({ duration: buffer.duration, rms: Math.sqrt(sum / samples.length) });
          return buffer;
        };
        const create = this.createBufferSource.bind(this);
        this.createBufferSource = () => {
          const source = create();
          const start = source.start.bind(source);
          source.start = (at) => { window.__audio.starts.push({ at, duration: source.buffer.duration }); start(at); };
          return source;
        };
      }
    };
  });
}

test("real public URL → Readability → Kokoro → continuously buffered playback", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await probe(page);
  await page.goto("/");
  await page.getByLabel("Webpage URL").fill("https://www.paulgraham.com/greatwork.html");
  await page.getByRole("button", { name: "Read article", exact: true }).click();
  await expect(page.locator("#article-title")).toHaveText("How to Do Great Work");
  await page.getByText("Buffer & playback details", { exact: true }).click();
  await expect(page.locator("#first-audio")).not.toHaveText("—", { timeout: 60_000 });
  await expect.poll(async () => Number.parseFloat(await page.locator("#buffer").innerText()), { timeout: 60_000 }).toBeGreaterThan(30);
  await expect.poll(async () => Number.parseInt(await page.locator("#progress").innerText()), { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
  const measurement = await page.evaluate(() => ({ starts: window.__audio.starts, decoded: window.__audio.decoded,
    state: window.__audio.context.state, firstAudio: document.querySelector("#first-audio").textContent,
    buffer: document.querySelector("#buffer").textContent, underruns: document.querySelector("#underruns").textContent,
    characters: document.querySelector("#text").value.length }));
  expect(measurement.state).toBe("running");
  expect(measurement.underruns).toBe("0");
  expect(measurement.decoded.length).toBeGreaterThan(2);
  for (const audio of measurement.decoded) expect(audio.rms).toBeGreaterThan(0.005);
  for (let i = 1; i < measurement.starts.length; i++) {
    expect(measurement.starts[i].at).toBeCloseTo(measurement.starts[i - 1].at + measurement.starts[i - 1].duration, 5);
  }
  console.log("LIVE ARTICLE METRICS", JSON.stringify(measurement));
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Paused");
  const pausedAt = await page.evaluate(() => window.__audio.context.currentTime);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__audio.context.currentTime)).toBe(pausedAt);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Playing");
  await page.screenshot({ path: test.info().outputPath("desktop-playing.png"), fullPage: true });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Stopped");
  await expect(page.getByRole("button", { name: "Read again", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("mobile layout, real text narration, stop/restart and natural completion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await probe(page);
  await page.goto("/");
  await page.locator("#paste-fallback").click();
  await page.getByLabel("Extracted or pasted text").fill(paragraphs.join("\n\n"));
  await page.locator("#read-start").click();
  await expect(page.locator("#first-audio")).not.toHaveText("—", { timeout: 60_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-playing.png"), fullPage: true });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Stopped");
  await expect(page.locator("#read-start")).toHaveText("Read again");
  await page.screenshot({ path: test.info().outputPath("mobile-stopped.png"), fullPage: true });
  await page.locator("#paste-fallback").click();
  await page.getByLabel("Extracted or pasted text").fill("This is a short test of the article reader. Thank you for listening.");
  await page.locator("#read-start").click();
  await expect(page.locator("#status")).toHaveText("Finished", { timeout: 30_000 });
  expect(await page.evaluate(() => window.__audio.context.state)).toBe("closed");
});

test("playback ticks preserve unchanged text nodes and disabled attributes", async ({ page }) => {
  await page.goto("/");
  await page.locator("#paste-fallback").click();
  await page.getByLabel("Extracted or pasted text").fill(paragraphs[0]);
  await page.locator("#read-start").click();
  await expect(page.locator("#status")).toHaveText("Playing", { timeout: 30_000 });

  const observe = () => page.evaluate(async () => {
    const ids = ["status", "pause", "progress", "first-audio", "underruns"];
    const elements = ids.map((id) => document.getElementById(id));
    const children = elements.map((element) => element.firstChild);
    const mutations = [];
    const observer = new MutationObserver((records) => mutations.push(...records.map((record) => record.type)));
    for (const element of elements) observer.observe(element, { childList: true, characterData: true, subtree: true });
    for (const id of ["read-start", "read-url", "paste-fallback", "voice", "speed", "url", "text", "pause", "stop"]) {
      observer.observe(document.getElementById(id), { attributes: true, attributeFilter: ["disabled"] });
    }
    const bufferBefore = document.getElementById("buffer").textContent;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    observer.disconnect();
    return { mutations, sameTextNodes: elements.every((element, i) => element.firstChild === children[i]),
      bufferBefore, bufferAfter: document.getElementById("buffer").textContent };
  });

  const playing = await observe();
  expect(playing.mutations).toEqual([]);
  expect(playing.sameTextNodes).toBe(true);
  expect(playing.bufferAfter).not.toBe(playing.bufferBefore);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Paused");
  const paused = await observe();
  expect(paused.mutations).toEqual([]);
  expect(paused.sameTextNodes).toBe(true);
  expect(paused.bufferAfter).toBe(paused.bufferBefore);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Playing");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Stopped");
});

test("simulated startup 503s show waking status and recover into real audio", async ({ page }) => {
  await probe(page);
  let calls = 0;
  await page.route("**/api/tts", async (route) => {
    calls++;
    if (calls <= 2) await route.fulfill({ status: 503, contentType: "application/json", headers: { "Retry-After": "1" },
      body: JSON.stringify({ code: "INFERENCE_UNAVAILABLE", error: "Simulated startup" }) });
    else await route.continue(); // Actual backend/Kokoro WAV, not synthetic audio.
  });
  await page.goto("/");
  await page.locator("#paste-fallback").click();
  await page.getByLabel("Extracted or pasted text").fill("The speech engine can wake up and read this sentence.");
  await page.locator("#read-start").click();
  await expect(page.locator("#status")).toHaveText("Speech engine is waking up…");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("waking-up.png"), fullPage: true });
  await expect(page.locator("#first-audio")).not.toHaveText("—", { timeout: 30_000 });
  expect(calls).toBe(3);
  expect(await page.evaluate(() => window.__audio.decoded[0].rms)).toBeGreaterThan(0.005);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Stopped");
});

test("first-audio generation shares the spinner and clears it for playback", async ({ page }) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/tts", async (route) => { await pending; await route.continue(); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#paste-fallback").click();
  await page.getByLabel("Extracted or pasted text").fill("The reader shows a spinner while generating this first sentence.");
  await page.locator("#read-start").click();
  await expect(page.locator("#status")).toHaveText("Generating first audio…");
  await expect(page.locator("#status")).toHaveClass("is-busy");
  expect(await page.locator("#status").evaluate((element) => getComputedStyle(element.querySelector(".status-spinner"), "::before").animationName)).toBe("status-dots");
  await page.screenshot({ path: test.info().outputPath("mobile-generating-spinner.png"), fullPage: true });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Paused");
  await expect(page.locator("#status")).not.toHaveClass("is-busy");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator("#status")).toHaveClass("is-busy");
  release(); // Release the test-only delay; synthesis and audio are real.
  await expect(page.locator("#status")).toHaveText("Playing", { timeout: 30_000 });
  await expect(page.locator("#status")).not.toHaveClass("is-busy");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});

test("waking spinner animates without live-region mutations and respects reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/tts", (route) => route.fulfill({ status: 503, contentType: "application/json", headers: { "Retry-After": "5" },
    body: JSON.stringify({ code: "INFERENCE_UNAVAILABLE" }) }));
  await page.goto("/");
  await page.locator("#paste-fallback").click();
  await page.getByLabel("Extracted or pasted text").fill("This request deliberately simulates a sleeping endpoint.");
  await page.locator("#read-start").click();
  await expect(page.locator("#status")).toHaveText("Speech engine is waking up…");
  await expect(page.locator("#status")).toHaveClass("is-busy");
  await expect(page.locator(".status-spinner")).toHaveAttribute("aria-hidden", "true");
  const animation = await page.locator("#status").evaluate(async (element) => {
    const before = getComputedStyle(element.querySelector(".status-spinner"), "::before").content;
    const textNode = element.firstChild;
    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true });
    await new Promise((resolve) => setTimeout(resolve, 550));
    observer.disconnect();
    return { name: getComputedStyle(element.querySelector(".status-spinner"), "::before").animationName, before,
      after: getComputedStyle(element.querySelector(".status-spinner"), "::before").content, mutations, sameTextNode: textNode === element.firstChild };
  });
  expect(animation.name).toBe("status-dots");
  expect(animation.after).not.toBe(animation.before);
  expect(animation.mutations).toBe(0);
  expect(animation.sameTextNode).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-status-spinner.png"), fullPage: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator("#status").evaluate((element) => getComputedStyle(element.querySelector(".status-spinner"), "::before").animationName)).toBe("none");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Paused");
  await expect(page.locator("#status")).not.toHaveClass("is-busy");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator("#status")).toHaveClass("is-busy");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Stopped");
  await expect(page.locator("#status")).not.toHaveClass("is-busy");
});

test("Stop during simulated startup cancels retry wait and permits a fresh session", async ({ page }) => {
  let calls = 0;
  let starting = true;
  await page.route("**/api/tts", async (route) => {
    calls++;
    if (starting) await route.fulfill({ status: 503, contentType: "application/json", headers: { "Retry-After": "2" },
      body: JSON.stringify({ code: "INFERENCE_UNAVAILABLE" }) });
    else await route.continue();
  });
  await page.goto("/");
  await page.locator("#paste-fallback").click();
  await page.getByLabel("Extracted or pasted text").fill("Stop cancels waiting for the speech engine.");
  await page.locator("#read-start").click();
  await expect(page.locator("#status")).toHaveText("Speech engine is waking up…");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Stopped");
  const stoppedCalls = calls;
  await page.waitForTimeout(2300);
  expect(calls).toBe(stoppedCalls);
  starting = false;
  await page.locator("#read-start").click();
  await expect(page.locator("#status")).toHaveText("Finished", { timeout: 30_000 });
});

test("private URL is blocked and extraction failure can recover with pasted text", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Webpage URL").fill("http://127.0.0.1/secret");
  await page.getByRole("button", { name: "Read article", exact: true }).click();
  await expect(page.locator("#status")).toContainText("not allowed");
  await expect(page.locator("#read-url")).toBeEnabled();
  await expect(page.locator("#fallback-advice")).toBeVisible();
  await expect(page.locator("#article-panel")).toBeHidden();
  await page.route("**/api/tts", (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Kokoro is unavailable." }) }));
  await page.locator("#paste-fallback").click();
  await page.getByLabel("Extracted or pasted text").fill("An article can still be pasted here after a failed extraction.");
  await page.locator("#read-start").click();
  await expect(page.locator("#status")).toContainText("Kokoro is unavailable.");
});
