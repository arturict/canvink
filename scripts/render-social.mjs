import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const source = new URL("../public/canvink-social.svg", import.meta.url);
const output = new URL("../public/canvink-social.png", import.meta.url);
const svg = await readFile(source, "utf8");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(
    `<style>html,body{margin:0;width:1200px;height:630px;overflow:hidden}</style>${svg}`,
  );
  await page.screenshot({ path: fileURLToPath(output), type: "png" });
} finally {
  await browser.close();
}
