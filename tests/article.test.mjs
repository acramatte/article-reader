import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { validateUrl, isPublicAddress, publicTarget, fetchArticleHtml, extractArticle, readArticle, requestPage } from "../article.mjs";
import { chunkText, planNarration } from "../chunks.mjs";
import { html, paragraphs } from "./fixture.mjs";

test("Readability extracts paragraphs without menus, ads, or scripts", () => {
  const article = extractArticle(html, "https://example.com/story");
  assert.equal(article.title, "A garden for everyone");
  for (const paragraph of paragraphs) assert.ok(article.text.includes(paragraph));
  assert.doesNotMatch(article.text, /MENU NOISE|ADVERTISEMENT NOISE|window.injected|BUY THINGS/);
  assert.ok(article.text.includes("\n\n"));
  assert.throws(() => extractArticle("<html><p>Empty</p></html>", "https://example.com"), /readable|enough/);
});

test("chunking keeps all text, respects first/regular limits, and preserves paragraphs", () => {
  for (const text of [paragraphs.join("\n\n"), "word ".repeat(900), "x".repeat(1500), "One. Two! Three?", "  \n\n "]) {
    const chunks = chunkText(text);
    chunks.forEach((chunk, i) => assert.ok(chunk.length > 0 && chunk.length <= (i === 0 ? 220 : 500)));
    assert.equal(chunks.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
  }
  assert.deepEqual(chunkText("First paragraph.\n\nSecond paragraph."), ["First paragraph.", "Second paragraph."]);
  assert.throws(() => chunkText("test", { firstLimit: 0 }), /positive/);
});

test("chunking skips punctuation-only paragraphs and fragments, preserving speech text and its punctuation", () => {
  assert.deepEqual(chunkText("«»“”()[]\n\n«L’été arrive !»\n\n***\n\n2026\n\n漢字\n\n١٢"),
    ["«L’été arrive !»", "two thousand twenty-six", "漢字", "١٢"]);
  const fragments = chunkText("-".repeat(20) + "«Salut.»" + "-".repeat(30), { firstLimit: 10, limit: 10 });
  assert.ok(fragments.every(chunk => /[\p{L}\p{N}]/u.test(chunk) && chunk.length <= 10));
  assert.equal(fragments.join("").replaceAll("-", ""), "«Salut.»");
  assert.deepEqual(chunkText("  «»“”()[] — *** 🎵 \n\n ... "), []);
});

test("narration plan maps every chunk to whole sentences given as source ranges", () => {
  const text = "  Mr. Smith met J. K. Rowling.\nShe   waved!  \"Hello?\" ***\n\n***\n\nOui ? Non.\n\n" +
    `${"word ".repeat(120).trim()}. ${"x".repeat(600)}`;
  const { sentences, chunks } = planNarration(text, { language: "fr" });
  const slices = sentences.map(({ start, end }) => text.slice(start, end));
  assert.deepEqual(slices.slice(0, 5), ["Mr. Smith met J. K. Rowling.", "She   waved!", "\"Hello?\" ***", "Oui ?", "Non."]);
  sentences.forEach(({ start, end, length }, i) => {
    assert.ok(i === 0 || start >= sentences[i - 1].end, "sentences are ordered and disjoint");
    assert.equal(length, slices[i].replace(/\s+/g, " ").length);
  });
  // Chunk text is exactly its sentences, single-spaced; sentence indexes run in order across chunks.
  assert.deepEqual(chunks.flatMap(chunk => chunk.sentences), sentences.map((_, i) => i));
  for (const chunk of chunks) assert.equal(chunk.text, chunk.sentences.map(i => slices[i].replace(/\s+/g, " ")).join(" "));
  chunks.forEach((chunk, i) => assert.ok(chunk.text.length <= (i === 0 ? 220 : 500)));
  // A sentence longer than a chunk becomes several sentences, split at words, then hard.
  assert.ok(slices.filter(slice => slice.startsWith("word")).length > 1);
  assert.equal(slices.filter(slice => /^x+$/.test(slice)).join(""), "x".repeat(600));
  assert.deepEqual(planNarration("«»\n\n— ***"), { sentences: [], chunks: [] });
});

test("URL and IP validation rejects SSRF targets, credentials, schemes, and ports", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com", "https://name:pass@example.com", "http://example.com:8000", "bad"]) assert.throws(() => validateUrl(url));
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) assert.equal(isPublicAddress(ip), false, ip);
  // IPv4-compatible IPv6 (::/96) embeds an IPv4 address without the ::ffff: mapped prefix.
  for (const ip of ["::7f00:1", "::127.0.0.1", "::a9fe:a9fe", "::169.254.169.254", "::c0a8:1"]) assert.equal(isPublicAddress(ip), false, ip);
  // Transition ranges (NAT64, 6to4, Teredo) embed IPv4 too.
  for (const ip of ["64:ff9b::7f00:1", "64:ff9b:1::7f00:1", "2002:7f00:1::", "2001::7f00:1"]) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::8888"), true);
  await assert.rejects(publicTarget(new URL("https://example.com"), async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]), /not allowed/);
  await assert.rejects(publicTarget(new URL("http://[::1]")), /not allowed/);
});

