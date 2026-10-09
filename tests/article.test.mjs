import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { validateUrl, isPublicAddress, publicTarget, fetchArticleHtml, extractArticle, requestPage } from "../article.mjs";
import { chunkText } from "../chunks.mjs";
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
    ["«L’été arrive !»", "2026", "漢字", "١٢"]);
  const fragments = chunkText("-".repeat(20) + "«Salut.»" + "-".repeat(30), { firstLimit: 10, limit: 10 });
  assert.ok(fragments.every(chunk => /[\p{L}\p{N}]/u.test(chunk) && chunk.length <= 10));
  assert.equal(fragments.join("").replaceAll("-", ""), "«Salut.»");
  assert.deepEqual(chunkText("  «»“”()[] — *** 🎵 \n\n ... "), []);
});

test("URL and IP validation rejects SSRF targets, credentials, schemes, and ports", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com", "https://name:pass@example.com", "http://example.com:8000", "bad"]) assert.throws(() => validateUrl(url));
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("8.8.8.8"), true);
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
