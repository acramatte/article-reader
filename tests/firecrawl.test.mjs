import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { firecrawlArticleHtml, FIRECRAWL_ENDPOINT } from '../firecrawl-client.mjs';
import { ArticleError, extractArticle } from '../article.mjs';
import { loadArticle } from '../renderer-client.mjs';
import { createApp } from '../server.mjs';
import { html } from './fixture.mjs';

const url = 'https://example.com/story';
const resolve = async () => [{ address: '8.8.8.8', family: 4 }];
const data = (overrides = {}) => ({ html, metadata: { sourceURL: url, url, statusCode: 200, title: 'Garden Story' }, ...overrides });
const response = (overrides = {}) => Response.json({ success: true, data: data(), ...overrides });
const call = options => firecrawlArticleHtml(url, { resolve, transport: async () => response(), ...options });
const hasCode = code => error => error instanceof ArticleError && error.code === code;

test('fixed Firecrawl contract requests actual HTML only, bounded timeout, no cache storage or redirects', async () => {
  let calls = 0;
  const page = await call({ apiKey: 'test-key', transport: async (endpoint, options) => {
    calls++; assert.equal(endpoint, FIRECRAWL_ENDPOINT); assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(options.body), { url, formats: ['html'], onlyMainContent: true, timeout: 25000, storeInCache: false });
    return response();
  } });
  assert.equal(page.html, html); assert.equal(page.url, url); assert.equal(page.title, 'Garden Story'); assert.equal(calls, 1);
  await call({ apiKey: '', transport: async (_endpoint, options) => { assert.equal(options.headers.Authorization, undefined); return response(); } });
});

test('reject unsafe input, mixed DNS and DNS failures before third-party submission', async () => {
  let calls = 0;
  const transport = async () => { calls++; return response(); };
  for (const value of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://2130706433/', 'file:///etc/passwd', 'https://a:b@example.com/', 'https://example.com:3000/']) {
    await assert.rejects(firecrawlArticleHtml(value, { resolve, transport }));
  }
  await assert.rejects(call({ transport, resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] }), /not allowed/);
  await assert.rejects(call({ transport, resolve: async () => { throw new Error('DNS failed'); } }), /DNS failed/);
  assert.equal(calls, 0);
});

test('API auth, billing, rate limits and failures are typed actionable errors with no retry or raw secret echo', async () => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [402, 'CREDITS'], [429, 'RATE_LIMIT'], [500, 'HTTP'], [404, 'HTTP']]) {
    let calls = 0;
    await assert.rejects(call({ transport: async () => { calls++; return Response.json({ error: 'secret diagnostic' }, { status }); } }), e => {
      assert.ok(hasCode(`FIRECRAWL_${code}`)(e)); assert.doesNotMatch(e.message, /secret/); return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(call({ transport: async () => { throw new Error('secret endpoint'); } }), hasCode('FIRECRAWL_TRANSPORT'));
});

test('success requires genuine source 2xx, HTML, success flag and correct provenance', async () => {
  for (const statusCode of [undefined, '200', 0, 199, 300, 401, 403, 404, 429, 500]) {
    const d = data(); d.metadata.statusCode = statusCode;
    await assert.rejects(call({ transport: async () => response({ data: d }) }), hasCode('FIRECRAWL_SOURCE'));
  }
  for (const overrides of [{ success: false }, { data: null }, { data: data({ html: undefined }) }, { data: data({ html: 42 }) }]) {
    await assert.rejects(call({ transport: async () => response(overrides) }), hasCode('FIRECRAWL_RESPONSE'));
  }
  for (const metadata of [{ sourceURL: 'https://other.example/story' }, { sourceURL: undefined }, { url: 'http://127.0.0.1/' }, { url: 'https://a:b@example.com/' }, { error: 'source failure' }, { title: 'x'.repeat(1001) }]) {
    const d = data(); Object.assign(d.metadata, metadata);
    await assert.rejects(call({ transport: async () => response({ data: d }) }));
  }
  const d = data(); d.metadata.url = 'https://example.com/redirected';
  assert.equal((await call({ transport: async () => response({ data: d }) })).url, d.metadata.url);
  delete d.metadata.url;
  assert.equal((await call({ transport: async () => response({ data: d }) })).url, url);
  await assert.rejects(call({ transport: async () => new Response('{bad', { headers: { 'Content-Type': 'application/json' } }) }), /invalid JSON/);
  await assert.rejects(call({ transport: async () => new Response('html') }), /return JSON/);
});

test('revalidate returned source and final DNS; private redirect metadata is not trusted', async () => {
  let lookups = 0;
  await assert.rejects(call({ resolve: async () => [{ address: ++lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }] }), /not allowed/);
  assert.equal(lookups, 2);
  lookups = 0;
  await assert.rejects(call({ resolve: async () => [{ address: ++lookups === 3 ? '127.0.0.1' : '8.8.8.8', family: 4 }] }), /not allowed/);
  assert.equal(lookups, 3);
});

test('response and UTF-8 HTML byte limits cancel large bodies', async () => {
  await assert.rejects(call({ transport: async () => response({ data: data({ html: 'é'.repeat(1500001) }) }) }), hasCode('FIRECRAWL_SIZE'));
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6100001)); }, cancel() { cancelled = true; } });
  await assert.rejects(call({ transport: async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }) }), hasCode('FIRECRAWL_SIZE'));
  assert.ok(cancelled);
});

