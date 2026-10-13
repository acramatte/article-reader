import { defineConfig } from "vite";
import { contentSecurityPolicy } from "./csp.mjs";

// Serve the production policy in development too, so browser tests catch violations.
const headers = { "Content-Security-Policy": contentSecurityPolicy };

export default defineConfig({
  server: {
    headers,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.READER_BACKEND_PORT || 3001}`,
        changeOrigin: false,
      },
    },
  },
  preview: { headers },
});
