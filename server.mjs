import http from "node:http";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchArticleHtml, readArticle } from "./article.mjs";
import { userError } from "./errors.mjs";
import { contentSecurityPolicy } from "./csp.mjs";
import { speechProvider } from "./tts-provider.mjs";
import { createStreamingApi } from "./streaming-api.mjs";

// User-facing errors are marked explicitly: an integer `status` property means the message is
// safe to show (validation, extraction, bounded upstream rejections). Everything else is internal;
// the client gets a generic message and the server logs the details. See errors.mjs.
export { userError } from "./errors.mjs";

export async function readJson(request, { maxBytes = 150_000 } = {}) {
  let size = 0;
  const pieces = [];
  // Do not destroy the socket when rejecting a body: callers must receive JSON errors.
  for await (const piece of request.iterator({ destroyOnReturn: false })) {
    size += piece.length;
    if (size > maxBytes) { request.resume(); throw userError("Request body is too large.", 413); }
    pieces.push(piece);
  }
  try { return JSON.parse(Buffer.concat(pieces).toString()); }
  catch { throw userError("Request body must be valid JSON.", 400); }
}

// DNS rebinding: a hostile page can resolve its own name to this server; the browser then sends that name
// as Host and Origin, which match each other. Rebinding needs a DNS name, so IP literals and localhost are
// always this server; other names must be listed in ALLOWED_HOSTS (comma-separated).
export function allowedHost(host, names) {
  if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.test(host || "")) return false;
  const hostname = new URL(`http://${host}`).hostname;
  return isIP(hostname.replace(/^\[|\]$/g, "")) !== 0 || hostname === "localhost" || names.includes(hostname);
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
  allowedHosts = (process.env.ALLOWED_HOSTS || "").split(",").map(name => name.trim().toLowerCase()).filter(Boolean),
  extraction = {},
  ...streamingOptions
} = {}) {
  const provider = speechProvider({ ttsEngine, ttsUrl, ttsToken, synthesize });
  // Voice ID → language, for sentence segmentation.
  const voices = new Map(provider.config.voices.map(voice => [voice.id, voice.language]));
  const streaming = createStreamingApi({ ...streamingOptions, voices,
    synthesizeChunk: synthesizeChunk || provider.synthesizeChunk }, readJson);
  // One extraction worker at a time: each may use a few hundred MB while parsing a page.
  let extracting = false;
  const server = http.createServer(async (request, response) => {
    const controller = new AbortController();
    request.on?.("aborted", () => controller.abort());
    response.on?.("close", () => { if (!response.writableEnded) controller.abort(); });
    const json = (status, body, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
      response.end(JSON.stringify(body));
    };
    try {
      if (!allowedHost(request.headers.host, allowedHosts)) {
        return json(403, { error: "This host name is not allowed. Add it to ALLOWED_HOSTS to serve it." });
      }
      const url = new URL(request.url, "http://localhost");
      if (experiment) response.setHeader("X-Reader-Experiment", "continuous-mp3-v1");
      if (request.method === "GET" && url.pathname === "/" && rootRedirect) {
        response.writeHead(302, { Location: rootRedirect, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
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
        if (extracting) return json(429, { error: "Another article is being read. Please try again shortly." }, { "Retry-After": "2" });
        extracting = true;
        try { return json(200, await readArticle(body.url, { fetchPage, signal: controller.signal, ...extraction })); }
        // article.mjs throws only intentional user-facing messages (validation, fetch, extraction):
        // unmarked ones default to 422 here; an explicitly marked status passes through, and a
        // fetch timeout keeps its name so the catch maps it to the generic timeout message.
        catch (error) { if (error.name !== "TimeoutError") throw userError(error.message, error.status ?? 422); throw error; }
        finally { extracting = false; }
      }
      if (request.method === "POST" && url.pathname === "/api/tts") {
        const body = await readJson(request);
        if (typeof body?.text !== "string" || !/[\p{L}\p{N}]/u.test(body.text) || body.text.length > 1_000 ||
            !voices.has(body.voice) || body.speed !== 1) {
          return json(400, { error: "Raw WAV requires 1–1,000 characters containing a letter or number, a supported voice, and speed 1. Use /api/streaming for adjusted speed." });
        }
        const upstream = await provider.fetchWav({ text: body.text, voice: body.voice, speed: body.speed },
          AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
        if (!upstream.ok) {
          const retryAfter = upstream.headers.get("Retry-After");
          const headers = [429, 503].includes(upstream.status) && retryAfter !== null ? { "Retry-After": retryAfter } : {};
          return json(upstream.status, await upstream.json(), headers);
        }
        const headers = { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
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
      response.writeHead(200, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": contentSecurityPolicy });
      response.end(content);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      if (controller.signal.aborted) return;
      if (error.code === "ENOENT") return json(404, { error: "Not found. Run npm run build for the production UI." });
      // Marked errors are intentionally user-facing; anything else is internal and reaches the
      // client only as a generic message, with its details logged here.
      if (Number.isSafeInteger(error.status)) return json(error.status, { error: error.message },
        error.status === 429 ? { "Retry-After": "2" } : {});
      if (error.name !== "TimeoutError") console.error(request.method, request.url, error.name, error.message);
      json(request.url.startsWith("/api/tts") ? 502 : 400,
        { error: error.name === "TimeoutError" ? "The request timed out." : "The request could not be completed." });
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
