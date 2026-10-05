// Real URL -> article API -> Kokoro -> browser decoded audio; no mocks.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { createApp } from '../../server.mjs';

const url = 'https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a';

const output = '.ui-review/renderer'; await mkdir(output, { recursive: true });
const server = createApp({ rendererUrl: process.env.ARTICLE_RENDERER_URL || 'http://127.0.0.1:3002/render',
  ttsUrl: process.env.TTS_URL || 'http://127.0.0.1:18000/tts' }).listen(0, '127.0.0.1');
await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const response = await fetch(base + '/api/article', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  const extraction = await response.json();
  assert.equal(response.status, 200, JSON.stringify(extraction)); assert.equal(extraction.url, url);
  assert.match(extraction.title, /TypeScript 7-powered Compiler/);
  const page = await browser.newPage();
  let savedWav;
  page.on('response', r => { if (r.url().endsWith('/api/tts') && r.ok() && !savedWav) savedWav = r.body().then(bytes => writeFile(output + '/angular-first-chunk.wav', bytes)); });
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    window.__audio = { starts: [], decoded: [] };
    window.AudioContext = class extends Original {
      constructor(...args) {
        super(...args); window.__audio.context = this;
        const decode = this.decodeAudioData.bind(this);
        this.decodeAudioData = async (...args) => {
          const buffer = await decode(...args), samples = buffer.getChannelData(0);
          let sum = 0; for (const sample of samples) sum += sample * sample;
          window.__audio.decoded.push({ duration: buffer.duration, rms: Math.sqrt(sum / samples.length) }); return buffer;
        };
        const create = this.createBufferSource.bind(this);
        this.createBufferSource = () => {
          const source = create(), start = source.start.bind(source);
          source.start = at => { window.__audio.starts.push({ at, duration: source.buffer.duration }); start(at); }; return source;
        };
      }
    };
  });
  await page.goto(base);
  const articleResponse = page.waitForResponse(r => r.url().endsWith('/api/article'));
  await page.locator('#url').fill(url);
  await page.locator('#read-url').click();
  const uiResponse = await articleResponse; assert.equal(uiResponse.status(), 200);
  const article = await uiResponse.json(); assert.equal(article.url, url);
  assert.equal(article.source, 'publisher-rss');
  await page.waitForFunction(() => window.__audio.starts.length >= 2, null, { timeout: 90000 });
  const metrics = await page.evaluate(() => ({ starts: window.__audio.starts, decoded: window.__audio.decoded,
    state: window.__audio.context.state, firstAudio: document.querySelector('#first-audio').textContent,
    underruns: document.querySelector('#underruns').textContent }));
  assert.equal(metrics.state, 'running');
  for (const audio of metrics.decoded) assert.ok(audio.rms > 0.005);
  metrics.scheduleGaps = metrics.starts.slice(1).map((start, i) => start.at - metrics.starts[i].at - metrics.starts[i].duration);
  await page.locator('#pause').click();
  const pausedAt = await page.evaluate(() => window.__audio.context.currentTime);
  await page.waitForTimeout(200); assert.equal(await page.evaluate(() => window.__audio.context.currentTime), pausedAt);
  await page.locator('#pause').click();
  await page.screenshot({ path: output + '/publisher-feed-playing.png', fullPage: true });
  await page.locator('#stop').click();
  assert.equal(await page.evaluate(() => window.__audio.context.state), 'closed');
  await savedWav;
  const report = { directUrl: { status: response.status, uiStatus: uiResponse.status() }, contentSource: 'Automatic publisher RSS exact URL match',
    title: article.title, characters: article.text.length, ...metrics, pauseClockFrozen: true, stopContextClosed: true };
  await writeFile(output + '/real-smoke.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser.close(); server.closeAllConnections(); server.close(); }
