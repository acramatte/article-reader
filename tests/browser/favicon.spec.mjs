import { test, expect } from "@playwright/test";

test("the page declares a loadable SVG favicon", async ({ page }) => {
  await page.goto("/");
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute("type", "image/svg+xml");
  await expect(icon).toHaveAttribute("href", "/favicon.svg");

  const response = await page.request.get(await icon.getAttribute("href"));
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
  expect(await response.text()).toContain('viewBox="0 0 32 32"');

  const dimensions = await page.evaluate(async () => {
    const image = new Image();
    image.src = document.querySelector('link[rel="icon"]').href;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  });
  expect(dimensions.width).toBeGreaterThan(0);
  expect(dimensions.width).toBe(dimensions.height);
});
