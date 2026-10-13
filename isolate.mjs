import { Worker } from "node:worker_threads";
import { userError } from "./errors.mjs";

// Runs one call of a local module's export in a fresh worker thread, so hostile input can exhaust only
// that worker's heap and time budget, never the server's event loop. The worker starts at once and loads
// its module while `args` (an array, or a promise of one) is prepared; it is always terminated afterwards.
// Errors thrown by the export keep their message and status; running out of heap or time rejects with
// `failure`, a user-facing 422 (see errors.mjs).
export async function runIsolated(module, name, args, { timeoutMs, maxHeapMb, signal, failure }) {
  const worker = new Worker(new URL("./isolated-worker.mjs", import.meta.url), {
    workerData: { module: String(module), name },
    execArgv: [], // The parent's flags (e.g. --input-type for an eval'd server) need not apply to a file.
    resourceLimits: { maxOldGenerationSizeMb: maxHeapMb, maxYoungGenerationSizeMb: Math.min(32, maxHeapMb) },
  });
  const settled = new Promise((resolve, reject) => {
    worker.once("message", ({ value, error, status }) => error === undefined ? resolve(value)
      : reject(Object.assign(new Error(error), status === undefined ? {} : { status })));
    worker.once("error", error => reject(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? userError(failure, 422) : error));
    worker.once("exit", () => reject(userError(failure, 422)));
  });
  settled.catch(() => {});
  let timer;
  let abort;
  try {
    const values = await args;
    signal?.throwIfAborted();
    worker.postMessage(values);
    return await Promise.race([settled,
      new Promise((_, reject) => { timer = setTimeout(() => reject(userError(failure, 422)), timeoutMs); }),
      ...(signal ? [new Promise((_, reject) => signal.addEventListener("abort", abort = () => reject(signal.reason), { once: true }))] : [])]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    void worker.terminate();
  }
}
