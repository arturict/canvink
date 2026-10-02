import { jsPDF } from "jspdf";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  expectInkCount,
  gotoApp,
  inkStrokes,
  ribbonTab,
  test,
  waitForSaved,
} from "./support";

const canvasName = "Gemeinsame Seitenzeichenfläche";

/** A PNG made in the page itself, so the spec needs no binary fixture. */
async function pngBuffer(page: Page, width = 480, height = 320): Promise<Buffer> {
  const base64 = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#f4efe2";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#3b7a3b";
    context.beginPath();
    context.arc(width / 2, height / 2, height / 3, 0, Math.PI * 2);
    context.fill();
    return canvas.toDataURL("image/png").split(",")[1];
  }, { width, height });
  return Buffer.from(base64, "base64");
}

function worksheetPdf(): Buffer {
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  pdf.setFontSize(22);
  pdf.text("Arbeitsblatt", 72, 96);
  pdf.setFontSize(14);
  pdf.text("7 + 5 =", 72, 150);
  return Buffer.from(pdf.output("arraybuffer"));
}

async function insertImage(page: Page): Promise<Locator> {
  await page.locator('input[type="file"][accept^="image/png"]').setInputFiles({
    name: "zelle.png",
    mimeType: "image/png",
    buffer: await pngBuffer(page),
  });
  const element = page.locator('[data-element-kind="image"]').last();
  await expect(element.getByRole("img")).toBeVisible({ timeout: 15_000 });
  await waitForSaved(page);
  return element;
}

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element has no visible bounds.");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drawStroke(page: Page, points: Array<{ x: number; y: number }>): Promise<void> {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 6 });
  await page.mouse.up();
}

test("right-click sets an image as background that ink passes over, and releases it again", async ({ page }) => {
  await gotoApp(page);
  const image = await insertImage(page);
  const middle = await center(image);

  await page.mouse.click(middle.x, middle.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "Kontextmenü" });
  await expect(menu).toBeVisible();
  for (const item of ["Ausschneiden", "Kopieren", "Einfügen", "Löschen", "In den Vordergrund", "In den Hintergrund"]) {
    await expect(menu.getByRole("menuitem", { name: item })).toBeVisible();
  }
  // The right-click selected the image, as in OneNote.
  await expect(image).toHaveClass(/is-selected/);
  await menu.getByRole("menuitem", { name: "Als Hintergrund festlegen" }).click();
  await expect(menu).toHaveCount(0);
  await expect(image).toHaveAttribute("data-background", "true");
  await expect(image).not.toHaveClass(/is-selected/);
  await waitForSaved(page);

  // The pen writes on the background; a click there never selects it.
  const draw = await ribbonTab(page, "Zeichnen");
  await draw.getByRole("radio", { name: "Stift Rot" }).click();
  await drawStroke(page, [
    { x: middle.x - 60, y: middle.y },
    { x: middle.x, y: middle.y - 30 },
    { x: middle.x + 60, y: middle.y },
  ]);
  await expectInkCount(page, 1);
  // A click on it places a text container there, as on OneNote paper.
  const texts = page.getByRole("textbox", { name: "Gemeinsamer Text" });
  const textCount = await texts.count();
  await draw.getByRole("button", { name: "Auswählen", exact: true }).click();
  await page.mouse.click(middle.x + 100, middle.y + 60);
  await expect(texts).toHaveCount(textCount + 1);
  await expect(image).not.toHaveClass(/is-selected/);

  // Only the context menu reaches it again.
  await page.mouse.click(middle.x - 120, middle.y - 80, { button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Hintergrund lösen" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Ausschneiden" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Hintergrund lösen" }).click();
  await expect(image).not.toHaveAttribute("data-background", "true");
  await expect(image).toHaveClass(/is-selected/);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(page.locator('[data-element-kind="image"]').last()).not.toHaveAttribute("data-background", "true");
});

test("keyboard opens the context menu on the selection and Reihenfolge reorders it", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await gotoApp(page);
  const image = await insertImage(page);
  const canvas = page.getByRole("application", { name: canvasName });
  const middle = await center(image);

  // A rectangle drawn over the image starts on top of it.
  const draw = await ribbonTab(page, "Zeichnen");
  await draw.getByRole("button", { name: "Rechteck", exact: true }).click();
  await drawStroke(page, [{ x: middle.x - 40, y: middle.y - 30 }, { x: middle.x + 40, y: middle.y + 30 }]);
  const shape = page.locator('[data-element-kind="shape"]').last();
  await expect(shape).toBeVisible();
  const zIndex = (locator: Locator) => locator.evaluate((node) => Number((node as HTMLElement).style.zIndex));
  expect(await zIndex(shape)).toBeGreaterThan(await zIndex(image));

  await draw.getByRole("button", { name: "Auswählen", exact: true }).click();
  await page.mouse.click(middle.x + 38, middle.y);
  await expect(shape).toHaveClass(/is-selected/);
  await canvas.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Kontextmenü" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Ausschneiden" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Kopieren" })).toBeFocused();
  await menu.getByRole("menuitem", { name: "In den Hintergrund" }).click();
  await expect.poll(async () => (await zIndex(shape)) < (await zIndex(image))).toBe(true);

  // Undo puts the order back.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await zIndex(shape)) > (await zIndex(image))).toBe(true);

  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Kopieren, then Einfügen on empty paper puts the copy at the pointer.
  await page.mouse.click(middle.x + 38, middle.y, { button: "right" });
  await menu.getByRole("menuitem", { name: "Kopieren" }).click();
  const target = { x: middle.x + 320, y: middle.y + 60 };
  await page.mouse.click(target.x, target.y, { button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Ausschneiden" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Einfügen" }).click();
  const shapes = page.locator('[data-element-kind="shape"]');
  await expect(shapes).toHaveCount(2);
  const pastedBox = await shapes.last().boundingBox();
  if (!pastedBox) throw new Error("The pasted shape is not visible.");
  expect(Math.abs(pastedBox.x - target.x)).toBeLessThan(6);
  expect(Math.abs(pastedBox.y - target.y)).toBeLessThan(6);
});

