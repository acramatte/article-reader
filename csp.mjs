// One Content-Security-Policy for every way the UI is served: server.mjs sends it with static files and
// vite.config.js with the dev server, so browser tests run under the production policy.
// The UI needs same-origin script/media/connect/img and the built pages' inline <style> blocks;
// everything else stays denied (no framing, no plugins, no base hijack).
export const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");
