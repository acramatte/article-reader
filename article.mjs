import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export class ArticleError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid HTTP or HTTPS URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (url.port && !["80", "443"].includes(url.port))) {
    throw new Error("Only HTTP/HTTPS URLs on standard ports without credentials are supported.");
  }
  return url;
}

export function isPublicAddress(address) {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}

export async function publicTarget(url, resolve = lookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = ipaddr.isValid(hostname)
    ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === "ipv6" ? 6 : 4 }]
    : await resolve(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Private, local, and reserved network addresses are not allowed.");
  }
  return addresses[0];
}

// Pin the checked IP to this connection; redirects each get a fresh validation.
export function requestPage(url, target, signal, maxBytes = 3_000_000, { accept = "text/html,application/xhtml+xml", mime = /^(text\/html|application\/xhtml\+xml)(;|$)/i } = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.get(url, {
      signal,
      agent: false,
      lookup: (_hostname, options, callback) => {
        callback(null, options.all ? [target] : target.address, target.family);
      },
      headers: { "User-Agent": "ArticleReader/1.0", Accept: accept, "Accept-Encoding": "identity" },
    }, (response) => {
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        resolve({ redirect: response.headers.location });
        return;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        reject(new ArticleError(`The webpage returned HTTP ${status}.`, [403, 429].includes(status) ? "HTTP_BLOCK" : "HTTP_ERROR"));
        return;
      }
      if (!mime.test(response.headers["content-type"] || "")) {
        response.destroy();
        reject(new Error("The URL did not return an HTML webpage."));
        return;
      }
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        response.destroy();
        reject(new Error("The webpage returned unsupported compressed content."));
        return;
      }
      let size = 0;
      const pieces = [];
      response.on("data", (piece) => {
        size += piece.length;
        if (size > maxBytes) response.destroy(new Error("The webpage exceeds the 3 MB limit."));
        else pieces.push(piece);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ html: Buffer.concat(pieces).toString("utf8") }));
    });
    request.on("error", reject);
  });
}

export async function fetchArticleHtml(value, { signal, resolve = lookup, request = requestPage } = {}) {
  const deadline = AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
  let url = validateUrl(value);
  for (let redirects = 0; redirects <= 5; redirects++) {
    deadline.throwIfAborted();
    const target = await publicTarget(url, resolve);
    deadline.throwIfAborted();
    const result = await request(url, target, deadline);
    if (result.html !== undefined) return { html: result.html, url: url.href };
    if (!result.redirect) throw new Error("The webpage returned an invalid redirect.");
    url = validateUrl(new URL(result.redirect, url).href);
  }
  throw new Error("The webpage redirected too many times.");
}

export function extractArticle(html, url) {
  const dom = new JSDOM(html, { url }); // Scripts and remote resources are deliberately disabled.
  try {
    const article = new Readability(dom.window.document, { maxElemsToParse: 50_000 }).parse();
    if (!article) throw new ArticleError("No readable article found. Try another URL or paste the text.", "RENDER_NEEDED");
    const content = new JSDOM(article.content);
    try {
      const document = content.window.document;
      document.querySelectorAll("script,style,nav,aside,form,button,iframe").forEach((node) => node.remove());
      const normalize = (text) => text.replace(/\s+/g, " ").trim();
      const blocks = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote")]
        .filter((node) => !node.querySelector("p,li,pre,blockquote"))
        .map((node) => normalize(node.textContent)).filter(Boolean);
      const text = (blocks.length ? blocks.join("\n\n") : normalize(document.body.textContent));
      if (text.length < 80) throw new ArticleError("Not enough article text found. This page may require JavaScript or a login.", "RENDER_NEEDED");
      if (text.length > 100_000) throw new Error("The article exceeds the 100,000 character limit.");
      return { title: article.title || new URL(url).hostname, byline: article.byline || "", url, text };
    } finally { content.window.close(); }
  } finally { dom.window.close(); }
}
