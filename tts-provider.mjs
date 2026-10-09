import { synthesizeSpeech } from "./tts-client.mjs";

const transportCodes = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

const engines = {
  pocket: { name: "Pocket TTS", voices: [
    { id: "jane", name: "Jane", group: "American English · Female" },
    { id: "bill_boerst", name: "Bill Boerst", group: "American English · Male" },
    { id: "estelle", name: "Estelle", group: "French · Female" },
  ] },
  kokoro: { name: "Kokoro", voices: [
    { id: "af_heart", name: "Heart", group: "American English · Female" },
    { id: "am_michael", name: "Michael", group: "American English · Male" },
    { id: "ff_siwis", name: "Siwis", group: "French · Female" },
  ] },
};

// One provider boundary for the legacy WAV API and continuous narration.
export function speechProvider({ ttsEngine = "pocket", ttsUrl, ttsToken, synthesize = fetch }) {
  if (!Object.hasOwn(engines, ttsEngine)) throw new Error("TTS_ENGINE must be pocket or kokoro.");
  const config = { engine: ttsEngine, ...engines[ttsEngine] };
  const endpoint = new URL(ttsUrl);
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("TTS_URL must use HTTP or HTTPS.");
  const fetchWav = async (body, signal) => {
    const upstream = await synthesize(endpoint, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", ...(ttsToken ? { Authorization: `Bearer ${ttsToken}` } : {}) },
      body: JSON.stringify(body), signal,
    }).catch(error => {
      // Surface bounded error codes, never endpoint URLs, headers or raw transport diagnostics.
      if (transportCodes.has(error.cause?.code)) throw new Error(`Speech engine connection failed (${error.cause.code}).`, { cause: error });
      throw error;
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return new Response(JSON.stringify(upstream.status === 503
        ? { code: "INFERENCE_UNAVAILABLE", error: "Speech engine is temporarily unavailable or starting up." }
        : { error: `${config.name} returned HTTP ${upstream.status}.` }), {
        status: upstream.status === 503 ? 503 : 502,
        headers: { "Content-Type": "application/json", "Retry-After": upstream.headers.get("Retry-After") || "2" },
      });
    }
    if (!/^audio\/wav(?:;|$)/i.test(upstream.headers.get("content-type") || "")) {
      await upstream.body?.cancel();
      throw new Error(`${config.name} did not return WAV audio.`);
    }
    const pieces = [];
    let size = 0;
    for await (const piece of upstream.body) {
      size += piece.length;
      if (size > 12_000_000) throw new Error("TTS audio exceeded the size limit.");
      pieces.push(piece);
    }
    const headers = { "Content-Type": "audio/wav" };
    for (const name of ["X-Audio-Seconds", "X-Generation-Seconds", "X-RTF", "X-Device"]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    return new Response(Buffer.concat(pieces), { headers });
  };
  return {
    config,
    fetchWav,
    synthesizeChunk: (body, signal, onWaiting) => synthesizeSpeech(body, signal, onWaiting, {
      fetchSpeech: (_path, request) => fetchWav(JSON.parse(request.body), request.signal),
    }),
  };
}
