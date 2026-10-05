import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createProxy, createLocalRelay } from '../renderer/proxy.mjs';

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject);
  });
}
test('proxy catches asynchronous writeHead/header errors and destroys upstream', async t => {
  let destroyed = 0, calls = 0;
  const proxy = createProxy({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: (_options, callback) => {
    const request = new EventEmitter(); request.destroy = () => { destroyed++; };
    request.end = () => setImmediate(() => {
      const result = new PassThrough(); result.statusCode = 200;
      result.headers = ++calls === 1 ? { 'invalid\nheader': 'value' } : {};
      callback(result); result.end();
    }); return request;
  } }).listen(0, '127.0.0.1'); await once(proxy, 'listening'); t.after(() => proxy.dispose());
  assert.equal(await get(proxy.address().port, 'http://example.com/'), 502);
  assert.ok(destroyed > 0);
  assert.equal(await get(proxy.address().port, 'http://example.com/'), 200);
});

test('fixed-target local relay contains real status 000 and survives next health request', async t => {
  let calls = 0;
  const upstream = net.createServer(socket => socket.once('data', () => socket.end(++calls === 1
    ? 'HTTP/1.1 000 Invalid\r\nContent-Length: 0\r\n\r\n'
    : 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const relay = createLocalRelay(`http://127.0.0.1:${upstream.address().port}`).listen(0, '127.0.0.1');
  await once(relay, 'listening'); t.after(() => { relay.closeAllConnections(); relay.close(); upstream.close(); });
  assert.equal(await get(relay.address().port, '/health'), 502);
  assert.equal(await get(relay.address().port, '/health'), 200);
});
