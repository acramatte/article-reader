// Real blocked URL -> reader API; no RSS, mocks, TTS or pasted text.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../../server.mjs';
const url = 'https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a';
const server = createApp({ articleExtractor: '', rendererUrl: process.env.ARTICLE_RENDERER_URL || 'http://127.0.0.1:3002/render' }).listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/article`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(50_000) });
  const result = await response.json();
  console.log(JSON.stringify({ url, status: response.status, ...result }));
  assert.notEqual(response.status, 200, 'Publisher access changed: update measured expectations.');
  assert.match(result.error, /403|429|blocked/i);
  assert.equal(result.text, undefined);
} finally { server.closeAllConnections(); server.close(); }
