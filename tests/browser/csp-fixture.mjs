import { test as base, expect } from "@playwright/test";

// Every browser test runs under the production Content-Security-Policy (see csp.mjs) and fails on any
// violation, so a change that needs a new source fails here instead of only in production.
export const test = base.extend({
  context: async ({ context }, use) => {
    const violations = [];
    await context.exposeBinding("__reportCspViolation", (_source, violation) => { violations.push(violation); });
    await context.addInitScript(() => document.addEventListener("securitypolicyviolation", event =>
      window.__reportCspViolation(`${event.effectiveDirective} blocked ${event.blockedURI || "inline"} at ${event.sourceFile || "document"}:${event.lineNumber}`)));
    context.cspViolations = violations;
    await use(context);
    expect(violations, "Content-Security-Policy violations").toEqual([]);
  },
});

export { expect };
