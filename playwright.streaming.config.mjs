import { defineConfig } from "@playwright/test";

const port = Number(process.env.STREAM_TEST_PORT || 3028);
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "streaming.spec.mjs",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  outputDir: ".ui-review/streaming-playwright",
  use: { baseURL: `http://127.0.0.1:${port}`, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "npm run streaming", url: `http://127.0.0.1:${port}/api/health`, reuseExistingServer: false,
    env: { HOST: "127.0.0.1", PORT: String(port), TTS_URL: process.env.TTS_URL || "http://127.0.0.1:8027/tts" } },
});
