import { test, expect } from "@playwright/test";
import { mockNarration } from "./narration-fixture.mjs";

for (const action of ["resume", "stop"]) {
  test(`interrupting the pause drop with ${action} cancels it`, async ({ page }) => {
    // SYNTHETIC/UI-only native media, not speech synthesis.
    await mockNarration(page);
    await page.goto("/");
    await page.locator("#paste-fallback").click();
    await page.locator("#text").fill("A synthetic fixture for interrupting the equalizer drop.");
    await page.locator("#read-start").click();
    await expect(page.locator("#status")).toHaveClass("is-playing");
    const result = await page.evaluate(async (action) => {
      const status = document.querySelector("#status");
      document.querySelector("#pause").click();
      while (!status.classList.contains("is-paused")) await new Promise(requestAnimationFrame);
      const drops = [...status.querySelectorAll(".status-equalizer span")].flatMap((bar) => bar.getAnimations());
      const running = drops.every((animation) => animation.playState === "running");
      document.querySelector(action === "resume" ? "#pause" : "#stop").click();
      while (status.classList.contains("is-paused")) await new Promise(requestAnimationFrame);
      return { count: drops.length, running, cancelled: drops.every((animation) => animation.playState === "idle") };
    }, action);
    expect(result).toEqual({ count: 4, running: true, cancelled: true });
    if (action === "resume") {
      await expect(page.locator("#status")).toHaveClass("is-playing");
      await expect(page.locator(".status-equalizer")).toBeVisible();
      await page.locator("#stop").click();
    }
    await expect(page.locator("#status")).toHaveText("Stopped");
    await expect(page.locator(".status-equalizer")).toBeHidden();
  });
}
