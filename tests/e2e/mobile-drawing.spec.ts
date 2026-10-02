import { expect, expectInkCount, gotoApp, ribbonTab, test, waitForSaved } from "./support";

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

test("finger input draws on mobile when the pen tool is active", async ({
  page,
}) => {
  await gotoApp(page);
  await page
    .getByRole("navigation", { name: "Notizbuchnavigation" })
    .getByRole("button", { name: "Navigation schliessen" })
    .click();

  await (await ribbonTab(page, "Zeichnen")).getByRole("button", { name: "Stift", exact: true }).click();

  const stage = page.getByRole("application", {
    name: "Gemeinsame Seitenzeichenfläche",
  });
  await expect(stage).toBeVisible();
  await expect(stage).toHaveCSS("touch-action", "none");
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + 90, y: box.y + 110 }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: box.x + 150, y: box.y + 150 }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: box.x + 180, y: box.y + 170 }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });

  await expectInkCount(page, 1);
  await waitForSaved(page);

  await page.getByRole("button", { name: "Auswählen", exact: true }).click();
});

test("after a pen is used, one finger pans the page and two fingers pinch-zoom it", async ({
  page,
}) => {
  await gotoApp(page);
  await page
    .getByRole("navigation", { name: "Notizbuchnavigation" })
    .getByRole("button", { name: "Navigation schliessen" })
    .click();
  await (await ribbonTab(page, "Zeichnen")).getByRole("button", { name: "Stift", exact: true }).click();
  const stage = page.getByRole("application", {
    name: "Gemeinsame Seitenzeichenfläche",
  });
  const client = await page.context().newCDPSession(page);
  const start = await stage.boundingBox();
  if (!start) throw new Error("The shared canvas has no visible bounds.");

  // A pen stroke: the pen draws, and from now on fingers navigate.
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: start.x + 60, y: start.y + 80, button: "left", buttons: 1, clickCount: 1,
    pointerType: "pen", force: 0.5,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: start.x + 140, y: start.y + 90, button: "left", buttons: 1,
    pointerType: "pen", force: 0.6,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: start.x + 140, y: start.y + 90, button: "left", buttons: 0, clickCount: 1,
    pointerType: "pen", force: 0,
  });
  await expectInkCount(page, 1);
  await expect(stage).toHaveAttribute("data-touch-draws", "false");
  // Palm rejection ignores fingers right after pen activity.
  await page.waitForTimeout(900);

  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 200, y: 400 }] });
  for (let step = 1; step <= 4; step += 1) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 200, y: 400 - step * 20 }] });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expectInkCount(page, 1);
  const panned = await stage.boundingBox();
  if (!panned) throw new Error("The panned canvas disappeared.");
  expect(start.y - panned.y).toBeCloseTo(80, 0);

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 150, y: 420, id: 1 }, { x: 250, y: 420, id: 2 }],
  });
  for (let step = 1; step <= 5; step += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 150 - step * 10, y: 420, id: 1 }, { x: 250 + step * 10, y: 420, id: 2 }],
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expectInkCount(page, 1);
  const zoomed = await stage.boundingBox();
  if (!zoomed) throw new Error("The zoomed canvas disappeared.");
  // The fingers moved from 100 to 200 px apart: the page doubles in size.
  expect(zoomed.width / panned.width).toBeCloseTo(2, 1);
  await waitForSaved(page);
});
