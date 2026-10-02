import { expect, gotoApp, test } from "./support";

/**
 * Panning moves the paper as one layer instead of repainting its rule
 * pattern, so the layer's own pattern has to stay on the page's grid at any
 * pan offset and zoom.
 */
test("the rule pattern stays on the page's grid while the page is panned and zoomed", async ({ page }) => {
  await gotoApp(page);
  const paper = page.locator(".live-canvas-paper");
  await expect(paper).toHaveAttribute("data-paper-rule", "grid");
  const view = (await page.getByLabel("Ansicht der Zeichenfläche").boundingBox())!;
  const centre = { x: view.x + view.width / 2, y: view.y + view.height / 2 };

  /** Distance of the page origin from the nearest grid line of the paper layer, in pixels, per axis. */
  const misalignment = () => page.evaluate(() => {
    const layer = document.querySelector(".live-canvas-paper")!;
    const surface = document.querySelector(".live-canvas-surface")!;
    const step = Number.parseFloat(getComputedStyle(layer).backgroundSize);
    const from = layer.getBoundingClientRect();
    const origin = surface.getBoundingClientRect();
    const off = (distance: number) => {
      const rest = ((distance % step) + step) % step;
      return Math.min(rest, step - rest);
    };
    return { step, x: off(origin.left - from.left), y: off(origin.top - from.top) };
  });

  await page.mouse.move(centre.x, centre.y);
  // Pan the page's origin off screen by amounts that are not multiples of the grid.
  for (const [dx, dy] of [[131, 217], [53, 91], [-17, -29]]) {
    await page.mouse.wheel(dx, dy);
    const { step, x, y } = await misalignment();
    // A layer can only sit on whole device pixels.
    expect(step).toBeGreaterThan(4);
    expect(x).toBeLessThanOrEqual(0.51);
    expect(y).toBeLessThanOrEqual(0.51);
  }

  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await page.mouse.wheel(83, 149);
  const zoomed = await misalignment();
  expect(zoomed.x).toBeLessThanOrEqual(0.51);
  expect(zoomed.y).toBeLessThanOrEqual(0.51);
});
