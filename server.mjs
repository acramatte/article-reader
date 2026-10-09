import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchArticleHtml, extractArticle } from "./article.mjs";
import { speechProvider } from "./tts-provider.mjs";
import { createStreamingApi } from "./streaming-api.mjs";

export async function readJson(request, { maxBytes = 150_000 } = {}) {
  let size = 0;
  const pieces = [];
  // Do not destroy the socket when rejecting a body: callers must receive JSON errors.
  for await (const piece of request.iterator({ destroyOnReturn: false })) {
    size += piece.length;
    if (size > maxBytes) { request.resume(); throw new Error("Request body is too large."); }
    pieces.push(piece);
  }
  try { return JSON.parse(Buffer.concat(pieces).toString()); }
  catch { throw new Error("Request body must be valid JSON."); }
}

export function createApp({
  ttsEngine = process.env.TTS_ENGINE || "pocket",
  ttsUrl = process.env.TTS_URL || "http://127.0.0.1:8000/tts",
  ttsToken = process.env.TTS_TOKEN,
  fetchPage = fetchArticleHtml,
  synthesize = fetch,
  staticDir = resolve("dist"),
  synthesizeChunk,
  rootRedirect,
  experiment = false,
  ...streamingOptions
} = {}) {
  const provider = speechProvider({ ttsEngine, ttsUrl, ttsToken, synthesize });
  const voices = new Set(provider.config.voices.map(voice => voice.id));
  const streaming = createStreamingApi({ ...streamingOptions, voices,
    synthesizeChunk: synthesizeChunk || provider.synthesizeChunk }, readJson);
  const server = http.createServer(async (request, response) => {
    const controller = new AbortController();
    request.on?.("aborted", () => controller.abort());
    response.on?.("close", () => { if (!response.writableEnded) controller.abort(); });
    const json = (status, body, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, "http://localhost");
      if (experiment) response.setHeader("X-Reader-Experiment", "continuous-mp3-v1");
      if (request.method === "GET" && url.pathname === "/" && rootRedirect) {
        response.writeHead(302, { Location: rootRedirect, "Cache-Control": "no-store" });
        return response.end();
      }
      if (["/streaming.html", "/streaming.js", "/streaming-state.js", "/tts-settings.js"].includes(url.pathname)) response.setHeader("Cache-Control", "no-store");
      // No CORS access; recording reads are protected too, not just state-changing POSTs.
      if (request.method === "POST" || url.pathname.startsWith("/api/streaming")) {
        if (request.method === "POST" && !/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) return json(415, { error: "JSON content type required." });
        const origin = request.headers.origin;
        if ((origin && new URL(origin).host !== request.headers.host) || request.headers["sec-fetch-site"] === "cross-site") {
          return json(403, { error: "Cross-origin requests are not allowed." });
        }
      }
      if (await streaming.handle(url, request, response, json)) return;
      if (request.method === "GET" && url.pathname === "/api/config") return json(200, { ...streaming.config, tts: provider.config });
      if (request.method === "POST" && url.pathname === "/api/article") {
        const body = await readJson(request);
        if (typeof body?.url !== "string") return json(400, { error: "A webpage URL is required." });
        const page = await fetchPage(body.url, { signal: controller.signal });
        return json(200, extractArticle(page.html, page.url));
      }
      if (request.method === "POST" && url.pathname === "/api/tts") {
        const body = await readJson(request);
        if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 1_000 ||
            !voices.has(body.voice) || body.speed !== 1) {
          return json(400, { error: "Raw WAV requires 1–1,000 characters, a supported voice, and speed 1. Use /api/streaming for adjusted speed." });
        }
        const upstream = await provider.fetchWav({ text: body.text, voice: body.voice, speed: body.speed },
          AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
        if (!upstream.ok) return json(upstream.status, await upstream.json(),
          upstream.status === 503 ? { "Retry-After": upstream.headers.get("Retry-After") } : {});
        const headers = { "Content-Type": "audio/wav", "Cache-Control": "no-store" };
        for (const name of ["X-Audio-Seconds", "X-Generation-Seconds", "X-RTF", "X-Device"]) {
          const value = upstream.headers.get(name);
          if (value) headers[name] = value;
        }
        response.writeHead(200, headers);
        return response.end(Buffer.from(await upstream.arrayBuffer()));
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
      if (response.headersSent) return response.destroy();
      if (controller.signal.aborted) return;
      if (error.code === "ENOENT") return json(404, { error: "Not found. Run npm run build for the production UI." });
      const message = error.name === "TimeoutError" ? "The request timed out." : error.message;
      json(error.status || (request.url.startsWith("/api/tts") ? 502 : 400), { error: message },
        error.status === 429 ? { "Retry-After": "2" } : {});
    }
  });
  server.narrations = streaming.narrations;
  server.on("close", () => { void streaming.narrations.close(); });
  server.shutdown = () => shutdownServer(server);
  return server;
}

export function shutdownServer(server) {
  return server.shutdownPromise ??= (async () => {
    const engineClosed = server.narrations.close();
    const connectionsClosed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await Promise.all([engineClosed, connectionsClosed]);
  })();
}

export function installShutdown(server) {
  const shutdown = () => { void server.shutdown().catch(error => { console.error(error.message); process.exitCode = 1; }); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3001);
  const host = process.env.HOST || "127.0.0.1";
  const server = createApp().listen(port, host, () => console.log(`Article backend: http://${host}:${port}`));
  installShutdown(server);
}
