import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { publisherFeed, articleFromFeed, fetchPublisherArticle } from '../publisher-feed.mjs';
import { ArticleError, requestPage } from '../article.mjs';
import { loadArticle } from '../renderer-client.mjs';
import { createProxy } from '../renderer/proxy.mjs';
const url = 'https://blog.angular.dev/exact-article-id';
const body = '<p>' + 'This is the official complete publisher article, with meaningful sentences for Readability extraction. '.repeat(8) + '</p>';
const xml = `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>Exact article</title><link>${url}</link><content:encoded><![CDATA[${body}]]></content:encoded></item></channel></rss>`;
const resolve = async () => [{ address: '8.8.8.8', family: 4 }];

test('publisher fallback uses exactly allowlisted origin and exact canonical item link, not title/slug', () => {
  assert.equal(publisherFeed(url), 'https://blog.angular.dev/feed');
  for (const value of ['https://evil.example/exact-article-id', 'http://blog.angular.dev/article', url+'?q=x', url+'#x', 'https://blog.angular.dev/feed']) assert.equal(publisherFeed(value), undefined);
  assert.equal(articleFromFeed(xml, url).source, 'publisher-rss');
  assert.equal(articleFromFeed(xml.replace('</link>', '?source=rss----447683c3d9a3---4</link>'), url).url, url);
  for (const query of ['?source=other', '?x=1', '?source=rss----447683c3d9a3---4&amp;x=1']) assert.throws(() => articleFromFeed(xml.replace('</link>', query+'</link>'), url), /absent/);
  for (const value of [url+'-other', url+'/', url.toUpperCase()]) assert.throws(() => articleFromFeed(xml, value), /absent/);
  assert.throws(() => articleFromFeed(xml.replace('</channel>', xml.match(/<item>.*<\/item>/s)[0]+'</channel>'), url), /ambiguous/);
});

test('feed rejects malformed XML, DTD/entities, missing full content, bytes and element overflow', () => {
  for (const value of ['<rss><', '<!DOCTYPE rss SYSTEM "file:///etc/passwd">'+xml, '<!ENTITY x "hello">'+xml, xml.replace('content:encoded','missing'), 'x'.repeat(3_000_001), '<rss><channel>'+ '<x/>'.repeat(50_001)+'</channel></rss>']) assert.throws(() => articleFromFeed(value, url));
});

test('feed request pins checked public target, bounds MIME/bytes and revalidates publisher redirects', async () => {
  let calls = 0;
  const article = await fetchPublisherArticle(url, { resolve, request: async (dest, target, signal, bytes, options) => {
    assert.equal(target.address, '8.8.8.8'); assert.equal(bytes, 3_000_000); assert.ok(signal); assert.ok(options.mime.test('application/rss+xml; charset=utf-8')); assert.ok(!options.mime.test('text/html'));
    return ++calls === 1 ? { redirect: '/feed?redirected=1' } : { html: xml };
  } });
  assert.equal(calls, 2); assert.equal(article.url, url);
  for (const dest of ['http://127.0.0.1/', 'https://169.254.169.254/', 'https://evil.example/', 'https://user:pass@blog.angular.dev/feed', 'https://blog.angular.dev:3002/feed']) {
    let requests = 0;
    await assert.rejects(fetchPublisherArticle(url, { resolve, request: async () => { requests++; return { redirect: dest }; } }));
    assert.equal(requests, 1);
  }
  let dns = 0;
  await assert.rejects(fetchPublisherArticle(url, { resolve: async () => [{ address: ++dns === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }], request: async () => ({ redirect: '/feed?again' }) }), /not allowed/);
  await assert.rejects(fetchPublisherArticle(url, { resolve, request: async () => ({ redirect: '/feed' }) }), /too many/);
});

test('feed deadlines cover stalled DNS/transport and cancellation; unsafe article failures never retry feeds', async () => {
  // Keep event loop alive while AbortSignal.timeout (unref timer) is under test.
  const keep = setInterval(() => {}, 1000);
  try {
    for (const options of [{ resolve: () => new Promise(() => {}) }, { resolve, request: () => new Promise(() => {}) }]) await assert.rejects(fetchPublisherArticle(url, { ...options, deadlineMs: 20 }), /timeout/i);
    const controller = new AbortController(); const pending = fetchPublisherArticle(url, { signal: controller.signal, resolve, request: () => new Promise(() => {}) }); controller.abort(); await assert.rejects(pending, /abort/i);
  } finally { clearInterval(keep); }
  let calls = 0;
  const fetchFeed = async () => { calls++; return articleFromFeed(xml, url); };
  const renderPage = () => assert.fail('Feed success must not render');
  await loadArticle(url, { fetchPage: async () => { throw new ArticleError('blocked', 'HTTP_BLOCK'); }, fetchFeed, renderPage });
  assert.equal(calls, 1);
  for (const error of [new Error('SSRF'), new Error('MIME'), new Error('bytes'), new Error('redirect'), new Error('transport'), new ArticleError('auth', 'HTTP_ERROR')]) await assert.rejects(loadArticle(url, { fetchPage: async () => { throw error; }, fetchFeed, renderPage }), e => e === error);
  assert.equal(calls, 1);
  await assert.rejects(loadArticle(url, { fetchPage: async () => { throw new ArticleError('blocked', 'HTTP_BLOCK'); }, fetchFeed: async () => { throw new Error('absent'); }, renderPage }), /absent/);
});

test('real RSS HTTP transport rejects bad MIME and oversized bodies', async t => {
  const server = http.createServer((req,res) => { res.writeHead(200, {'Content-Type': req.url === '/mime' ? 'text/html' : 'application/rss+xml'}); res.end('x'.repeat(101)); }).listen(0,'127.0.0.1');
  await once(server,'listening'); t.after(() => {server.closeAllConnections();server.close();});
  const target={address:'127.0.0.1',family:4};
  const options={mime:/^application\/rss\+xml$/};
  for (const path of ['/mime','/size']) await assert.rejects(requestPage(new URL(`http://example.com:${server.address().port}${path}`),target,AbortSignal.timeout(1000),100,options), /HTML|limit/);
});

test('proxy contains real HTTP status 000 and header callback exceptions; next request survives', async t => {
  let requests=0;
  const raw=net.createServer(socket => socket.once('data', () => socket.end(++requests===1 ? 'HTTP/1.1 000 Invalid\r\nContent-Length: 0\r\n\r\n' : 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))).listen(0,'127.0.0.1');
  await once(raw,'listening');
  const proxy=createProxy({resolve,request:(options,cb)=>http.request({...options,host:'127.0.0.1',port:raw.address().port},cb)}).listen(0,'127.0.0.1'); await once(proxy,'listening');
  t.after(()=>{proxy.dispose();raw.close();});
  const get=()=>new Promise((done,reject)=>{const req=http.get({host:'127.0.0.1',port:proxy.address().port,path:'http://example.com/',agent:false},res=>{res.resume();res.on('end',()=>done(res.statusCode));});req.on('error',reject);});
  assert.equal(await get(),502);assert.equal(await get(),200);
});
