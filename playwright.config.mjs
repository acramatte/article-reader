import { defineConfig } from "@playwright/test";
import { join } from "node:path";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1, // The local Kokoro service serializes inference.
  outputDir: join(process.env.TMPDIR || ".", "tts-playwright"),
  use: { baseURL: "http://127.0.0.1:5173", screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: [
    { command: "npm run backend", url: "http://127.0.0.1:3001/api/health", reuseExistingServer: !process.env.CI },
    { command: "npm run dev -- --port 5173 --strictPort", url: "http://127.0.0.1:5173", reuseExistingServer: !process.env.CI },
  ],
});