test("a PDF printout arrives as a background without a caption on the page", async ({ page }) => {
  await gotoApp(page);
  const textBefore = await page.locator('[data-element-kind="richText"]').count();
  await page.locator('input[type="file"][accept*="application/pdf"]').setInputFiles({
    name: "arbeitsblatt.pdf",
    mimeType: "application/pdf",
    buffer: worksheetPdf(),
  });
  const printout = page.locator('[data-element-kind="pdf"]').last();
  await expect(printout.getByRole("img", { name: "PDF Seite 1" }).first()).toBeVisible({ timeout: 20_000 });
  await expect(printout).toHaveAttribute("data-background", "true");

  // The confirmation is a short toast, not text on the page.
  const notice = page.locator(".v2-notice");
  await expect(notice).toContainText("als Ausdruck eingefügt");
  await expect(notice).toHaveCount(0, { timeout: 6_000 });
  await expect(page.locator('[data-element-kind="richText"]')).toHaveCount(textBefore);

  // Lassoing the handwriting on the worksheet never grabs the worksheet.
  const box = await printout.boundingBox();
  if (!box) throw new Error("The printout has no bounds.");
  const draw = await ribbonTab(page, "Zeichnen");
  await draw.getByRole("radio", { name: "Stift Blau" }).click();
  await page.mouse.wheel(0, Math.max(0, box.y - 300));
  const visible = await printout.boundingBox();
  if (!visible) throw new Error("The printout scrolled away.");
  const start = { x: visible.x + 120, y: Math.max(visible.y + 80, 320) };
  await drawStroke(page, [start, { x: start.x + 80, y: start.y + 20 }]);
  await expectInkCount(page, 1);
  await draw.getByRole("button", { name: "Lasso", exact: true }).click();
  await drawStroke(page, [
    { x: visible.x + 5, y: start.y - 60 },
    { x: visible.x + visible.width - 5, y: start.y - 60 },
    { x: visible.x + visible.width - 5, y: start.y + 80 },
    { x: visible.x + 5, y: start.y + 80 },
    { x: visible.x + 5, y: start.y - 60 },
  ]);
  await expect(page.locator(".live-canvas-ink-selection")).toHaveCount(1);
  await expect(printout).not.toHaveClass(/is-selected/);
});

