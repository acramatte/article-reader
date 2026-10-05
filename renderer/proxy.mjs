import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve } from 'node:path';
import { validateUrl, publicTarget } from '../article.mjs';

const LIMIT = 16_000_000;
const HOP = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']);
function headers(input) {
  const omitted = new Set([...HOP, ...(input.connection || '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !omitted.has(key.toLowerCase())));
}
// Public-only forward proxy. DNS is checked at each connection and the socket uses
// the checked literal IP, never a second hostname lookup (including CONNECT).
export function createProxy({ resolve, connect = net.connect, request = http.request, maxConnections = 64, deadlineMs = 35_000 } = {}) {
  const server = http.createServer();
  let active = 0;
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (active >= maxConnections) return socket.destroy();
    active++;
    const timer = setTimeout(() => socket.destroy(), deadlineMs);
    socket.once('close', () => { active--; clearTimeout(timer); });
  });
  server.on('request', async (req, res) => {
    let upstream;
    const stop = () => upstream?.destroy();
    res.once('close', stop);
    try {
      if (!['GET', 'HEAD'].includes(req.method) || req.headers.upgrade || req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0)) throw new Error('Unsupported proxy request.');
      const url = validateUrl(req.url);
      if (url.protocol !== 'http:') throw new Error('HTTPS requires CONNECT.');
      const target = await publicTarget(url, resolve);
      if (res.destroyed) return;
      upstream = request({ host: target.address, family: target.family, port: Number(url.port || 80), method: req.method,
        path: url.pathname + url.search, agent: false, headers: { ...headers(req.headers), host: url.host, connection: 'close' } }, result => {
        try {
          if (!Number.isInteger(result.statusCode) || result.statusCode < 100 || result.statusCode > 599) throw new Error('Invalid upstream status.');
          let bytes = 0;
          result.on('data', piece => { bytes += piece.length; if (bytes > LIMIT) { result.destroy(); res.destroy(); } });
          result.on('error', () => res.destroy());
          res.writeHead(result.statusCode, headers(result.headers));
          result.pipe(res);
        } catch {
          result.destroy(); upstream?.destroy();
          if (!res.destroyed) {
            if (res.headersSent) res.destroy();
            else { res.writeHead(502, { Connection: 'close' }); res.end('Invalid upstream response.'); }
          }
        }
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      upstream.end();
    } catch {
      if (!res.destroyed) { res.writeHead(403, { 'Connection': 'close' }); res.end('Proxy target denied.'); }
    }
  });
  server.on('connect', async (req, client, head) => {
    let upstream;
    const stop = () => upstream?.destroy();
    client.once('close', stop);
    try {
      // Reject ambiguous authorities, paths, userinfo and non-TLS ports.
      if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):443$/.test(req.url)) throw new Error('Invalid CONNECT authority.');
      const target = await publicTarget(validateUrl(`https://${req.url}/`), resolve);
      if (client.destroyed) return;
      upstream = connect({ host: target.address, family: target.family, port: 443 });
      upstream.on('error', () => client.destroy());
      upstream.once('close', () => client.destroy());
      upstream.once('connect', () => {
        if (client.destroyed) return upstream.destroy();
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        let bytes = head.length;
        const count = piece => { bytes += piece.length; if (bytes > LIMIT) { upstream.destroy(); client.destroy(); } };
        client.on('data', count); upstream.on('data', count);
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    } catch { if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.headersTimeout = 5_000;
  server.requestTimeout = deadlineMs;
  server.on('close', () => { for (const socket of sockets) socket.destroy(); });
  server.dispose = () => { for (const socket of sockets) socket.destroy(); server.close(); };
  return server;
}
export function createLocalRelay(target) {
  const endpoint = new URL(target);
  return http.createServer((req, res) => {
    if (!((req.method === 'POST' && req.url === '/render') || (req.method === 'GET' && req.url === '/health')) || req.headers.origin) {
      res.writeHead(403); return res.end();
    }
    const upstream = http.request(new URL(req.url, endpoint), { method: req.method, headers: { 'Content-Type': req.headers['content-type'] || '' } }, result => {
      try {
        if (!Number.isInteger(result.statusCode) || result.statusCode < 100 || result.statusCode > 599) throw new Error('Invalid upstream status.');
        result.on('error', () => res.destroy());
        res.writeHead(result.statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); result.pipe(res);
      } catch {
        result.destroy();
        if (!res.destroyed) {
          if (res.headersSent) res.destroy();
          else { res.writeHead(502); res.end(); }
        }
      }
    });
    const timer = setTimeout(() => { upstream.destroy(); res.destroy(); }, 28_000);
    let bytes = 0;
    req.on('data', piece => { bytes += piece.length; if (bytes > 8192) { upstream.destroy(); res.destroy(); } });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { clearTimeout(timer); upstream.destroy(); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
}
if (process.argv[1] && pathResolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createProxy().listen(3128, '0.0.0.0', () => console.log('Public-only renderer proxy listening on 3128'));
  if (process.env.LOCAL_RELAY_TARGET) createLocalRelay(process.env.LOCAL_RELAY_TARGET).listen(3002, '0.0.0.0');
}
