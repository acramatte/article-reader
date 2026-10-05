import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, installShutdown } from "./server.mjs";

// Isolated device-test page; API, provider, engine and shutdown are the reader's.
export function createStreamingApp(options = {}) {
  return createApp({ ...options, rootRedirect: "/streaming.html", experiment: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3027);
  const server = createStreamingApp().listen(port, host,
    () => console.log(`Streaming page: http://${host}:${port}/streaming.html`));
  installShutdown(server);
}
