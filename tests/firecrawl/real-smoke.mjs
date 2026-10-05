// Real HTTP -> Firecrawl -> Readability -> Kokoro -> browser, no mocks or pasted text.
// Run after npm run build with a ready dedicated TTS_URL (default localhost:18000).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createApp } from '../../server.mjs';
import { firecrawlArticleHtml } from '../../firecrawl-client.mjs';
import { fetchArticleHtml } from '../../article.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'docs/benchmarks/firecrawl-audio-smoke.json');
const url = 'https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a';
const notFound = 'https://developer.chrome.com/blog/chrome-131';
const report = { measuredAt: new Date().toISOString(), authentication: process.env.FIRECRAWL_API_KEY ? 'environment key' : 'no key',
  note: 'One sample with ready local CPU Kokoro; hosted cache state unknown. Not cold-run, SLA or physical listening evidence.', url };
let browser;
const server = createApp({ articleExtractor: 'firecrawl',
  ttsUrl: process.env.TTS_URL || 'http://127.0.0.1:18000/tts', staticDir: resolve(root, 'dist') }).listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  await assert.rejects(fetchArticleHtml(url), error => { report.directError = { code: error.code, message: error.message }; return error.code === 'HTTP_BLOCK'; });
  await assert.rejects(firecrawlArticleHtml(notFound), error => {
    report.source404 = { code: error.code, message: error.message };
    return error.code === 'FIRECRAWL_SOURCE' && /HTTP 404/.test(error.message);
  });
  const api = await fetch(`http://127.0.0.1:${server.address().port}/api/article`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: notFound }) });
  report.api404 = { status: api.status, body: await api.json() };
  assert.notEqual(api.status, 200); assert.equal(report.api404.body.text, undefined);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); page.setDefaultTimeout(90_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const requests = []; page.on('request', request => { if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname); });
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    window.__audio = { starts: [], decoded: [], context: null };
    window.AudioContext = class extends Original {
      constructor(...args) {
        super(...args); window.__audio.context = this;
        const decode = this.decodeAudioData.bind(this);
        this.decodeAudioData = async (...args) => {
          const buffer = await decode(...args); const samples = buffer.getChannelData(0); let sum = 0;
          for (const sample of samples) sum += sample * sample;
          window.__audio.decoded.push({ duration: buffer.duration, rms: Math.sqrt(sum / samples.length) }); return buffer;
        };
        const create = this.createBufferSource.bind(this);
        this.createBufferSource = () => {
          const source = create(); const start = source.start.bind(source);
          source.start = at => { window.__audio.starts.push({ at, duration: source.buffer.duration }); start(at); }; return source;
        };
      }
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#url').fill(url);
  const started = performance.now();
  await page.locator('#read-url').click();
  await page.waitForFunction(() => window.__audio.decoded.length >= 3 && document.querySelector('#first-audio').textContent !== '—', null, { timeout: 120_000 });
  report.observedWallMs = Math.round(performance.now() - started);
  report.playback = await page.evaluate(() => ({ title: document.querySelector('#article-title').textContent,
    characters: document.querySelector('#text').value.length, opening: document.querySelector('#text').value.slice(0, 200),
    closing: document.querySelector('#text').value.slice(-300), firstAudio: document.querySelector('#first-audio').textContent,
    underruns: Number(document.querySelector('#underruns').textContent), buffer: document.querySelector('#buffer').textContent,
    starts: window.__audio.starts, decoded: window.__audio.decoded, state: window.__audio.context.state }));
  assert.match(report.playback.title, /TypeScript 7-powered Compiler/); assert.ok(report.playback.characters >= 8000);
  assert.match(report.playback.closing, /Rust/); assert.equal(report.playback.state, 'running');
  for (const audio of report.playback.decoded) assert.ok(audio.rms > 0.005);
  report.playback.gapsSeconds = report.playback.starts.slice(1).map((item, i) => item.at - (report.playback.starts[i].at + report.playback.starts[i].duration));
  await page.locator('#pause').click();
  await page.waitForFunction(() => window.__audio.context.state === 'suspended');
  const pausedAt = await page.evaluate(() => window.__audio.context.currentTime);
  await page.waitForTimeout(400);
  report.pause = { before: pausedAt, after: await page.evaluate(() => window.__audio.context.currentTime) };
  assert.equal(report.pause.before, report.pause.after);
  await page.locator('#pause').click();
  await page.waitForFunction(() => window.__audio.context.state === 'running');
  report.resumed = true;
  await page.locator('#stop').click();
  await page.waitForFunction(() => window.__audio.context.state === 'closed');
  report.stop = { state: await page.locator('#status').textContent(), context: await page.evaluate(() => window.__audio.context.state) };
  assert.equal(report.stop.state, 'Stopped'); assert.deepEqual(errors, []);
  report.requests = requests; report.pageErrors = errors; report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; throw error; }
finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