test('cancel before submit, during DNS, transport and body reads; late transport is not accepted', async () => {
  const already = new AbortController(); already.abort();
  await assert.rejects(call({ signal: already.signal, transport: () => assert.fail('submitted') }), /abort/i);
  for (const phase of ['dns', 'transport', 'body']) {
    const controller = new AbortController(); let cancelled = false;
    const pending = new Promise(() => {});
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const options = { signal: controller.signal,
      ...(phase === 'dns' ? { resolve: () => pending } : {}),
      ...(phase === 'transport' ? { transport: () => pending } : {}),
      ...(phase === 'body' ? { transport: async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }) } : {}),
    };
    const request = call(options);
    await new Promise(r => setImmediate(r)); controller.abort();
    await assert.rejects(request, /abort/i);
    if (phase === 'body') assert.ok(cancelled);
  }
});

test('typed fallback integrates Firecrawl once, keeps defaults and local renderer, forbids ambiguity', async () => {
  assert.throws(() => createApp({ articleExtractor: 'unknown' }), /supports only/);
  assert.throws(() => createApp({ articleExtractor: 'firecrawl', rendererUrl: 'http://local/render' }), /not both/);
  assert.throws(() => createApp({ articleExtractor: 'firecrawl', renderPage: () => {} }), /not both/);
  const direct = async () => ({ html, url }); let calls = 0;
  const renderPage = async value => { calls++; return firecrawlArticleHtml(value, { resolve, transport: async () => response() }); };
  await loadArticle(url, { fetchPage: direct, renderPage }); assert.equal(calls, 0);
  for (const code of ['HTTP_BLOCK', 'RENDER_NEEDED']) {
    const fetchPage = async () => { throw new ArticleError('blocked', code); };
    assert.ok((await loadArticle(url, { fetchPage, renderPage })).text.length > 80);
  }
  assert.equal(calls, 2);
  for (const error of [new ArticleError('404', 'HTTP_ERROR'), new Error('DNS'), new Error('size'), new Error('transport'), new Error('auth')]) {
    await assert.rejects(loadArticle(url, { fetchPage: async () => { throw error; }, renderPage }), e => e === error);
  }
  assert.equal(calls, 2);
  const server = createApp({ fetchPage: direct }).listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/article`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    assert.equal(result.status, 200);
  } finally { server.closeAllConnections(); server.close(); }
});

test('metadata title is safely preserved, semantic/form-like UI removed without losing later prose or FAQ', () => {
  const prose = 'A real article describes feedback forms, newsletter subscriptions and compiler design in depth. '.repeat(8);
  const fixture = `<article><p>${prose}</p><nav><p>Navigation noise</p></nav><div role="button">Image control</div><div><h2>Widget heading</h2><p>Widget instructions</p><div><input placeholder="email"></div><button>Subscribe</button></div><form>Form noise</form><div role="dialog">Feedback noise</div><h2>FAQ</h2><p>Later important prose remains intact.</p><p>${prose}</p></article>`;
  const article = extractArticle(fixture, url, { title: '<img src=x onerror=alert(1)> Compiler' });
  assert.match(article.title, /Compiler/); assert.match(article.text, /FAQ/); assert.match(article.text, /Later important prose/);
  assert.match(article.text, /feedback forms, newsletter subscriptions/);
  assert.doesNotMatch(article.text, /Navigation noise|Image control|Widget heading|Widget instructions|Form noise|Feedback noise/);
});

test('generic machine widget data removal preserves JSON in prose/code and collection controls do not pollute titles', () => {
  const prose = 'A substantive compiler article explains the structures that support real code and analysis. '.repeat(8);
  const fixture = `<div>{"feedback":"serialized widget noise"}</div><article><h1>Compiler <x-tooltip data-nosnippet><span role="listbox"></span>Collection control noise</x-tooltip></h1><p>${prose}</p><div>{"legitimate":"article JSON"}</div><pre>{"example":"code JSON"}</pre><p>${prose}</p></article>`;
  const article = extractArticle(fixture, url);
  assert.match(article.text, /article JSON/); assert.match(article.text, /code JSON/);
  assert.doesNotMatch(article.text, /serialized widget noise|Collection control noise/);
  assert.doesNotMatch(article.title, /Collection control/);
});

test('deadline cancellation includes unresolved DNS and interrupted bodies have safe typed diagnostics', async () => {
  const timer = setTimeout(() => {}, 100);
  try {
    await assert.rejects(call({ signal: AbortSignal.timeout(15), resolve: () => new Promise(() => {}) }), error => error.name === 'TimeoutError');
  } finally { clearTimeout(timer); }
  await assert.rejects(call({ transport: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('secret transport diagnostics')); } }), { headers: { 'Content-Type': 'application/json' } }) }), error => {
    assert.ok(hasCode('FIRECRAWL_TRANSPORT')(error)); assert.doesNotMatch(error.message, /secret/); return true;
  });
});

test('reader API exposes actionable Firecrawl error codes without converting provider failure to article success', async () => {
  const server = createApp({ articleExtractor: '', rendererUrl: '', fetchPage: async () => { throw new ArticleError('blocked', 'HTTP_BLOCK'); },
    renderPage: async () => { throw new ArticleError('Firecrawl rate limit reached. Try later.', 'FIRECRAWL_RATE_LIMIT'); } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = await fetch(`http://127.0.0.1:${server.address().port}/api/article`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    assert.equal(api.status, 400);
    assert.deepEqual(await api.json(), { error: 'Firecrawl rate limit reached. Try later.', code: 'FIRECRAWL_RATE_LIMIT' });
  } finally { server.closeAllConnections(); server.close(); }
});
