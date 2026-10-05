// Explicit synthetic JS/security fixtures; this is not publisher extraction.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { createProxy } from '../../renderer/proxy.mjs';
import { renderPage } from '../../renderer/service.mjs';
import { extractArticle } from '../../article.mjs';

let upstreamCalls = 0;
let privateDnsChecks = 0;
const fixture = http.createServer((req, res) => {
  if (req.url === '/slow') return;
  if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/' }); return res.end(); }
  if (req.url === '/dns-redirect') { res.writeHead(302, { Location: 'http://control.example/' }); return res.end(); }
  if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>Rendered fixture article</title><main id="story"></main>
    <dialog open>MODAL NOISE</dialog><script>
    confirm('Do not click publisher controls');
    if (localStorage.getItem('seen')) throw new Error('Context storage leaked');
    localStorage.setItem('seen', 'yes');
    setTimeout(() => { document.querySelector('#story').innerHTML = '<article><h1>Rendered fixture article</h1><p>This fixture article is inserted by real JavaScript after navigation. The browser must execute scripts before Readability can extract these sentences.</p><p>It is deliberately synthetic, with a modal dialog removed from the serialized document rather than clicked. Network protections remain enabled throughout the test.</p></article>'; }, ${req.url === '/delayed' ? 3000 : 50});
    fetch('http://control.example/secret').catch(()=>{});
    fetch('http://169.254.169.254/secret').catch(()=>{});
    new WebSocket('ws://control.example/socket');
    </script>`);
}).listen(0, '127.0.0.1');
await once(fixture, 'listening');
const proxy = createProxy({
  resolve: async hostname => {
    if (hostname === 'renderer-fixture.example') return [{ address: '8.8.8.8', family: 4 }];
    privateDnsChecks++; return [{ address: '127.0.0.1', family: 4 }];
  },
  request: (options, callback) => {
    // Only this test maps an already-validated public fixture IP to a local
    // HTTP socket. No runtime environment variable enables private targets.
    assert.equal(options.host, '8.8.8.8'); upstreamCalls++;
    return http.request({ ...options, host: '127.0.0.1', port: fixture.address().port }, callback);
  },
}).listen(0, '127.0.0.1');
await once(proxy, 'listening');
const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
  proxy: { server: `http://127.0.0.1:${proxy.address().port}` }, args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
try {
  const rendered = await renderPage(browser, 'http://renderer-fixture.example/', AbortSignal.timeout(5000), { stableMs: 250 });
  const delayedStart = performance.now();
  const delayed = await renderPage(browser, 'http://renderer-fixture.example/delayed', AbortSignal.timeout(6000));
  assert.match(extractArticle(delayed.html, delayed.url).text, /real JavaScript/);
  assert.ok(performance.now() - delayedStart >= 3000);
  const article = extractArticle(rendered.html, rendered.url);
  assert.match(article.text, /inserted by real JavaScript/); assert.doesNotMatch(article.text, /MODAL NOISE/);
  assert.ok(privateDnsChecks > 0); assert.equal(upstreamCalls, 2);
  assert.equal(browser.contexts().length, 0);
  for (const path of ['/redirect', '/dns-redirect', '/loop']) {
    await assert.rejects(renderPage(browser, `http://renderer-fixture.example${path}`, AbortSignal.timeout(5000)), /denied|403|limit|redirect/i);
    assert.equal(browser.contexts().length, 0);
  }
  const start = performance.now();
  await assert.rejects(renderPage(browser, 'http://renderer-fixture.example/slow', AbortSignal.timeout(100)), /timeout|abort/i);
  const cancellationMs = Math.round(performance.now() - start);
  assert.ok(cancellationMs < 2000); assert.equal(browser.contexts().length, 0);
  // Fresh context after cancellation still succeeds, without persisted storage.
  const next = await renderPage(browser, 'http://renderer-fixture.example/', AbortSignal.timeout(5000), { stableMs: 250 });
  assert.match(extractArticle(next.html, next.url).text, /real JavaScript/);
  console.log(JSON.stringify({ fixture: 'synthetic JS + modal', title: article.title, characters: article.text.length, privateDnsChecks,
    cancellationMs, contextsRemaining: browser.contexts().length, sandbox: true }));
} finally {
  await browser.close(); proxy.dispose(); fixture.closeAllConnections(); fixture.close();
}
