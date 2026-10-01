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
  await expect(page.getByRole("button", { name: "Read article", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("mobile layout, real text narration, stop/restart and natural completion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await probe(page);
  await page.goto("/");
  await page.getByLabel("Extracted or pasted text").fill(paragraphs.join("\n\n"));
  await page.getByRole("button", { name: "Read text", exact: true }).click();
  await expect(page.locator("#first-audio")).not.toHaveText("—", { timeout: 60_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-playing.png"), fullPage: true });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Stopped");
  await page.getByLabel("Extracted or pasted text").fill("This is a short test of the article reader. Thank you for listening.");
  await page.getByRole("button", { name: "Read text", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Finished", { timeout: 30_000 });
  expect(await page.evaluate(() => window.__audio.context.state)).toBe("closed");
});

test("playback ticks preserve unchanged text nodes and disabled attributes", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Extracted or pasted text").fill(paragraphs[0]);
  await page.getByRole("button", { name: "Read text", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Playing", { timeout: 30_000 });

  const observe = () => page.evaluate(async () => {
    const ids = ["status", "pause", "progress", "first-audio", "underruns"];
    const elements = ids.map((id) => document.getElementById(id));
    const children = elements.map((element) => element.firstChild);
    const mutations = [];
    const observer = new MutationObserver((records) => mutations.push(...records.map((record) => record.type)));
    for (const element of elements) observer.observe(element, { childList: true, characterData: true, subtree: true });
    for (const id of ["read-url", "read-text", "voice", "speed", "url", "text", "pause", "stop"]) {
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

test("private URL is blocked and extraction failure can recover with pasted text", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Webpage URL").fill("http://127.0.0.1/secret");
  await page.getByRole("button", { name: "Read article", exact: true }).click();
  await expect(page.locator("#status")).toContainText("not allowed");
  await expect(page.getByRole("button", { name: "Read text", exact: true })).toBeEnabled();
  await page.route("**/api/tts", (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Kokoro is unavailable." }) }));
  await page.getByLabel("Extracted or pasted text").fill("An article can still be pasted here after a failed extraction.");
  await page.getByRole("button", { name: "Read text", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Kokoro is unavailable.");
});
