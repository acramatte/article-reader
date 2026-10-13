// One Content-Security-Policy for every way the UI is served: server.mjs sends it with static files and
// vite.config.js with the dev server, so browser tests run under the production policy.
// The UI needs same-origin script/styles/media/connect/img; all styling ships as external
// stylesheets, so inline <style> and style="" attributes stay denied;
// everything else stays denied too (no framing, no plugins, no base hijack).
export const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");
