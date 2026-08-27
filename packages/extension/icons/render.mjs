/**
 * Render icons/icon.svg to the PNG sizes the manifest declares.
 *
 *   npm run icons
 *
 * Chromium does the rasterising, so the result is exactly what the browser
 * would draw from the SVG — no image library, and nothing to keep in sync but
 * the one source file. The PNGs are committed, so a normal build (and CI)
 * needs neither this script nor a browser.
 */

import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 48, 128];

const svg = await readFile(join(HERE, "icon.svg"), "utf8");

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  channel: "chromium",
  args: ["--no-sandbox"],
});

try {
  for (const size of SIZES) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      // Render at the true pixel size: a toolbar icon is judged at 16px, and
      // downscaling a larger render would hide how it actually reads there.
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><style>
         html,body{margin:0;padding:0;background:transparent}
         svg{display:block;width:${size}px;height:${size}px}
       </style>${svg}`,
    );
    const png = await page.screenshot({ omitBackground: true });
    await writeFile(join(HERE, `icon${size}.png`), png);
    await page.close();
    console.log(`icons/icon${size}.png  ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
