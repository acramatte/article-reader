import { parentPort, workerData } from "node:worker_threads";

// Started only by runIsolated (isolate.mjs): one call of a trusted local module's export.
const exports = await import(workerData.module);
parentPort.once("message", async args => {
  try { parentPort.postMessage({ value: await exports[workerData.name](...args) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
});
