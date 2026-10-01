import { defineConfig } from "@playwright/test";
import { join } from "node:path";

const uiPort = Number(process.env.READER_UI_PORT || 5197);
const backendPort = Number(process.env.READER_BACKEND_PORT || 3017);

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1, // The local Kokoro service serializes inference.
  outputDir: join(".ui-review", "playwright"),
  use: { baseURL: `http://127.0.0.1:${uiPort}`, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: [
    { command: "npm run backend", env: { PORT: String(backendPort) }, url: `http://127.0.0.1:${backendPort}/api/health`, reuseExistingServer: false },
    { command: `npm run dev -- --host 127.0.0.1 --port ${uiPort} --strictPort`, env: { READER_BACKEND_PORT: String(backendPort) }, url: `http://127.0.0.1:${uiPort}`, reuseExistingServer: false },
  ],
});
