import { StreamingNarrations } from "./streaming.mjs";

const metadataLimits = { title: 200, byline: 500, sourceUrl: 2048 };
const metadataBodyBytes = 6 * Object.values(metadataLimits).reduce((sum, size) => sum + size, 0) + 1024;

const limits = {
  maxTextChars: ["STREAM_MAX_TEXT_CHARS", 100_000, 1_000_000],
  maxAudioBytes: ["STREAM_MAX_AUDIO_BYTES", 64_000_000, 1_000_000_000],
  generationMs: ["STREAM_GENERATION_MS", 1_200_000, 86_400_000],
  retentionMs: ["STREAM_RETENTION_MS", 21_600_000, 604_800_000],
  disconnectMs: ["STREAM_DISCONNECT_MS", 120_000, 86_400_000],
  maxSessions: ["STREAM_MAX_SESSIONS", 4, 100],
};

export function streamingLimits(options = {}, env = process.env) {
  return Object.fromEntries(Object.entries(limits).map(([key, [name, fallback, max]]) => {
    const raw = options[key] ?? env[name] ?? fallback;
    if ((typeof raw === "string" && !/^[1-9]\d*$/.test(raw)) ||
        !["number", "string"].includes(typeof raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > max) {
      throw new Error(`${name} must be a positive integer no greater than ${max}.`);
    }
    return [key, Number(raw)];
  }));
}

function validate(body, maxTextChars, voices) {
  if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > maxTextChars ||
      !voices.has(body.voice) || typeof body.speed !== "number" || !Number.isFinite(body.speed) || body.speed < 0.5 || body.speed > 2 ||
      (body.paceSeconds !== undefined && (!Number.isInteger(body.paceSeconds) || body.paceSeconds < 0 || body.paceSeconds > 8))) {
    throw new Error(`Streaming requires 1–${maxTextChars} characters, a supported voice, speed 0.5–2 and pacing 0–8 seconds.`);
  }
  for (const [key, max] of Object.entries(metadataLimits)) {
    if (body[key] !== undefined && (typeof body[key] !== "string" || body[key].length > max)) {
      throw new Error(`${key} must be a string of at most ${max} characters.`);
    }
  }
  if (body.sourceUrl !== undefined) {
    let url;
    try { url = new URL(body.sourceUrl); } catch { throw new Error("sourceUrl must be an HTTP(S) URL without credentials."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("sourceUrl must be an HTTP(S) URL without credentials.");
    }
  }
}

export function createStreamingApi(options, readJson) {
  const config = streamingLimits(options);
  const narrations = new StreamingNarrations({ ...options, ...config });
  const handle = async (url, request, response, json) => {
    if (!url.pathname.startsWith("/api/streaming")) return false;
    if (request.method === "POST" && url.pathname === "/api/streaming") {
      const body = await readJson(request, { maxBytes: 6 * config.maxTextChars + metadataBodyBytes });
      validate(body, config.maxTextChars, options.voices);
      const session = await narrations.create(body);
      json(201, { id: session.id, audioUrl: `/api/streaming/${session.id}/audio` });
      return true;
    }
    const route = /^\/api\/streaming\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(status|content|audio|stop|mark)$/.exec(url.pathname);
    const session = route && narrations.sessions.get(route[1]);
    if (!session) { json(404, { error: "Streaming session expired or does not exist." }); return true; }
    const action = route[2];
    if (request.method === "GET" && action === "status") json(200, narrations.snapshot(session));
    else if (request.method === "GET" && action === "content") {
      if (session.text === null) json(410, { error: "Narration content is no longer available." });
      else json(200, { text: session.text, title: session.title, byline: session.byline, sourceUrl: session.sourceUrl,
        voice: session.voice, speed: session.speed });
    } else if (request.method === "GET" && action === "audio") await narrations.audio(session, request, response);
    else if (request.method === "POST" && action === "stop") {
      await narrations.stop(session); json(200, narrations.snapshot(session));
    } else if (request.method === "POST" && action === "mark") {
      const body = await readJson(request);
      if (typeof body?.playbackSeconds !== "number" || !Number.isFinite(body.playbackSeconds) || body.playbackSeconds < 0) {
        json(400, { error: "A playback position is required." });
      } else {
        session.mark = { at: Date.now(), generated: session.generated, bytes: session.bytes,
          audioSecondsGenerated: session.audioSecondsGenerated, playbackSeconds: body.playbackSeconds };
        json(200, narrations.snapshot(session));
      }
    } else json(405, { error: "Method not allowed." });
    return true;
  };
  return { narrations, config, handle };
}
