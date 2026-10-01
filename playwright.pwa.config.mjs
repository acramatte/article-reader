import { defineConfig } from "@playwright/test";
import { join } from "node:path";

const port = Number(process.env.READER_PWA_PORT || 5297);

// Service-worker coverage must exercise the production build, not Vite dev mode.
export default defineConfig({
  testDir: "./tests/pwa",
  timeout: 30_000,
  expect: { timeout: 15_000 },
  workers: 1,
  outputDir: join(".ui-review", "pwa"),
  use: { baseURL: `http://127.0.0.1:${port}`, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: {
    command: "npm start",
    env: { HOST: "127.0.0.1", PORT: String(port) },
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
  },
});
