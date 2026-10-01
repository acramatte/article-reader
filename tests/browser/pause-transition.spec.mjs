import { test, expect } from "@playwright/test";

for (const action of ["resume", "stop"]) {
  test(`interrupting the pause drop with ${action} cancels it`, async ({ page }) => {
    // Synthetic silent WAV exercises transport and rendering, not speech synthesis.
    const samples = 8000 * 4;
    const audio = Buffer.alloc(44 + samples * 2);
    audio.write("RIFF", 0);
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.write("WAVEfmt ", 8);
    audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(8000, 24);
    audio.writeUInt32LE(16000, 28);
    audio.writeUInt16LE(2, 32);
    audio.writeUInt16LE(16, 34);
    audio.write("data", 36);
    audio.writeUInt32LE(samples * 2, 40);
    await page.route("**/api/tts", (route) => route.fulfill({ contentType: "audio/wav", body: audio }));
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
    await expect(page.locator(".status-equalizer")).toBeHidden();
  });
}
