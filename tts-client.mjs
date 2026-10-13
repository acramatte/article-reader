import { userError } from "./errors.mjs";

function wait(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function retryDelay(value, attempt, now = Date.now()) {
  const fallback = Math.min(10_000, 1000 * 2 ** attempt);
  if (!value) return fallback;
  if (/^\d+$/.test(value)) return Math.max(fallback, Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(fallback, date - now) : fallback;
}

// Retry only explicit pre-synthesis rejections: a 503 while inference starts, or a 429 while it is busy
// (inference admits one running and one waiting request). Never retry a transport failure after possible synthesis.
export async function synthesizeSpeech(body, signal, onWaiting = () => {}, {
  fetchSpeech = fetch, timeoutMs = 180_000, maxAttempts = 20,
} = {}) {
  let busy = false;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException(busy
    ? "Speech engine stayed busy. Please try again." : "Speech engine startup timed out. Please try again.", "TimeoutError")), timeoutMs);
  const combined = AbortSignal.any([signal, deadline.signal]);
  try {
    // maxAttempts bounds startup retries; busy retries are bounded by the shared deadline.
    for (let attempt = 0, busyAttempt = 0; ;) {
      combined.throwIfAborted();
      const response = await fetchSpeech("/api/tts", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: combined,
      });
      if (response.ok) return await response.arrayBuffer();
      const problem = await response.json().catch(() => ({}));
      busy = response.status === 429 && problem.code === "INFERENCE_BUSY";
      if (!busy && (response.status !== 503 || problem.code !== "INFERENCE_UNAVAILABLE")) {
        throw userError(problem.error || `Speech request failed (HTTP ${response.status}).`, 502);
      }
      if (!busy && ++attempt === maxAttempts) throw userError("Speech engine is still unavailable. Please try again shortly.", 503);
      // A busy engine has started; only startup waits are shown as warming.
      onWaiting(!busy);
      // Busy slots free within a chunk, so poll at 1–2 seconds rather than backing off to 10.
      // A Retry-After longer than the remaining budget waits until the shared deadline;
      // it must not trigger an early retry. Avoid overflowing the browser's timer range.
      const delay = busy ? retryDelay(response.headers.get("Retry-After"), Math.min(busyAttempt++, 1)) :
        retryDelay(response.headers.get("Retry-After"), attempt - 1);
      await wait(Math.min(timeoutMs, delay), combined);
    }
  } finally {
    clearTimeout(timer);
    onWaiting(false);
  }
}
