import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { ArticleError } from '../article.mjs';
import { loadArticle, renderArticleHtml } from '../renderer-client.mjs';
import { createProxy } from '../renderer/proxy.mjs';
import { createRenderer, browserUrl } from '../renderer/service.mjs';
import { html } from './fixture.mjs';

const page = { html, url: 'https://example.com/story' };
test('fallback is opt-in, typed and used only once for blocks or render-needed text', async () => {
  let calls = 0;
  const renderPage = async () => { calls++; return page; };
  assert.match((await loadArticle(page.url, { fetchPage: async () => page, renderPage })).text, /garden/i);
  assert.equal(calls, 0);
  for (const code of ['HTTP_BLOCK', 'RENDER_NEEDED']) {
    const fetchPage = async () => { throw new ArticleError('blocked', code); };
    await assert.rejects(loadArticle(page.url, { fetchPage }), /blocked/);
    await loadArticle(page.url, { fetchPage, renderPage });
  }
  await loadArticle(page.url, { fetchPage: async () => ({ ...page, html: '<html><body></body></html>' }), renderPage });
  assert.equal(calls, 3);
  for (const error of [new Error('SSRF denial'), new ArticleError('auth', 'HTTP_ERROR'), new Error('MIME'), new Error('size'), new Error('redirect'), Object.assign(new Error('spoof'), { code: 'HTTP_BLOCK' })]) {
    await assert.rejects(loadArticle(page.url, { fetchPage: async () => { throw error; }, renderPage }), e => e === error);
  }
  assert.equal(calls, 3);
  await assert.rejects(loadArticle(page.url, { fetchPage: async () => { throw new ArticleError('blocked', 'HTTP_BLOCK'); }, renderPage: async () => { calls++; throw new Error('publisher still blocked'); } }), /publisher still blocked/);
  assert.equal(calls, 4);
});

test('fallback propagates cancellation and does not start on an already aborted request', async () => {
  const controller = new AbortController();
  const pending = loadArticle(page.url, { signal: controller.signal, fetchPage: async () => { throw new ArticleError('blocked', 'HTTP_BLOCK'); },
    renderPage: (_value, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, /abort/i);
  await assert.rejects(loadArticle(page.url, { signal: controller.signal, fetchPage: async () => { throw new ArticleError('blocked', 'HTTP_BLOCK'); }, renderPage: () => { assert.fail('late render'); } }), /abort/i);
});

test('renderer client bounds responses, rejects private returned URLs and passes deadline and redirect policy', async () => {
  const transport = async (_endpoint, options) => { assert.equal(options.redirect, 'error'); assert.ok(options.signal); return Response.json(page); };
  assert.equal((await renderArticleHtml(page.url, { endpoint: 'http://local/render', transport })).html, html);
  await assert.rejects(renderArticleHtml(page.url, { transport: async () => Response.json({ ...page, url: 'http://127.0.0.1/' }) }), /not allowed/);
  await assert.rejects(renderArticleHtml(page.url, { transport: async () => Response.json({ ...page, html: 'x'.repeat(3_000_001) }) }), /Invalid/);
  await assert.rejects(renderArticleHtml(page.url, { transport: async () => Response.json({ error: 'still blocked' }, { status: 400 }) }), /still blocked/);
});

async function proxy(t, options = {}) {
  const server = createProxy(options).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => server.dispose());
  return server.address().port;
}
function get(port, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, agent: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
}
function tunnel(port, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on('error', reject); socket.once('data', bytes => { socket.destroy(); resolve(bytes.toString()); });
  });
}
test('real proxy sockets deny localhost, control/container/metadata, mixed DNS, rebinding and invalid CONNECT', async t => {
  let calls = 0;
  const port = await proxy(t, { resolve: async () => [{ address: '127.0.0.1', family: 4 }], connect: () => { calls++; assert.fail('private upstream'); } });
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://172.30.197.3/', 'http://[::1]/', 'http://rebind.example/', 'http://example.com:3002/', 'file:///etc/passwd']) assert.equal(await get(port, url), 403, url);
  for (const authority of ['127.0.0.1:443', '169.254.169.254:443', '[::ffff:127.0.0.1]:443', 'example.com:80', 'example.com:443/path', 'user@example.com:443', 'rebind.example:443']) assert.match(await tunnel(port, authority), /403/);
  assert.equal(await get(port, 'http://example.com/', 'POST'), 403);
  assert.equal(calls, 0);
  const mixed = await proxy(t, { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] });
  assert.equal(await get(mixed, 'http://example.com/'), 403);
});

test('CONNECT pins the validated literal address and revalidates each new connection', async t => {
  let dns = 0, connects = 0;
  const port = await proxy(t, { resolve: async () => [{ address: ++dns === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }], connect: options => {
    connects++; assert.deepEqual(options, { host: '8.8.8.8', family: 4, port: 443 });
    const socket = new net.Socket(); queueMicrotask(() => socket.emit('connect')); return socket;
  } });
  assert.match(await tunnel(port, 'rebind.example:443'), /200/);
  assert.match(await tunnel(port, 'rebind.example:443'), /403/);
  assert.equal(connects, 1);
});

test('browser lexical validation denies alternate local literals, credentials and protocols', () => {
  for (const value of ['http://2130706433/', 'http://0x7f000001/', 'http://[::ffff:127.0.0.1]/', 'file:///etc/passwd', 'ws://example.com/', 'https://a:b@example.com/', 'http://example.com:3002/']) assert.throws(() => browserUrl(value));
});

test('renderer refuses busy and cross-origin calls, cancels contexts on deadline, admits next request', async t => {
  let closed = 0;
  const browser = { newContext: async () => ({ close: async () => { closed++; }, route: async () => {}, routeWebSocket: async () => {}, newPage: async () => { throw new Error('fixture ended'); } }) };
  const server = createRenderer(browser, { deadlineMs: 60 }).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/render`;
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ url: page.url }) })).status, 403);
  const slow = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '100' } });
  slow.on('error', () => {}); slow.write('{');
  await new Promise(resolve => setTimeout(resolve, 15));
  const post = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: page.url }) });
  assert.equal((await post()).status, 429);
  await new Promise(resolve => setTimeout(resolve, 100));
  const result = await post(); assert.equal(result.status, 400); assert.match((await result.json()).error, /fixture ended/);
  assert.equal(closed, 1); slow.destroy();
});
