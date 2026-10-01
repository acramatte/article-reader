import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [VitePWA({
    // Wait for open sessions to close before activating an update; never reload playback.
    registerType: "prompt",
    injectRegister: false,
    includeAssets: ["favicon.svg", "apple-touch-icon.png", "icons/*.png"],
    manifest: {
      id: "/",
      name: "Article Reader",
      short_name: "Article Reader",
      description: "Turn online articles into something you can listen to.",
      lang: "en",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#f3f6f5",
      theme_color: "#126b59",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    workbox: {
      skipWaiting: false,
      clientsClaim: false,
      globPatterns: ["**/*.{js,css,html}"],
      navigateFallback: "index.html",
      navigateFallbackDenylist: [/^\/api(?:\/|$)/],
      // No runtime caching: article text, URLs, API responses and audio stay private.
      runtimeCaching: [],
    },
  })],
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.READER_BACKEND_PORT || 3001}`,
        changeOrigin: false,
      },
    },
  },
});
