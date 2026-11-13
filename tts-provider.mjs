import { isIP } from "node:net";
import { synthesizeSpeech } from "./tts-client.mjs";
import { userError } from "./errors.mjs";

const transportCodes = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

const engines = {
  pocket: { name: "Pocket TTS", voices: [
    { id: "jane", name: "Jane", group: "American English · Female", language: "en" },
    { id: "bill_boerst", name: "Bill Boerst", group: "American English · Male", language: "en" },
    { id: "estelle", name: "Estelle", group: "French · Female", language: "fr" },
  ] },
  kokoro: { name: "Kokoro", voices: [
    { id: "af_heart", name: "Heart", group: "American English · Female", language: "en" },
    { id: "am_michael", name: "Michael", group: "American English · Male", language: "en" },
    { id: "ff_siwis", name: "Siwis", group: "French · Female", language: "fr" },
  ] },
};

async function read(response, limit) {
  const pieces = [];
  let size = 0;
  for await (const piece of response.body ?? []) {
    size += piece.length;
    if (size > limit) throw userError("TTS response exceeded the size limit.", 502);
    pieces.push(piece);
  }
  return Buffer.concat(pieces);
}

// The boundary between narration and the inference service.
export function speechProvider({ ttsEngine = "pocket", ttsUrl, ttsToken, synthesize = fetch }) {
  if (!Object.hasOwn(engines, ttsEngine)) throw new Error("TTS_ENGINE must be pocket or kokoro.");
  const config = { engine: ttsEngine, ...engines[ttsEngine] };
  const endpoint = new URL(ttsUrl);
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("TTS_URL must use HTTP or HTTPS.");
  // Plain HTTP exposes the bearer token to every hop; only loopback traffic stays on this machine.
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "[::1]" ||
    (isIP(endpoint.hostname) === 4 && endpoint.hostname.startsWith("127."));
  if (ttsToken && endpoint.protocol === "http:" && !loopback) throw new Error("TTS_TOKEN requires an HTTPS TTS_URL (plain HTTP only to loopback).");
  const fetchWav = async (body, signal) => {
    const upstream = await synthesize(endpoint, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", ...(ttsToken ? { Authorization: `Bearer ${ttsToken}` } : {}) },
      body: JSON.stringify(body), signal,
    }).catch(error => {
      // Surface bounded error codes, never endpoint URLs, headers or raw transport diagnostics.
      if (transportCodes.has(error.cause?.code)) throw userError(`Speech engine connection failed (${error.cause.code}).`, 502);
      throw error;
    });
    if (!upstream.ok) {
      // Both inference services reject a voice outside their catalog with FastAPI's 422 naming that field, and the
      // reader sends only its own engine's voices: the endpoint serves another engine than TTS_ENGINE.
      const detail = upstream.status === 422 ? await read(upstream, 65_536).then(bytes => JSON.parse(bytes).detail, () => null) : null;
      await upstream.body?.cancel();
      if (Array.isArray(detail) && detail.some(problem => Array.isArray(problem?.loc) && problem.loc.at(-1) === "voice")) {
        return Response.json({ error: `The speech endpoint does not offer the ${config.name} voice "${body.voice}". Set TTS_ENGINE to the engine at TTS_URL.` }, { status: 502 });
      }
      // Both statuses reject a request before synthesis starts, so callers may retry them.
      const retryable = {
        503: { code: "INFERENCE_UNAVAILABLE", error: "Speech engine is temporarily unavailable or starting up." },
        429: { code: "INFERENCE_BUSY", error: `${config.name} is busy with other speech. Please try again shortly.` },
      }[upstream.status];
      // synthesizeSpeech retries the coded statuses and turns any other `error` into a user-facing one.
      return new Response(JSON.stringify(retryable || { error: `${config.name} returned HTTP ${upstream.status}.` }), {
        status: retryable ? upstream.status : 502,
        headers: { "Content-Type": "application/json", "Retry-After": upstream.headers.get("Retry-After") || "2" },
      });
    }
    if (!/^audio\/wav(?:;|$)/i.test(upstream.headers.get("content-type") || "")) {
      await upstream.body?.cancel();
      throw userError(`${config.name} did not return WAV audio.`, 502);
    }
    return new Response(await read(upstream, 12_000_000));
  };
  return {
    config,
    synthesizeChunk: (body, signal, onWaiting) => synthesizeSpeech(body, signal, onWaiting, {
      fetchSpeech: (_path, request) => fetchWav(JSON.parse(request.body), request.signal),
    }),
  };
}
