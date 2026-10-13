import { test, expect } from "./csp-fixture.mjs";
import { contentSecurityPolicy } from "../../csp.mjs";

test("the UI is served with the production Content-Security-Policy", async ({ page }) => {
  const response = await page.goto("/");
  expect(response.headers()["content-security-policy"]).toBe(contentSecurityPolicy);
});

test("CSP violations are detected (negative control for the shared fixture)", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.injected = true";
    document.head.append(script);
  });
  await expect.poll(() => context.cspViolations.length).toBeGreaterThan(0);
  expect(context.cspViolations[0]).toMatch(/^script-src-elem blocked inline/);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  context.cspViolations.length = 0; // Expected here; every other test must finish with none.
});
