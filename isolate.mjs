import { Worker } from "node:worker_threads";

// Runs one call of a local module's export in a fresh worker thread, so hostile input can exhaust only
// that worker's heap and time budget, never the server's event loop. The worker starts at once and loads
// its module while `args` (an array, or a promise of one) is prepared; it is always terminated afterwards.
// Errors thrown by the export keep their message; running out of heap or time rejects with `failure`.
export async function runIsolated(module, name, args, { timeoutMs, maxHeapMb, signal, failure }) {
  const worker = new Worker(new URL("./isolated-worker.mjs", import.meta.url), {
    workerData: { module: String(module), name },
    execArgv: [], // The parent's flags (e.g. --input-type for an eval'd server) need not apply to a file.
    resourceLimits: { maxOldGenerationSizeMb: maxHeapMb, maxYoungGenerationSizeMb: Math.min(32, maxHeapMb) },
  });
  const settled = new Promise((resolve, reject) => {
    worker.once("message", ({ value, error }) => error === undefined ? resolve(value) : reject(new Error(error)));
    worker.once("error", error => reject(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? new Error(failure) : error));
    worker.once("exit", () => reject(new Error(failure)));
  });
  settled.catch(() => {});
  let timer;
  let abort;
  try {
    const values = await args;
    signal?.throwIfAborted();
    worker.postMessage(values);
    return await Promise.race([settled,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(failure)), timeoutMs); }),
      ...(signal ? [new Promise((_, reject) => signal.addEventListener("abort", abort = () => reject(signal.reason), { once: true }))] : [])]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    void worker.terminate();
  }
}
