import { expect, expectInkCount, gotoApp, inkCount, ribbonTab, test, waitForSaved } from "./support";

interface RasterProbe {
  /** The cached picture was in the document. */
  shown: boolean;
  /** Its stroke count when it appeared. */
  strokes: number | null;
  /** Real ink tiles were in the document when it appeared, and when it went. */
  tilesWhenShown: boolean | null;
  tilesWhenRemoved: boolean | null;
}

/**
 * A page's ink is cached as a picture once it has been idle, and a reload
 * shows that picture while the page's document loads; the real ink replaces
 * it once its tiles are painted.
 */
test("a reloaded page shows its cached ink picture until the real ink replaces it", async ({ page }) => {
  // Watches the document from its start for the picture coming and going.
  await page.addInitScript(() => {
    // The picture is only looked up for a short moment by design; a loaded
    // machine must not decide whether this test sees it.
    (window as unknown as { __canvinkInkRasterWaitMs: number }).__canvinkInkRasterWaitMs = 5_000;
    const probe: RasterProbe = { shown: false, strokes: null, tilesWhenShown: null, tilesWhenRemoved: null };
    (window as unknown as { __rasterProbe: RasterProbe }).__rasterProbe = probe;
    const tiles = () => document.querySelector(".live-canvas-ink-tile") !== null;
    new MutationObserver(() => {
      const raster = document.querySelector("[data-ink-raster='cached']");
      if (raster && !probe.shown) {
        probe.shown = true;
        probe.strokes = Number(raster.getAttribute("data-ink-raster-strokes"));
        probe.tilesWhenShown = tiles();
      } else if (!raster && probe.shown && probe.tilesWhenRemoved === null) {
        probe.tilesWhenRemoved = tiles();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await gotoApp(page);
  const title = page.getByLabel("Seitentitel");
  // A page opened by navigation is the one a reload returns to.
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.getByRole("button", { name: "Canvas-Seite", exact: true }).click();
  await expect(title).toHaveValue("Unbenannte Seite");
  await waitForSaved(page);

  const draw = await ribbonTab(page, "Zeichnen");
  await draw.getByRole("button", { name: "Stift", exact: true }).click();
  const surface = page.getByLabel("Ansicht der Zeichenfläche");
  const box = (await surface.boundingBox())!;
  const before = await inkCount(page);
  for (let index = 0; index < 3; index += 1) {
    const y = box.y + 160 + index * 60;
    await page.mouse.move(box.x + 120, y);
    await page.mouse.down();
    for (let step = 1; step <= 12; step += 1) await page.mouse.move(box.x + 120 + step * 15, y + Math.sin(step) * 8);
    await page.mouse.up();
  }
  await expectInkCount(page, before + 3);
  await waitForSaved(page);
  // The picture is drawn once the ink has been left alone for a moment.
  await expect.poll(
    () => page.evaluate(() => performance.getEntriesByName("canvink:ink-raster").length),
    { timeout: 15_000 },
  ).toBeGreaterThan(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(title).toHaveValue("Unbenannte Seite");
  await expectInkCount(page, before + 3);
  await expect(page.locator("[data-ink-raster='cached']")).toHaveCount(0);
  const probe = await page.evaluate(() => (window as unknown as { __rasterProbe: RasterProbe }).__rasterProbe);
  expect(probe).toEqual({
    shown: true,
    strokes: before + 3,
    // Shown before the real ink, and replaced only once the real ink was there.
    tilesWhenShown: false,
    tilesWhenRemoved: true,
  });
});
