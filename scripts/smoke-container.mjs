import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const image = process.argv[2] || "article-reader:local";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const id = docker("run", "--detach", "--rm", "--init", "--read-only", "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true", "--memory=512m", "--cpus=1", "--pids-limit=128",
  "--tmpfs", "/tmp:size=16m,mode=1777", "--publish", "127.0.0.1::3001", image);
try {
  const port = docker("port", id, "3001/tcp").split(":").at(-1);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { assert.equal((await response.json()).status, "ok"); ready = true; break; }
    } catch { /* Wait for the actual server to become ready. */ }
    await setTimeout(250);
  }
  assert.ok(ready, "Container did not become ready");
  assert.equal(docker("exec", id, "id", "-u"), "1000");
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert.ok(assets.length > 0, "Production assets missing");
  for (const asset of assets) assert.equal((await fetch(base + asset)).status, 200);
  assert.match(html, /<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="\/favicon\.svg"/);
  const favicon = await fetch(`${base}/favicon.svg`);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("content-type"), "image/svg+xml");
  assert.match(await favicon.text(), /<svg\s[^>]*viewBox="0 0 32 32"/);
  const post = url => fetch(`${base}/api/article`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
  const blocked = await post("http://127.0.0.1/");
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /Private|local|reserved/);
  if (process.argv[3]) {
    const article = await post(process.argv[3]);
    assert.equal(article.status, 200);
    const body = await article.json();
    assert.ok(body.title && body.text.length > 100);
    console.log(`Real extraction: ${body.title}, ${body.text.length} characters`);
  }
  console.log("Container smoke passed: health, non-root user, production assets, SSRF rejection under runtime limits. TTS not exercised.");
} finally {
  docker("stop", id);
}
