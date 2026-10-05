// Build article-reader:firecrawl-review first; exercises actual packaged server/modules/assets.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const image = process.env.READER_IMAGE || 'article-reader:firecrawl-review';
const name = `reader-firecrawl-smoke-${process.pid}`;
const docker = args => execFileSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 60_000 }).trim();
const report = { measuredAt: new Date().toISOString(), image, authentication: process.env.FIRECRAWL_API_KEY ? 'environment key' : 'no key' };
try {
  report.imageId = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  docker(['run', '-d', '--name', name, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=128',
    '-p', '127.0.0.1::3001', '-e', 'ARTICLE_EXTRACTOR=firecrawl', ...(process.env.FIRECRAWL_API_KEY ? ['-e', 'FIRECRAWL_API_KEY'] : []), image]);
  const inspect = JSON.parse(docker(['inspect', name]))[0];
  assert.equal(inspect.Config.User, 'node');
  const base = `http://127.0.0.1:${inspect.NetworkSettings.Ports['3001/tcp'][0].HostPort}`;
  const limit = Date.now() + 15_000;
  while (true) {
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* startup */ }
    if (Date.now() >= limit) throw new Error('Packaged reader did not become ready');
    await new Promise(r => setTimeout(r, 150));
  }
  const favicon = await fetch(`${base}/favicon.svg`); assert.equal(favicon.status, 200); assert.match(favicon.headers.get('content-type'), /image\/svg\+xml/);
  const article = await fetch(`${base}/api/article`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://blog.angular.dev/an-update-on-angulars-typescript-7-powered-compiler-9619a35e2b0a' }), signal: AbortSignal.timeout(50_000) });
  const body = await article.json(); assert.equal(article.status, 200, body.error); assert.match(body.title, /TypeScript 7-powered Compiler/);
  assert.ok(body.text.length >= 8000); assert.match(body.text, /oxc/);
  report.article = { status: article.status, title: body.title, characters: body.text.length, closing: body.text.slice(-250) };
  report.runtime = { user: inspect.Config.User, readOnly: inspect.HostConfig.ReadonlyRootfs, capDrop: inspect.HostConfig.CapDrop, memory: inspect.HostConfig.Memory, cpus: inspect.HostConfig.NanoCpus };
  report.favicon = { status: favicon.status, contentType: favicon.headers.get('content-type') };
  report.oomKilled = JSON.parse(docker(['inspect', name]))[0].State.OOMKilled; assert.equal(report.oomKilled, false);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; throw error; }
finally {
  try { docker(['rm', '-f', name]); } catch { /* no container if startup failed */ }
  const output = resolve(root, 'docs/benchmarks/firecrawl-container-smoke.json'); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
}
