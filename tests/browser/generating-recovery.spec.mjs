import { test, expect } from "./csp-fixture.mjs";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { createApp } from "../../server.mjs";
import { BOOKMARK_KEY } from "./narration-fixture.mjs";

// SYNTHETIC tones through the real backend, FFmpeg MP3 encoder and native Chromium decoding.
// This covers media transport for a far bookmark, not speech quality.
const chunkSeconds = 10;
const generatedChunks = 30; // 300 s of audio exists; the next chunk waits for the test.
const position = 290;
const throttleBytesPerSecond = 12 * 1024; // A 290 s MP3 prefix (about 2.3 MB) would take over three minutes.

function tone(seconds) {
  const samples = seconds * 24_000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(3000 * Math.sin(i * 2 * Math.PI * 440 / 24_000)), 44 + i * 2);
  return wav;
}

let server, base, staticDir, spoolDir, gate, release, synthesized;
test.beforeAll(async () => {
  staticDir = await mkdtemp(join(tmpdir(), "reader-recovery-ui-"));
  spoolDir = await mkdtemp(join(tmpdir(), "reader-recovery-spool-"));
  await build({ root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "silent",
    build: { outDir: staticDir, emptyOutDir: true } });
  const wav = tone(chunkSeconds);
  server = createApp({ staticDir, spoolDir, synthesizeChunk: async () => {
    if (++synthesized > generatedChunks) await gate;
    return wav;
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  release?.();
  await server?.shutdown();
  await Promise.all([staticDir, spoolDir].filter(Boolean).map(path => rm(path, { recursive: true, force: true })));
});

const pages = [
  { name: "diagnostic page", path: "/streaming.html", restored: ["#status", /Recording restored at 290\.0 seconds/], resume: "#resume" },
  { name: "reader", path: "/", restored: ["#status-text", "Saved recording ready. Press Resume."], resume: "#pause" },
];

for (const target of pages) {
  test(`${target.name} restores a far position in a still-generating recording without downloading its prefix`, async ({ page }) => {
    synthesized = 0;
    gate = new Promise(resolve => { release = resolve; });
    const text = Array.from({ length: generatedChunks + 5 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
    const created = await fetch(`${base}/api/streaming`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: "jane", speed: 1 }) }).then(response => response.json());
    const status = () => fetch(`${base}/api/streaming/${created.id}/status`).then(response => response.json());
    try {
      await expect.poll(async () => (await status()).audioSecondsGenerated, { timeout: 30_000 }).toBe(generatedChunks * chunkSeconds);
      await restoreFarPosition(page, target, created.id, status);
    } finally {
      release();
      await fetch(`${base}/api/streaming/${created.id}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    }
  });
}

async function restoreFarPosition(page, target, id, status) {
  const audioRequests = [];
  let creates = 0;
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/audio")) audioRequests.push(url.search);
    if (request.method() === "POST" && url.pathname === "/api/streaming") creates++;
  });
  await page.goto(base + target.path);
  await page.evaluate(([key, id, positionSeconds]) => localStorage.setItem(key, JSON.stringify({ id, title: "Far bookmark",
    positionSeconds, savedAt: Date.now() })), [BOOKMARK_KEY, id, position]);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40,
    downloadThroughput: throttleBytesPerSecond, uploadThroughput: throttleBytesPerSecond });
  const reloadedAt = Date.now();
  await page.reload();
  await expect(page.locator(target.restored[0])).toHaveText(target.restored[1], { timeout: 20_000 });
  const restoreSeconds = (Date.now() - reloadedAt) / 1000;
  expect(await page.locator("audio").evaluate(audio => audio.paused)).toBe(true); // Recovery never autoplays.
  // Only the recording from the saved frame; Chromium may repeat that request, never the prefix.
  expect(audioRequests.length).toBeGreaterThan(0);
  expect(audioRequests.every(search => search === `?start=${position}.000`)).toBe(true);
  expect((await status()).state).toBe("generating");
  // Each 10 s chunk is one sentence: the recovered offset addresses recording time, not the response.
  const highlighted = () => page.evaluate(() => [...(CSS.highlights.get("narration") ?? [])].map(range => range.toString()));
  if (target.path === "/") await expect.poll(highlighted).toEqual([`Paragraph ${position / chunkSeconds + 1}.`]);

  await page.locator(target.resume).click();
  await expect.poll(() => page.locator("audio").evaluate(audio => audio.currentTime)).toBeGreaterThan(0.3);
  expect((await status()).state).toBe("generating");
  release(); // Playback must continue into audio generated after the recovered response started.
  await expect.poll(() => page.locator("audio").evaluate(audio => audio.currentTime), { timeout: 30_000 }).toBeGreaterThan(12);
  if (target.path === "/") await expect.poll(highlighted).toEqual([`Paragraph ${generatedChunks + 1}.`]);
  await page.locator("audio").evaluate(audio => audio.pause()); // Both pages save the bookmark on pause.
  const playedTo = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).positionSeconds, BOOKMARK_KEY);
  expect(playedTo).toBeGreaterThan(generatedChunks * chunkSeconds + 1);
  expect(creates).toBe(0);
  console.log(`GENERATING RECOVERY ${target.name}: restored ${position} s in ${restoreSeconds.toFixed(1)} s at 12 KB/s; played to ${playedTo.toFixed(1)} s`);
}
