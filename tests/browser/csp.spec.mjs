import { test, expect } from "./csp-fixture.mjs";
import { contentSecurityPolicy } from "../../csp.mjs";

test("the UI is served with the production Content-Security-Policy", async ({ page }) => {
  const response = await page.goto("/");
  expect(response.headers()["content-security-policy"]).toBe(contentSecurityPolicy);
});

test("CSP violations are detected (negative control for the shared fixture)", async ({ page, context }) => {
  await page.goto("/");
  // String-to-script assignments are now themselves Trusted Types sinks (blocked and reported by the
  // test below), so this control uses a dynamic import, which script-src still governs directly.
  await page.evaluate(() => import("data:text/javascript,window.injected = true").catch(() => {}));
  await expect.poll(() => context.cspViolations.length).toBeGreaterThan(0);
  expect(context.cspViolations[0]).toMatch(/^script-src-elem blocked data/);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  context.cspViolations.length = 0; // Expected here; every other test must finish with none.
});

test("an innerHTML assignment with a string is blocked and reported (negative control for Trusted Types)", async ({ page, context }) => {
  await page.goto("/");
  const control = await page.evaluate(() => {
    const target = document.createElement("div");
    try {
      target.innerHTML = "<p>injected markup</p>";
      return { threw: null, applied: target.innerHTML };
    } catch (error) {
      return { threw: `${error.name}: ${error.message}`, applied: target.innerHTML };
    }
  });
  // trusted-types 'none' allows no policy, so no TrustedHTML can exist: the assignment must throw
  // before any markup is parsed, and the fixture must report the violation like any other.
  expect(control.threw).toMatch(/^TypeError: .*requires 'TrustedHTML' assignment\.$/);
  expect(control.applied).toBe("");
  await expect.poll(() => context.cspViolations.length).toBeGreaterThan(0);
  expect(context.cspViolations[0]).toMatch(/^require-trusted-types-for blocked trusted-types-sink/);
  context.cspViolations.length = 0; // Expected here; every other test must finish with none.
});
