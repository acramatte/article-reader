import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.READER_BACKEND_PORT || 3001}`,
        changeOrigin: false,
      },
    },
  },
});
