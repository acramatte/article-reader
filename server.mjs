import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchArticleHtml } from "./article.mjs";
import { loadArticle, renderArticleHtml } from "./renderer-client.mjs";

const voices = new Set(["af_heart", "af_bella", "af_nicole"]);
async function readJson(request) {
  let size = 0;
  const pieces = [];
  for await (const piece of request) {
    size += piece.length;
    if (size > 150_000) throw new Error("Request body is too large.");
    pieces.push(piece);
  }
  try { return JSON.parse(Buffer.concat(pieces).toString()); }
  catch { throw new Error("Request body must be valid JSON."); }
}

export function createApp({
  ttsUrl = process.env.TTS_URL || "http://127.0.0.1:8000/tts",
  ttsToken = process.env.TTS_TOKEN,
  fetchPage = fetchArticleHtml,
  rendererUrl = process.env.ARTICLE_RENDERER_URL,
  renderPage = rendererUrl ? (value, options) => renderArticleHtml(value, { ...options, endpoint: rendererUrl }) : undefined,
  synthesize = fetch,
  staticDir = resolve("dist"),
} = {}) {
  const endpoint = new URL(ttsUrl);
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("TTS_URL must use HTTP or HTTPS.");
  return http.createServer(async (request, response) => {
    const controller = new AbortController();
    request.on("aborted", () => controller.abort());
    response.on("close", () => { if (!response.writableEnded) controller.abort(); });
    const json = (status, body, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, "http://localhost");
      // No CORS access. Reject browser cross-origin POSTs even with JSON submitted by an untrusted site.
      if (request.method === "POST") {
        if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) return json(415, { error: "JSON content type required." });
        const origin = request.headers.origin;
        if ((origin && new URL(origin).host !== request.headers.host) || request.headers["sec-fetch-site"] === "cross-site") {
          return json(403, { error: "Cross-origin requests are not allowed." });
        }
      }
      if (request.method === "POST" && url.pathname === "/api/article") {
        const body = await readJson(request);
        if (typeof body?.url !== "string") return json(400, { error: "A webpage URL is required." });
        return json(200, await loadArticle(body.url, { signal: controller.signal, fetchPage, renderPage }));
      }
      if (request.method === "POST" && url.pathname === "/api/tts") {
        const body = await readJson(request);
        if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 1_000 ||
            !voices.has(body.voice) || typeof body.speed !== "number" || !Number.isFinite(body.speed) || body.speed < 0.5 || body.speed > 2) {
          return json(400, { error: "TTS requires 1–1,000 characters, a supported voice, and speed 0.5–2." });
        }
        const upstream = await synthesize(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(ttsToken ? { Authorization: `Bearer ${ttsToken}` } : {}) },
          body: JSON.stringify({ text: body.text, voice: body.voice, speed: body.speed }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
          redirect: "error",
        });
        if (upstream.status === 503) {
          await upstream.body?.cancel();
          return json(503, { code: "INFERENCE_UNAVAILABLE", error: "Speech engine is temporarily unavailable or starting up." },
            { "Retry-After": upstream.headers.get("Retry-After") || "2" });
        }
        if (!upstream.ok) { await upstream.body?.cancel(); return json(502, { error: `Kokoro returned HTTP ${upstream.status}.` }); }
        if (!/^audio\/wav(?:;|$)/i.test(upstream.headers.get("content-type") || "")) {
          await upstream.body?.cancel();
          return json(502, { error: "Kokoro did not return WAV audio." });
        }
        const pieces = [];
        let size = 0;
        for await (const piece of upstream.body) {
          size += piece.length;
          if (size > 12_000_000) throw new Error("TTS audio exceeded the size limit.");
          pieces.push(piece);
        }
        const headers = { "Content-Type": "audio/wav", "Cache-Control": "no-store" };
        for (const name of ["X-Audio-Seconds", "X-Generation-Seconds", "X-RTF", "X-Device"]) {
          const value = upstream.headers.get(name);
          if (value) headers[name] = value;
        }
        response.writeHead(200, headers);
        return response.end(Buffer.concat(pieces));
      }
      if (request.method === "GET" && url.pathname === "/api/health") return json(200, { status: "ok" });
      if (url.pathname.startsWith("/api/")) return json(404, { error: "API route not found." });
      if (request.method !== "GET") return json(405, { error: "Method not allowed." });
      const root = resolve(staticDir);
      const path = resolve(root, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
      if (!path.startsWith(root + sep)) return json(403, { error: "Forbidden." });
      const content = await readFile(path);
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[extname(path)] || "application/octet-stream";
      response.writeHead(200, { "Content-Type": type, "X-Content-Type-Options": "nosniff" });
      response.end(content);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error.code === "ENOENT") return json(404, { error: "Not found. Run npm run build for the production UI." });
      const message = error.name === "TimeoutError" ? "The request timed out." : error.message;
      json(request.url.startsWith("/api/tts") ? 502 : 400, { error: message });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3001);
  const host = process.env.HOST || "127.0.0.1";
  createApp().listen(port, host, () => console.log(`Article backend: http://${host}:${port}`));
}
