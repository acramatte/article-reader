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

// Retry only an explicit upstream 503, never a transport failure after possible synthesis.
export async function synthesizeSpeech(body, signal, onWaiting = () => {}, {
  fetchSpeech = fetch, timeoutMs = 180_000, maxAttempts = 20,
} = {}) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("Speech engine startup timed out. Please try again.", "TimeoutError")), timeoutMs);
  const combined = AbortSignal.any([signal, deadline.signal]);
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      combined.throwIfAborted();
      const response = await fetchSpeech("/api/tts", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: combined,
      });
      if (response.ok) return await response.arrayBuffer();
      const problem = await response.json().catch(() => ({}));
      if (response.status !== 503 || problem.code !== "INFERENCE_UNAVAILABLE") {
        throw new Error(problem.error || `Speech request failed (HTTP ${response.status}).`);
      }
      if (attempt + 1 === maxAttempts) throw new Error("Speech engine is still unavailable. Please try again shortly.");
      onWaiting(true);
      // A Retry-After longer than the remaining budget waits until the shared deadline;
      // it must not trigger an early retry. Avoid overflowing the browser's timer range.
      await wait(Math.min(timeoutMs, retryDelay(response.headers.get("Retry-After"), attempt)), combined);
    }
  } finally {
    clearTimeout(timer);
    onWaiting(false);
  }
}
