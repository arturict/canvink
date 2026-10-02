import { expect, expectInkCount, gotoApp, inkStrokes, ribbonTab, test } from "./support";

/**
 * The browser predicts where the pen will be by the next frame. The overlay
 * paints that tail so the ink keeps up with the pen, but only real samples
 * are stored. Playwright's synthetic input carries no predictions, so the
 * test gives every pointer event one, 60 px to the right.
 */
const PREDICTED_OFFSET = 60;

test("the predicted tail of a pen stroke is painted under the pen and never stored", async ({ page }) => {
  await page.addInitScript((offset) => {
    PointerEvent.prototype.getPredictedEvents = function predicted(this: PointerEvent): PointerEvent[] {
      const ahead = new PointerEvent(this.type, {
        pointerId: this.pointerId,
        pointerType: this.pointerType,
        clientX: this.clientX + offset,
        clientY: this.clientY,
        pressure: this.pressure,
        buttons: this.buttons,
      });
      return [ahead];
    };
  }, PREDICTED_OFFSET);
  await gotoApp(page);
  const draw = await ribbonTab(page, "Zeichnen");
  await draw.getByRole("button", { name: "Stift", exact: true }).click();
  const view = (await page.getByLabel("Ansicht der Zeichenfläche").boundingBox())!;
  const startX = view.x + 150;
  const endX = startX + 200;
  const y = view.y + 250;

  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y, { steps: 10 });

  // Where the pen is now the ink is real; 30 px further it is the prediction.
  const overlayAlphaAt = (x: number) => page.evaluate(({ x: clientX, y: clientY }) => {
    const overlay = document.querySelector<HTMLCanvasElement>(".live-canvas-ink-overlay");
    const context = overlay?.getContext("2d");
    if (!overlay || !context) throw new Error("The live-ink overlay is missing.");
    const rect = overlay.getBoundingClientRect();
    const scale = overlay.width / rect.width;
    return context.getImageData(Math.round((clientX - rect.left) * scale), Math.round((clientY - rect.top) * scale), 1, 1).data[3];
  }, { x, y });
  await expect.poll(() => overlayAlphaAt(endX + 30)).toBeGreaterThan(0);
  expect(await overlayAlphaAt(endX + PREDICTED_OFFSET + 40)).toBe(0);

  await page.mouse.up();
  await expectInkCount(page, 1);
  const [stroke] = await inkStrokes(page);
  // The stored stroke stops at the last real sample.
  expect(stroke.box.x + stroke.box.width).toBeLessThan(endX + 5);
  expect(stroke.box.x + stroke.box.width).toBeGreaterThan(endX - 5);
});