test("redirects are revalidated and fetched using a pinned address", async () => {
  const targets = [];
  const resolve = async () => [{ address: "8.8.8.8", family: 4 }];
  const result = await fetchArticleHtml("https://example.com", { resolve, request: async (url, target) => {
    targets.push(target.address);
    return targets.length === 1 ? { redirect: "/article" } : { html };
  } });
  assert.equal(result.url, "https://example.com/article");
  assert.deepEqual(targets, ["8.8.8.8", "8.8.8.8"]);
  await assert.rejects(fetchArticleHtml("https://example.com", { resolve, request: async () => ({ redirect: "http://127.0.0.1/secret" }) }), /not allowed/);
  await assert.rejects(fetchArticleHtml("https://example.com", { resolve, request: async () => ({ redirect: "/loop" }) }), /too many/);
});

test("page request enforces MIME, size limits, and cancellation on a real socket", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/slow") return;
    res.writeHead(200, { "Content-Type": req.url === "/json" ? "application/json" : "text/html" });
    res.end(html);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = (path) => new URL(`http://does-not-exist.example:${server.address().port}${path}`);
  const target = { address: "127.0.0.1", family: 4 };
  assert.equal((await requestPage(url("/"), target)).html, html);
  await assert.rejects(requestPage(url("/json"), target), /HTML/);
  await assert.rejects(requestPage(url("/"), target, undefined, 100), /limit/);
  await assert.rejects(requestPage(url("/slow"), target, AbortSignal.timeout(30)), /abort/i);
});

// Security #25: hostile pages and pasted text must not stall the server's event loop.
async function settleWithLoopStall(work) {
  let last = performance.now();
  let stall = 0;
  const timer = setInterval(() => { const now = performance.now(); stall = Math.max(stall, now - last); last = now; }, 10);
  try { return { outcome: await work.then(value => ({ value }), error => ({ error })), stall: () => stall }; }
  finally { clearInterval(timer); }
}

test("deeply nested pages are rejected before Readability's superlinear scoring", () => {
  const started = performance.now();
  assert.throws(() => extractArticle(`<html><body>${"<div>".repeat(2000)}${"Some text, more text. ".repeat(20)}</body></html>`,
    "https://example.com/"), /too deeply nested/);
  assert.ok(performance.now() - started < 3000);
  // Real articles nest 13–34 levels (measured); the guard leaves ample room.
  assert.ok(extractArticle(`<html><body>${"<div>".repeat(300)}${html}</body></html>`, "https://example.com/").text.length > 80);
});

test("article extraction runs in a bounded worker: hostile pages exhaust only its time or heap", async () => {
  const page = html => async () => ({ html, url: "https://example.com/story" });
  const ok = await readArticle("https://example.com/story", { fetchPage: page(html) });
  assert.equal(ok.title, "A garden for everyone");
  // 16,000 nesting levels take JSDOM ~24 s to parse; the worker is terminated at its deadline.
  const slow = await settleWithLoopStall(readArticle("https://example.com/", { timeoutMs: 1000,
    fetchPage: page(`<html><body>${"<div>".repeat(16_000)}text</body></html>`) }));
  assert.match(slow.outcome.error?.message, /too large or complex/);
  assert.ok(slow.stall() < 250, `event loop stalled ${slow.stall()} ms`);
  // ~3 MB of tiny elements needs ~1 GB unbounded; a capped heap fails the worker, not the server.
  const large = await settleWithLoopStall(readArticle("https://example.com/", { maxHeapMb: 64,
    fetchPage: page(`<html><body>${"<i>a</i>".repeat(370_000)}</body></html>`) }));
  assert.match(large.outcome.error?.message, /too large or complex/);
  assert.ok(large.stall() < 250, `event loop stalled ${large.stall()} ms`);
  let fetched = false;
  await assert.rejects(readArticle("file:///etc/passwd", { fetchPage: async () => { fetched = true; } }), /HTTP/);
  assert.equal(fetched, false);
  const controller = new AbortController();
  const aborted = readArticle("https://example.com/", { signal: controller.signal,
    fetchPage: page(`<html><body>${"<div>".repeat(16_000)}text</body></html>`) });
  setTimeout(() => controller.abort(new Error("client went away")), 300);
  await assert.rejects(aborted, /client went away/);
});

test("narration planning stays linear for bracket-heavy URLs and very long sentences", () => {
  let started = performance.now();
  // Each trailing bracket used to recount the whole URL: 100k characters took 67 s.
  assert.deepEqual(planNarration(`https://example.com/${")".repeat(99_980)}`), { sentences: [], chunks: [] });
  assert.ok(performance.now() - started < 3000, `URL planning took ${performance.now() - started} ms`);
  assert.equal(planNarration("See https://example.com/a_(b)). Done.").chunks[0].text.includes("example dot com"), true);
  started = performance.now();
  // A single 1M-character sentence used to re-slice its remainder for every chunk: 55 s.
  const words = "a ".repeat(500_000).trim();
  const { chunks } = planNarration(words);
  assert.ok(performance.now() - started < 5000, `sentence planning took ${performance.now() - started} ms`);
  assert.ok(chunks.every(chunk => chunk.text.length <= 500));
  assert.equal(chunks.map(chunk => chunk.text).join(" "), words);
});
