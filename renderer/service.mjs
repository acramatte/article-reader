import http from 'node:http';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import ipaddr from 'ipaddr.js';
import { validateUrl, isPublicAddress } from '../article.mjs';

export function browserUrl(value) {
  const url = validateUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(hostname) && !isPublicAddress(hostname)) throw new Error('Private browser target denied.');
  return url;
}
export async function renderPage(browser, value, signal, { readinessMs = 8000, stableMs = 750 } = {}) {
  const url = browserUrl(value);
  signal.throwIfAborted();
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  let closing;
  const close = () => closing ||= context.close().catch(() => {});
  signal.addEventListener('abort', close, { once: true });
  let violation;
  try {
    signal.throwIfAborted();
    let requests = 0;
    let navigations = 0;
    const fail = message => { violation = new Error(message); void close(); };
    await context.route('**/*', async route => {
      try {
        if (++requests > 200) throw new Error('Browser request limit exceeded.');
        browserUrl(route.request().url());
        const request = route.request();
        if (!['GET', 'HEAD'].includes(request.method())) throw new Error('Browser writes are disabled.');
        if (request.isNavigationRequest() && request.frame() === context.pages()[0]?.mainFrame() && ++navigations > 6) throw new Error('Browser redirect/navigation limit exceeded.');
        await route.continue();
      } catch (error) {
        if (route.request().isNavigationRequest()) fail(error.message);
        await route.abort().catch(() => {});
      }
    });
    // Never let JS establish WebSocket sessions, even to a public host.
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    let received = 0;
    const session = await context.newCDPSession(page);
    await session.send('Network.enable');
    session.on('Network.dataReceived', event => {
      received += event.dataLength;
      if (received > 16_000_000) fail('Browser response byte limit exceeded.');
    });
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    if (!response || !response.ok()) throw new Error(`Renderer webpage returned HTTP ${response?.status() || 0}. Publisher access may be blocked; paste article text instead.`);
    if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(response.headers()['content-type'] || '')) throw new Error('Renderer URL did not return HTML.');
    // Wait for meaningful paragraph content, then require an unchanged sample.
    // Never networkidle: analytics/long polling must not decide readiness.
    await page.waitForFunction(({ stableMs }) => {
      const root = document.querySelector('article,main,[role="main"]') || document.body;
      const text = [...root.querySelectorAll('p,pre,blockquote')]
        .filter(node => !node.closest('nav,aside,dialog,[role="dialog"],[aria-modal="true"]'))
        .map(node => node.textContent.trim()).join('\n');
      const now = performance.now();
      const prior = window.__articleReadiness;
      if (!prior || prior.text !== text) window.__articleReadiness = { text, since: now };
      return text.length >= 200 && now - window.__articleReadiness.since >= stableMs;
    }, { stableMs }, { polling: 250, timeout: readinessMs });
    signal.throwIfAborted();
    if (violation) throw violation;
    const finalUrl = browserUrl(page.url()).href;
    const html = await page.evaluate(() => {
      // Do not click paywalls/consent controls. Remove only modal UI from the
      // serialized copy; no DOM actions, saved session or publisher credentials.
      const copy = document.documentElement.cloneNode(true);
      copy.querySelectorAll('dialog,[role="dialog"],[aria-modal="true"]').forEach(node => node.remove());
      return '<!doctype html>' + copy.outerHTML;
    });
    if (Buffer.byteLength(html) > 3_000_000) throw new Error('Rendered HTML exceeds the 3 MB limit.');
    return { html, url: finalUrl };
  } catch (error) {
    signal.throwIfAborted();
    throw violation || error;
  } finally {
    signal.removeEventListener('abort', close);
    await close();
  }
}

export function createRenderer(browser, { deadlineMs = 25_000 } = {}) {
  let active = false;
  return http.createServer(async (req, res) => {
    const json = (status, data) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); } };
    if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ok' });
    if (req.method !== 'POST' || req.url !== '/render') return json(404, { error: 'Not found.' });
    if (req.headers.origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(403, { error: 'Server-side JSON requests only.' });
    if (active) return json(429, { error: 'Renderer busy; retry later.' });
    active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Renderer deadline exceeded.')), deadlineMs);
    const abort = () => controller.abort(new Error('Renderer caller disconnected.'));
    controller.signal.addEventListener('abort', () => { if (!req.complete) req.destroy(); }, { once: true });
    req.once('aborted', abort);
    res.once('close', () => { if (!res.writableEnded) abort(); });
    try {
      let body = '';
      for await (const piece of req) {
        body += piece;
        if (Buffer.byteLength(body) > 8192) throw new Error('Renderer input too large.');
        controller.signal.throwIfAborted();
      }
      const data = JSON.parse(body);
      if (typeof data?.url !== 'string') throw new Error('A URL is required.');
      json(200, await renderPage(browser, data.url, controller.signal));
    } catch (error) { json(400, { error: error.message }); }
    finally { clearTimeout(timer); req.removeListener('aborted', abort); active = false; }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.RENDERER_PROXY) throw new Error('RENDERER_PROXY is required; direct browser egress is forbidden.');
  const proxy = new URL(process.env.RENDERER_PROXY);
  if (proxy.protocol !== 'http:' || !ipaddr.isValid(proxy.hostname)) throw new Error('Renderer proxy must be an explicit HTTP IP endpoint.');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    proxy: { server: proxy.href }, args: ['--proxy-bypass-list=<-loopback>', '--disable-quic',
      `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${proxy.hostname}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  const server = createRenderer(browser).listen(3002, '0.0.0.0', () => console.log('Sandboxed renderer listening on 3002'));
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, async () => { server.closeAllConnections(); server.close(); await browser.close(); });
}
