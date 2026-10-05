// Run via: docker exec -i --user 1000 <renderer-container> node --input-type=module < tests/renderer/egress-check.mjs
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { readdir, readFile, readlink } from 'node:fs/promises';
const outerUserNamespace = await readlink('/proc/self/ns/user');
const checks = [];
for (const [host, port] of [['1.1.1.1', 443], ['172.30.197.1', 80], ['172.30.197.2', 3002], ['172.30.197.3', 3002], ['127.0.0.1', 3002], ['169.254.169.254', 80], ['::1', 3002]]) {
  const connected = await new Promise(resolve => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 250);
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
    socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  });
  assert.equal(connected, false, `${host}:${port} direct egress escaped`); checks.push({ host, port, connected });
}
const proxyStatus = await new Promise((resolve, reject) => {
  const request = http.get({ host: '172.30.197.2', port: 3128, path: 'http://example.com/' }, response => {
    response.resume(); response.on('end', () => resolve(response.statusCode));
  }); request.on('error', reject); request.setTimeout(5000, () => request.destroy(new Error('Proxy timeout')));
});
assert.equal(proxyStatus, 200);
const processes = [];
for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
  try {
    const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
    if (!command.includes('node renderer/service.mjs') && !command.startsWith('/ms-playwright/')) continue;
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    assert.doesNotMatch(command, /--no-sandbox/);
    assert.match(status, /^NoNewPrivs:\s+1$/m);
    const uid = status.match(/^Uid:\s+(\d+)/m)?.[1];
    const caps = Object.fromEntries([...status.matchAll(/^(Cap(?:Eff|Prm|Inh|Bnd|Amb)):\s+([a-f\d]+)/gm)].map(match => [match[1], match[2]]));
    const userNamespace = await readlink(`/proc/${pid}/ns/user`);
    const netNamespace = await readlink(`/proc/${pid}/ns/net`);
    assert.equal(uid, '1000');
    // Chromium's zygote creates a nested user/net namespace for its sandbox;
    // capabilities there cannot modify the outer firewall. No outer caps.
    if (userNamespace === outerUserNamespace) {
      for (const value of Object.values(caps)) assert.equal(BigInt('0x' + value), 0n);
    } else assert.notEqual(netNamespace, await readlink('/proc/self/ns/net'));
    processes.push({ pid, uid, userNamespace, netNamespace, caps });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
assert.ok(processes.length > 1);
console.log(JSON.stringify({ deniedDirectSockets: checks, publicProxyStatus: proxyStatus, runtimeProcesses: processes }));