test("selected ink takes a new colour and thickness from the context menu and the pen menu", async ({ page }) => {
  await gotoApp(page);
  const canvas = page.getByRole("application", { name: canvasName });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The canvas is not visible.");
  const draw = await ribbonTab(page, "Zeichnen");
  await draw.getByRole("radio", { name: "Stift Blau" }).click();
  const origin = { x: box.x + 220, y: box.y + 220 };
  await drawStroke(page, [origin, { x: origin.x + 120, y: origin.y + 30 }]);
  await expectInkCount(page, 1);

  await draw.getByRole("button", { name: "Lasso", exact: true }).click();
  await drawStroke(page, [
    { x: origin.x - 30, y: origin.y - 40 },
    { x: origin.x + 160, y: origin.y - 40 },
    { x: origin.x + 160, y: origin.y + 70 },
    { x: origin.x - 30, y: origin.y + 70 },
    { x: origin.x - 30, y: origin.y - 40 },
  ]);
  await page.mouse.click(origin.x + 60, origin.y + 15, { button: "right" });
  const menu = page.getByRole("menu", { name: "Kontextmenü" });
  await menu.getByRole("group", { name: "Farbe der Auswahl" }).getByRole("menuitemradio", { name: "Rot" }).click();
  await expect.poll(async () => (await inkStrokes(page))[0]?.color).toBe("#dc2626");
  await page.mouse.click(origin.x + 60, origin.y + 15, { button: "right" });
  await menu.getByRole("group", { name: "Stärke der Auswahl" }).getByRole("menuitemradio", { name: "Dick" }).click();
  await expect.poll(async () => (await inkStrokes(page))[0]?.size).toBe(6);

  // The pen menu: a custom colour applies to the selection and to new ink,
  // and is still the pen colour after a reload.
  await draw.getByRole("button", { name: "Farbe und Stärke anpassen" }).click();
  const penMenu = page.getByRole("dialog", { name: "Farbe und Stärke anpassen" });
  await expect(penMenu.getByText("Auswahl anpassen")).toBeVisible();
  await penMenu.getByLabel("Eigene Farbe").fill("#123456");
  await expect.poll(async () => (await inkStrokes(page))[0]?.color).toBe("#123456");
  await penMenu.getByRole("button", { name: "Fein" }).click();
  await expect.poll(async () => (await inkStrokes(page))[0]?.size).toBe(2);
  await page.keyboard.press("Escape");
  await expect(penMenu).toHaveCount(0);

  await page.keyboard.press("Escape");
  await drawStroke(page, [{ x: origin.x, y: origin.y + 140 }, { x: origin.x + 100, y: origin.y + 150 }]);
  await expectInkCount(page, 2);
  const strokes = await inkStrokes(page);
  expect(strokes[1]).toMatchObject({ color: "#123456", size: 2, tool: "pen" });

  await waitForSaved(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  const drawAgain = await ribbonTab(page, "Zeichnen");
  await drawAgain.getByRole("button", { name: "Farbe und Stärke anpassen" }).click();
  await expect(page.getByRole("dialog", { name: "Farbe und Stärke anpassen" }).getByLabel("Eigene Farbe")).toHaveValue("#123456");
});

test("Linien and Papiergrösse draw the chosen pattern on the sheet and persist", async ({ page }) => {
  await gotoApp(page);
  const view = await ribbonTab(page, "Ansicht");
  const paper = page.locator(".live-canvas-paper");

  await view.getByRole("button", { name: "Papiergrösse" }).click();
  await page.getByRole("dialog", { name: "Papiergrösse" }).getByRole("button", { name: "A4 quer" }).click();
  await expect(paper).toHaveClass(/live-canvas-paper--sheet/);
  const canvas = page.getByRole("application", { name: canvasName });
  await expect.poll(async () => (await canvas.boundingBox())?.width).toBeCloseTo(1123, 0);

  await view.getByRole("button", { name: "Linien", exact: true }).click();
  const lines = page.getByRole("dialog", { name: "Linien" });
  await lines.getByRole("button", { name: "Kleines Raster (5 mm)" }).click();
  await expect(lines.getByRole("button", { name: "Kleines Raster (5 mm)" })).toHaveAttribute("aria-pressed", "true");
  await lines.getByRole("button", { name: "Kräftig" }).click();
  await lines.getByRole("button", { name: "Grün" }).click();
  await page.keyboard.press("Escape");
  await expect(paper).toHaveAttribute("data-paper-rule", "grid");
  const style = () => paper.evaluate((node) => {
    const computed = getComputedStyle(node);
    return { size: computed.backgroundSize, image: computed.backgroundImage };
  });
  await expect.poll(async () => (await style()).size).toContain("19px 19px");
  expect((await style()).image).toContain("rgba(22, 163, 74, 0.72)");

  // Zooming out keeps one-pixel lines at the zoomed spacing.
  await view.getByRole("button", { name: "Verkleinern" }).click();
  await view.getByRole("button", { name: "Verkleinern" }).click();
  await expect.poll(async () => (await style()).size).toContain("15.2px 15.2px");

  await waitForSaved(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(page.locator(".live-canvas-paper")).toHaveClass(/live-canvas-paper--sheet/);
  await expect.poll(async () => (await page.getByRole("application", { name: canvasName }).boundingBox())?.width).toBeCloseTo(1123, 0);
  await expect.poll(async () => (await style()).size).toContain("19px 19px");

  // Back to a free page: the pattern covers the whole visible paper.
  const viewAgain = await ribbonTab(page, "Ansicht");
  await viewAgain.getByRole("button", { name: "Papiergrösse" }).click();
  await page.getByRole("dialog", { name: "Papiergrösse" }).getByRole("button", { name: "Frei (wächst mit)" }).click();
  await expect(page.locator(".live-canvas-paper")).toHaveClass(/live-canvas-paper--free/);
});

test("full page view keeps drawing tools, hides the navigation and leaves on Escape", async ({ page }) => {
  await gotoApp(page);
  await page.getByRole("button", { name: "Vollbild öffnen", exact: true }).click();
  await expect(page.locator(".app-topbar")).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Notizbuchnavigation" })).toHaveCount(0);
  // Floating tools are the default; the Draw tab's row stays hidden.
  const floating = page.getByRole("toolbar", { name: "Zeichenwerkzeuge" });
  await expect(floating.getByRole("radio", { name: "Stift Rot" })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Zeichnen" })).toBeHidden();

  // The docked row across the top is still a choice.
  await floating.getByRole("button", { name: "Werkzeugleiste", exact: true }).click();
  await page.getByRole("dialog", { name: "Werkzeugleiste" }).getByRole("button", { name: "Werkzeugleiste oben" }).click();
  await expect(floating).toHaveCount(0);
  const draw = page.getByRole("tabpanel", { name: "Zeichnen" });
  await expect(draw.getByRole("button", { name: "Stift", exact: true })).toBeVisible();

  await draw.getByRole("radio", { name: "Stift Rot" }).click();
  const canvas = page.getByRole("application", { name: canvasName });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The canvas is not visible.");
  await drawStroke(page, [{ x: box.x + 200, y: box.y + 200 }, { x: box.x + 320, y: box.y + 240 }]);
  await expectInkCount(page, 1);

  await page.getByRole("button", { name: "Werkzeuge ausblenden" }).click();
  await expect(draw).toBeHidden();
  await page.getByRole("button", { name: "Werkzeuge einblenden" }).click();
  await expect(draw.getByRole("button", { name: "Stift", exact: true })).toBeVisible();

  await canvas.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-topbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Vollbild öffnen", exact: true })).toHaveAttribute("aria-pressed", "false");

  // The docked choice is remembered; the floating tools come back from it.
  await page.getByRole("button", { name: "Vollbild öffnen", exact: true }).click();
  await expect(draw.getByRole("button", { name: "Stift", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Schwebende Werkzeuge" }).click();
  await expect(floating.getByRole("radio", { name: "Stift Rot" })).toBeVisible();
  await expect(draw).toBeHidden();
});

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("a long press opens the context menu instead of leaving ink", async ({ page }) => {
    await gotoApp(page);
    await page
      .getByRole("navigation", { name: "Notizbuchnavigation" })
      .getByRole("button", { name: "Navigation schliessen" })
      .click();
    const image = await insertImage(page);
    await (await ribbonTab(page, "Zeichnen")).getByRole("button", { name: "Stift", exact: true }).click();
    const box = await image.boundingBox();
    if (!box) throw new Error("The image is not visible.");
    const point = { x: box.x + 40, y: box.y + 40 };

    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await page.waitForTimeout(800);
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    const menu = page.getByRole("menu", { name: "Kontextmenü" });
    await expect(menu.getByRole("menuitem", { name: "Als Hintergrund festlegen" })).toBeVisible();
    await expectInkCount(page, 0);
    await menu.getByRole("menuitem", { name: "Als Hintergrund festlegen" }).click();
    await expect(image).toHaveAttribute("data-background", "true");
  });
});
