import { test, expect } from "@playwright/test";

async function control(page) {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  // Prompt-mode workers do not claim already-open pages; the next navigation is controlled.
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

async function cachedUrls(page) {
  return page.evaluate(async () => {
    const urls = [];
    for (const key of await caches.keys()) {
      for (const request of await (await caches.open(key)).keys()) urls.push(new URL(request.url).pathname);
    }
    return urls.sort();
  });
}

test("production manifest is installable with standalone display and Android/Apple icons", async ({ page }) => {
  await control(page);
  const link = page.locator('link[rel="manifest"]');
  const response = await page.request.get(await link.getAttribute("href"));
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = await response.json();
  expect(manifest).toMatchObject({ id: "/", name: "Article Reader", start_url: "/", scope: "/", display: "standalone", theme_color: "#126b59", background_color: "#f3f6f5" });
  expect(manifest.icons).toHaveLength(3);
  expect(manifest.icons.map(({ sizes, purpose }) => [sizes, purpose])).toEqual([["192x192", "any"], ["512x512", "any"], ["512x512", "maskable"]]);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", manifest.theme_color);
  const apple = page.locator('link[rel="apple-touch-icon"]');
  await expect(apple).toHaveAttribute("sizes", "180x180");
  for (const { src, sizes } of [...manifest.icons, { src: await apple.getAttribute("href"), sizes: "180x180" }]) {
    const response = await page.request.get(src);
    expect(response.headers()["content-type"]).toContain("image/png");
    const image = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = image.naturalWidth;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = true;
      let safe = true;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const offset = (y * canvas.width + x) * 4;
        if (data[offset + 3] !== 255) opaque = false;
        if (data[offset] > 200 && Math.hypot(x - canvas.width / 2, y - canvas.height / 2) > canvas.width * 0.4) safe = false;
      }
      return { sizes: `${image.naturalWidth}x${image.naturalHeight}`, opaque, safe };
    }, src);
    expect(image).toEqual({ sizes, opaque: true, safe: true });
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.enable");
  const appManifest = await cdp.send("Page.getAppManifest");
  expect(appManifest.errors).toEqual([]);
  // Chromium's own installability validation, not just our JSON assertions.
  await expect.poll(async () => (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([]);
  const worker = await page.request.get("/sw.js");
  expect(worker.headers()["cache-control"]).toBe("no-cache");
  // Prompt mode includes only an explicitly messaged activation handler.
  expect(await worker.text()).toMatch(/"SKIP_WAITING"===\w+\.data\.type&&self\.skipWaiting\(\)/);
});

test("cached shell reloads offline, explains online requirements and recovers", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await control(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#url")).toBeVisible();
  await expect(page.locator("#offline-notice")).toBeVisible();
  await expect(page.locator("#offline-notice")).toContainText("speech generation need an internet connection");
  await page.locator("#paste-fallback").click();
  await expect(page.locator("#text")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-offline.png"), fullPage: true });
  await context.setOffline(false);
  await expect(page.locator("#offline-notice")).toBeHidden();
  const response = await page.evaluate(() => fetch("/api/health").then((r) => r.json()));
  expect(response).toEqual({ status: "ok" });
});

test("only app assets are cached; API and article/audio requests remain network-only", async ({ page, context }) => {
  await control(page);
  const before = await cachedUrls(page);
  expect(before).toContain("/index.html");
  expect(before).toContain("/icons/icon-512.png");
  const results = await page.evaluate(async () => {
    const health = await fetch("/api/health");
    const article = await fetch("/api/article", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const audio = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const missing = await fetch("/api/missing", { headers: { Accept: "text/html" } });
    return [health.status, article.status, audio.status, missing.status];
  });
  expect(results).toEqual([200, 400, 400, 404]);
  expect(await cachedUrls(page)).toEqual(before);
  expect(before.some((url) => url.startsWith("/api/"))).toBe(false);
  await context.setOffline(true);
  expect(await page.evaluate(() => fetch("/api/health").then(() => "cached", () => "network-only"))).toBe("network-only");
  expect(await page.evaluate(() => fetch("/api/missing", { headers: { Accept: "text/html" } }).then(() => "cached", () => "network-only"))).toBe("network-only");
});

test("ordinary browser use survives unavailable service workers", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    await page.goto(baseURL);
    await page.locator("#paste-fallback").click();
    await expect(page.locator("#text")).toBeFocused();
    await expect(page.locator("#read-start")).toBeEnabled();
  } finally {
    await context.close();
  }
});
