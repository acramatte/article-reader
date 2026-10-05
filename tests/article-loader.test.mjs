import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArticleError, loadArticle } from '../article.mjs';
import { html } from './fixture.mjs';

const page = { html, url: 'https://example.com/story' };
test('fallback is opt-in, typed and used only once for blocks or missing readable text', async () => {
  let calls = 0;
  const fallbackPage = async () => { calls++; return page; };
  assert.match((await loadArticle(page.url, { fetchPage: async () => page, fallbackPage })).text, /garden/i);
  assert.equal(calls, 0);
  for (const code of ['HTTP_BLOCK', 'RENDER_NEEDED']) {
    const fetchPage = async () => { throw new ArticleError('blocked', code); };
    await assert.rejects(loadArticle(page.url, { fetchPage }), /blocked/);
    await loadArticle(page.url, { fetchPage, fallbackPage });
  }
  await loadArticle(page.url, { fetchPage: async () => ({ ...page, html: '<html><body></body></html>' }), fallbackPage });
  assert.equal(calls, 3);
  for (const error of [new Error('SSRF denial'), new ArticleError('auth', 'HTTP_ERROR'), new Error('MIME'), new Error('size'), new Error('redirect'), Object.assign(new Error('spoof'), { code: 'HTTP_BLOCK' })]) {
    await assert.rejects(loadArticle(page.url, { fetchPage: async () => { throw error; }, fallbackPage }), e => e === error);
  }
  assert.equal(calls, 3);
  await assert.rejects(loadArticle(page.url, { fetchPage: async () => { throw new ArticleError('blocked', 'HTTP_BLOCK'); }, fallbackPage: async () => { calls++; throw new Error('publisher still blocked'); } }), /publisher still blocked/);
  assert.equal(calls, 4);
});

test('Angular follows the generic fallback path with no publisher exception', async () => {
  const url = 'https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a';
  const blocked = async () => { throw new ArticleError('blocked', 'HTTP_BLOCK'); };
  await assert.rejects(loadArticle(url, { fetchPage: blocked }), /blocked/);
  let calls = 0;
  await assert.rejects(loadArticle(url, { fetchPage: blocked, fallbackPage: async value => {
    assert.equal(value, url); calls++; throw new Error('still blocked');
  } }), /still blocked/);
  assert.equal(calls, 1);
});

test('fallback propagates cancellation and does not start on an already aborted request', async () => {
  const controller = new AbortController();
  const pending = loadArticle(page.url, { signal: controller.signal, fetchPage: async () => { throw new ArticleError('blocked', 'HTTP_BLOCK'); },
    fallbackPage: (_value, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, /abort/i);
  await assert.rejects(loadArticle(page.url, { signal: controller.signal, fetchPage: async () => { throw new ArticleError('blocked', 'HTTP_BLOCK'); }, fallbackPage: () => { assert.fail('late fallback'); } }), /abort/i);
});
