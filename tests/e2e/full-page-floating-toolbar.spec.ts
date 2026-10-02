import type { Locator, Page } from "@playwright/test";
import { expect, expectInkCount, gotoApp, inkStrokes, test } from "./support";

const canvasName = "Gemeinsame Seitenzeichenfläche";

async function enterFullPage(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Vollbild öffnen", exact: true }).click();
  const toolbar = page.getByRole("toolbar", { name: "Zeichenwerkzeuge" });
  await expect(toolbar).toBeVisible();
  return toolbar;
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("The element is not visible.");
  return rect;
}

async function dragWithMouse(page: Page, from: Locator, to: { x: number; y: number }): Promise<void> {
  const start = await box(from);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move((start.x + to.x) / 2, (start.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}

test("the floating toolbar draws, collapses, moves to a side and keeps its place after a reload", async ({ page }) => {
  await gotoApp(page);
  const toolbar = await enterFullPage(page);
  const viewport = page.viewportSize()!;

  // It starts horizontal, centred on the top edge.
  await expect(toolbar).toHaveAttribute("aria-orientation", "horizontal");
  // The toolbar recentres once its buttons have their final width (the page
  // writer arrives asynchronously), so wait for the settled position.
  await expect.poll(async () => {
    const rect = await box(toolbar);
    return Math.abs(rect.x + rect.width / 2 - viewport.width / 2);
  }).toBeLessThan(4);
  const top = await box(toolbar);
  expect(top.y).toBeLessThan(20);

  // Drawing with a pen from the toolbar; it steps aside during the stroke.
  await toolbar.getByRole("radio", { name: "Stift Rot" }).click();
  await expect(toolbar.getByRole("radio", { name: "Stift Rot" })).toHaveAttribute("aria-checked", "true");
  const canvas = page.getByRole("application", { name: canvasName });
  const area = await box(canvas);
  await page.mouse.move(area.x + 200, area.y + 220);
  await page.mouse.down();
  await page.mouse.move(area.x + 280, area.y + 260, { steps: 6 });
  await expect(toolbar).toHaveAttribute("data-drawing", "true");
  await expect(toolbar).toHaveCSS("pointer-events", "none");
  await page.mouse.move(area.x + 340, area.y + 240, { steps: 6 });
  await page.mouse.up();
  await expect(toolbar).not.toHaveAttribute("data-drawing", "true");
  await expectInkCount(page, 1);
  expect((await inkStrokes(page))[0]?.color).toBe("#dc2626");
  await toolbar.getByRole("button", { name: "Rückgängig" }).click();
  await expectInkCount(page, 0);

  // Dragged by its grip to the right edge it snaps there and turns vertical.
  await dragWithMouse(page, toolbar.getByRole("button", { name: "Werkzeugleiste verschieben" }), {
    x: viewport.width - 30,
    y: viewport.height / 2,
  });
  await expect(toolbar).toHaveAttribute("aria-orientation", "vertical");
  await expect.poll(async () => {
    const right = await box(toolbar);
    return Math.round(viewport.width - (right.x + right.width));
  }).toBe(8);

  // Collapsed to one button, and back.
  await toolbar.getByRole("button", { name: "Werkzeuge ausblenden" }).click();
  await expect(toolbar.getByRole("radio", { name: "Stift Rot" })).toBeHidden();
  const expand = toolbar.getByRole("button", { name: "Werkzeuge einblenden" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expand.click();
  await expect(toolbar.getByRole("radio", { name: "Stift Rot" })).toBeVisible();
  await toolbar.getByRole("button", { name: "Werkzeuge ausblenden" }).click();

  // The place and the collapsed state are remembered on this device.
  await page.reload({ waitUntil: "domcontentloaded" });
  await gotoApp(page);
  const again = await enterFullPage(page);
  await expect(again.getByRole("button", { name: "Werkzeuge einblenden" })).toBeVisible();
  await again.getByRole("button", { name: "Werkzeuge einblenden" }).click();
  await expect(again).toHaveAttribute("aria-orientation", "vertical");
  // Polled: expanding animates the toolbar from its collapsed place.
  await expect.poll(async () => {
    const kept = await box(again);
    return Math.round(viewport.width - (kept.x + kept.width));
  }).toBe(8);

  // Leaving the full page view from the toolbar.
  await again.getByRole("button", { name: "Vollbild verlassen" }).click();
  await expect(again).toHaveCount(0);
  await expect(page.locator(".app-topbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Vollbild öffnen", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("the floating toolbar is usable with the keyboard", async ({ page }) => {
  await gotoApp(page);
  const toolbar = await enterFullPage(page);
  const grip = toolbar.getByRole("button", { name: "Werkzeugleiste verschieben" });
  await grip.focus();
  await page.keyboard.press("Tab");
  await expect(toolbar.getByRole("radio", { name: "Stift Schwarz" })).toBeFocused();

  // The grip's arrow keys move it along the edge and across to another one.
  await grip.focus();
  const before = await box(toolbar);
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await box(toolbar)).x).toBeGreaterThan(before.x + 40);
  await page.keyboard.press("ArrowDown");
  const viewport = page.viewportSize()!;
  await expect.poll(async () => {
    const bottom = await box(toolbar);
    return Math.round(viewport.height - (bottom.y + bottom.height));
  }).toBe(8);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");

  // The pen menu opens from the toolbar, above it at the bottom edge.
  await toolbar.getByRole("button", { name: "Farbe und Stärke anpassen" }).click();
  const menu = page.getByRole("dialog", { name: "Farbe und Stärke anpassen" });
  await expect(menu).toBeVisible();
  expect((await box(menu)).y + (await box(menu)).height).toBeLessThanOrEqual((await box(toolbar)).y);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // Escape closed only the menu; a second one leaves the full page view.
  await expect(toolbar).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toolbar).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("a phone gets a vertical strip that a long press drags to the other side", async ({ page }) => {
    await gotoApp(page);
    await page
      .getByRole("navigation", { name: "Notizbuchnavigation" })
      .getByRole("button", { name: "Notizbuchnavigation schliessen" })
      .click();
    const toolbar = await enterFullPage(page);
    await expect(toolbar).toHaveAttribute("aria-orientation", "vertical");
    const strip = await box(toolbar);
    expect(strip.x).toBe(8);
    expect(strip.y).toBeGreaterThanOrEqual(8);
    expect(strip.y + strip.height).toBeLessThanOrEqual(844 - 8);
    expect(strip.width).toBeLessThan(100);

    // A long press on a pen, then a move, drags the toolbar with a finger.
    const pen = await box(toolbar.getByRole("radio", { name: "Stift Blau" }));
    const client = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
      client.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
      });
    const start = { x: pen.x + pen.width / 2, y: pen.y + pen.height / 2 };
    await touch("touchStart", start.x, start.y);
    await page.waitForTimeout(600);
    for (let step = 1; step <= 6; step += 1) {
      await touch("touchMove", start.x + (370 - start.x) * (step / 6), start.y);
    }
    await touch("touchEnd", 370, start.y);
    await expect.poll(async () => {
      const moved = await box(toolbar);
      return Math.round(390 - (moved.x + moved.width));
    }).toBe(8);
    // The long press did not choose the pen under the finger.
    await expect(toolbar.getByRole("radio", { name: "Stift Blau" })).toHaveAttribute("aria-checked", "false");
  });
});
