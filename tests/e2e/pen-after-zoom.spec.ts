import { expect, expectInkCount, gotoApp, inkStrokes, ribbonTab, test } from "./support";

/**
 * A wheel zoom moves the page in the DOM at once; the editor's React state
 * follows a moment later. A pen that goes down in between must still draw
 * where it touches, so the stroke is mapped with the zoom on screen, not the
 * one the last render knew.
 */
test("a stroke started right after a wheel zoom lands under the pen", async ({ page }) => {
  await gotoApp(page);
  const draw = await ribbonTab(page, "Zeichnen");
  await draw.getByRole("button", { name: "Stift", exact: true }).click();
  const view = (await page.getByLabel("Ansicht der Zeichenfläche").boundingBox())!;
  const centre = { x: view.x + view.width / 2, y: view.y + 200 };

  await page.mouse.move(centre.x, centre.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  // No wait: the pen goes down within the same few milliseconds.
  await page.mouse.move(centre.x, centre.y + 40);
  await page.mouse.down();
  await page.mouse.move(centre.x + 160, centre.y + 40, { steps: 8 });
  await page.mouse.up();

  await expectInkCount(page, 1);
  const [stroke] = await inkStrokes(page);
  expect(stroke.box.x).toBeCloseTo(centre.x, -1);
  expect(stroke.box.x + stroke.box.width).toBeCloseTo(centre.x + 160, -1);
});
