// User-facing errors are marked explicitly: an integer `status` property means the message is
// safe to show to clients (validation, extraction, bounded upstream rejections). Everything else
// is internal; server.mjs returns a generic message for it and logs the details instead.
export function userError(message, status) {
  return Object.assign(new Error(message), { status });
}
