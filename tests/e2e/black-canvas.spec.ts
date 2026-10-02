import type { Page } from "@playwright/test";
import { expect, expectInkCount, gotoApp, inkCount, inkPixelAt, ribbonTab, test, waitForSaved } from "./support";

/**
 * The page area sometimes turned solid black ("ab und zu"), header, sidebar
 * and toolbar intact. The live-ink overlay is one canvas over the whole page
 * area, created with `desynchronized: true`; a canvas that lost its backing
 * store (GPU reset, memory pressure) or that a Windows driver presents through
 * the low-latency path as black covers everything under it. These tests make
 * a black overlay, dropped tiles and a dropped overlay mid-stroke, and check
 * what the user sees.
 */

const surfaceLabel = "Ansicht der Zeichenfläche";

/** Share of dark pixels in a screenshot of the page area, sampled on a grid. */
async function darkShare(page: Page): Promise<number> {
  const box = await page.getByLabel(surfaceLabel).boundingBox();
  if (!box) throw new Error("The page area has no bounds.");
  const shot = await page.screenshot({ clip: box });
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    let dark = 0;
    let total = 0;
    for (let y = 4; y < bitmap.height; y += 8) {
      for (let x = 4; x < bitmap.width; x += 8) {
        const [r, g, b] = context.getImageData(x, y, 1, 1).data;
        total += 1;
        if (r + g + b < 120) dark += 1;
      }
    }
    return dark / total;
  }, shot.toString("base64"));
}

async function useOverlay(page: Page, run: "black" | "drop"): Promise<void> {
  await page.evaluate((mode) => {
    const overlay = document.querySelector<HTMLCanvasElement>(".live-canvas-ink-overlay")!;
    if (mode === "black") {
      overlay.width = overlay.clientWidth;
      overlay.height = overlay.clientHeight;
      const context = overlay.getContext("2d")!;
      context.fillStyle = "#000";
      context.fillRect(0, 0, overlay.width, overlay.height);
    } else {
      overlay.height += 0;
      overlay.dispatchEvent(new Event("contextlost"));
      overlay.dispatchEvent(new Event("contextrestored"));
    }
  }, run);
}

async function drawStroke(page: Page, steps = 14): Promise<{ x: number; y: number }> {
  const box = (await page.getByLabel(surfaceLabel).boundingBox())!;
  const y = box.y + 200;
  await page.mouse.move(box.x + 120, y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) await page.mouse.move(box.x + 120 + step * 16, y);
  await page.mouse.up();
  return { x: box.x + 120 + 8 * 16, y };
}

async function chooseTheStroke(page: Page): Promise<void> {
  await (await ribbonTab(page, "Zeichnen")).getByRole("button", { name: "Stift", exact: true }).click();
}

test("an idle overlay canvas full of black never shows over the page", async ({ page }) => {
  await gotoApp(page);
  expect(await darkShare(page)).toBeLessThan(0.02);
  await useOverlay(page, "black");
  // The overlay is the canvas that covers the whole page area; whatever it holds, idle it is not shown.
  expect(await darkShare(page)).toBeLessThan(0.02);
});

/** Draws one stroke and waits until it is stored and its tile has settled, so a later repaint has to come from the fix. */
async function drawSettledStroke(page: Page): Promise<{ x: number; y: number }> {
  await gotoApp(page);
  await chooseTheStroke(page);
  const before = await inkCount(page);
  const point = await drawStroke(page);
  await expectInkCount(page, before + 1);
  await expect.poll(() => inkPixelAt(page, point)).not.toBeNull();
  await waitForSaved(page);
  await page.waitForTimeout(1000);
  return point;
}

test("tiles that lost their pixels are painted again from the strokes", async ({ page }) => {
  const point = await drawSettledStroke(page);
  // The browser dropped the backing store: the tile is empty until it is told to paint again.
  await page.evaluate(() => {
    for (const tile of document.querySelectorAll<HTMLCanvasElement>(".live-canvas-ink-tile")) {
      tile.height += 0;
      tile.dispatchEvent(new Event("contextlost"));
      tile.dispatchEvent(new Event("contextrestored"));
    }
  });
  await expect.poll(() => inkPixelAt(page, point)).not.toBeNull();
});

test("tiles are painted again when the tab becomes visible, without any context event", async ({ page }) => {
  const point = await drawSettledStroke(page);
  // A hidden tab loses canvas pixels silently in some browsers.
  await page.evaluate(() => {
    for (const tile of document.querySelectorAll<HTMLCanvasElement>(".live-canvas-ink-tile")) tile.height += 0;
  });
  expect(await inkPixelAt(page, point)).toBeNull();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => inkPixelAt(page, point)).not.toBeNull();
});

test("a stroke survives the overlay losing its backing store under the pen", async ({ page }) => {
  await gotoApp(page);
  await chooseTheStroke(page);
  const box = (await page.getByLabel(surfaceLabel).boundingBox())!;
  const y = box.y + 220;
  await page.mouse.move(box.x + 100, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(box.x + 100 + step * 14, y);
  await useOverlay(page, "drop");
  for (let step = 11; step <= 14; step += 1) await page.mouse.move(box.x + 100 + step * 14, y);
  // The whole stroke so far is on the overlay again, including what was drawn before the loss.
  const painted = await page.evaluate(({ left, top }) => {
    const overlay = document.querySelector<HTMLCanvasElement>(".live-canvas-ink-overlay")!;
    const rect = overlay.getBoundingClientRect();
    const scale = overlay.width / rect.width;
    const context = overlay.getContext("2d")!;
    const alphaAt = (x: number) => context.getImageData(Math.round((x - rect.left) * scale), Math.round((top - rect.top) * scale), 1, 1).data[3];
    return { early: alphaAt(left + 3 * 14), late: alphaAt(left + 13 * 14), shown: getComputedStyle(overlay).visibility };
  }, { left: box.x + 100, top: y });
  expect(painted.early).toBeGreaterThan(0);
  expect(painted.late).toBeGreaterThan(0);
  expect(painted.shown).toBe("visible");
  await page.mouse.up();
  await expect.poll(async () => page.evaluate(() => getComputedStyle(document.querySelector(".live-canvas-ink-overlay")!).visibility)).toBe("hidden");
  expect(await darkShare(page)).toBeLessThan(0.02);
});

test("a real GPU process crash leaves the ink and the page visible", async ({ page, browser }) => {
  const point = await drawSettledStroke(page);
  await page.evaluate(() => {
    const seen = { lost: 0, restored: 0 };
    (window as unknown as { __canvasEvents: typeof seen }).__canvasEvents = seen;
    for (const canvas of document.querySelectorAll("canvas")) {
      canvas.addEventListener("contextlost", () => { seen.lost += 1; });
      canvas.addEventListener("contextrestored", () => { seen.restored += 1; });
    }
  });
  await (await browser.newBrowserCDPSession()).send("Browser.crashGpuProcess" as never);
  // Chromium drops every accelerated canvas and brings them back empty.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __canvasEvents: { restored: number } }).__canvasEvents.restored)).toBeGreaterThan(0);
  await expect.poll(() => inkPixelAt(page, point)).not.toBeNull();
  expect(await darkShare(page)).toBeLessThan(0.02);
});

test("a lost overlay context turns the low-latency overlay off on this device", async ({ page }) => {
  await gotoApp(page);
  await useOverlay(page, "drop");
  expect(await page.evaluate(() => window.localStorage.getItem("canvink:overlay-low-latency-off"))).toBe("1");
});
