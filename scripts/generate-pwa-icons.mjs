import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

// The existing equalizer mark on an opaque canvas. All foreground pixels fit
// inside the maskable icon's central safe circle (40% of the canvas radius).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#126b59" />
  <g fill="#fff">
    <rect x="28" y="41" width="6" height="18" rx="3" />
    <rect x="41" y="28" width="6" height="44" rx="3" />
    <rect x="54" y="35" width="6" height="30" rx="3" />
    <rect x="67" y="44" width="6" height="12" rx="3" />
  </g>
</svg>`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await mkdir("public/icons", { recursive: true });
  for (const [size, path] of [[180, "public/apple-touch-icon.png"], [192, "public/icons/icon-192.png"], [512, "public/icons/icon-512.png"]]) {
    const png = await page.evaluate(async ({ svg, size }) => {
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      canvas.getContext("2d").drawImage(image, 0, 0, size, size);
      return canvas.toDataURL("image/png").split(",")[1];
    }, { svg, size });
    await writeFile(path, Buffer.from(png, "base64"));
    console.log(`Generated ${path} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
