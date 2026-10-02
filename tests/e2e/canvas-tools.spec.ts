import type { Locator, Page } from "@playwright/test";
import { INK_SHAPE_HOLD_MS } from "../../src/editor/inkShapeRecognition";
import {
  expect,
  expectInkCount,
  gotoApp,
  inkCount,
  inkOverlayIsBlank,
  inkPixelAt,
  inkStrokes,
  ribbonTab,
  test,
  waitForSaved,
} from "./support";

// The former toolbar menus now live in ribbon tabs.
async function openToolbarGroup(page: Page, label: "Werkzeuge" | "Einfügen" | "Mehr"): Promise<Locator> {
  return ribbonTab(page, label === "Einfügen" ? "Einfügen" : "Zeichnen");
}

async function dragOnCanvas(
  page: Page,
  canvas: Locator,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The shared canvas has no visible bounds.");
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y, { steps: 12 });
  await page.mouse.up();
}

test("pen ink stays unboxed and draw-and-hold cleans a rough box into a rectangle", async ({
  page,
}) => {
  await gotoApp(page);
  const toolbar = await ribbonTab(page, "Zeichnen");
  const canvas = page.getByRole("application", {
    name: "Gemeinsame Seitenzeichenfläche",
  });
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("The shared canvas has no visible bounds.");

  await toolbar.getByRole("button", { name: "Stift", exact: true }).click();
  await dragOnCanvas(page, canvas, { x: 65, y: 45 }, { x: 175, y: 65 });
  await expectInkCount(page, 1);
  await expect(page.locator(".live-canvas-element.is-selected")).toHaveCount(0);

  const roughBox = [
    { x: 250, y: 70 },
    { x: 340, y: 67 },
    { x: 430, y: 73 },
    { x: 433, y: 145 },
    { x: 425, y: 215 },
    { x: 340, y: 218 },
    { x: 252, y: 212 },
    { x: 247, y: 142 },
    { x: 250, y: 70 },
  ];
  await page.mouse.move(canvasBox.x + roughBox[0].x, canvasBox.y + roughBox[0].y);
  await page.mouse.down();
  for (const point of roughBox.slice(1)) {
    await page.mouse.move(canvasBox.x + point.x, canvasBox.y + point.y, { steps: 3 });
  }
  await page.waitForTimeout(INK_SHAPE_HOLD_MS + 120);
  await expect(page.locator('[data-ink-hold-shape="rectangle"]')).toBeVisible();
  await page.mouse.up();

  await expect(
    page.locator('.live-canvas-shape[data-shape-kind="rectangle"]'),
  ).toHaveCount(1);
  await expectInkCount(page, 1);
  await expect(page.locator(".live-canvas-element.is-selected")).toHaveCount(0);
  await waitForSaved(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.locator('.live-canvas-shape[data-shape-kind="rectangle"]'),
  ).toHaveCount(1);
  await expect(page.locator(".live-canvas-element.is-selected")).toHaveCount(0);
});

test("select drag has no ghost stroke and corner handles resize ink plus shapes atomically", async ({
  page,
}) => {
  await gotoApp(page);
  const toolbar = await ribbonTab(page, "Zeichnen");
  const canvas = page.getByRole("application", {
    name: "Gemeinsame Seitenzeichenfläche",
  });
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("The shared canvas has no visible bounds.");

  await toolbar.getByRole("button", { name: "Stift", exact: true }).click();
  await dragOnCanvas(page, canvas, { x: 75, y: 95 }, { x: 205, y: 115 });
  await expectInkCount(page, 1);
  const strokeBox = async () => (await inkStrokes(page))[0]?.box;

  await (await openToolbarGroup(page, "Werkzeuge"))
    .getByRole("button", { name: "Rechteck", exact: true })
    .click();
  await dragOnCanvas(page, canvas, { x: 280, y: 75 }, { x: 385, y: 160 });
  const rectangle = page
    .locator('.live-canvas-shape[data-shape-kind="rectangle"]')
    .locator("..");
  await expect(rectangle).toHaveCount(1);

  await toolbar.getByRole("button", { name: "Auswählen", exact: true }).click();
  await page.mouse.move(canvasBox.x + 470, canvasBox.y + 250);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 550, canvasBox.y + 310, { steps: 5 });
  expect(await inkOverlayIsBlank(page)).toBe(true);
  await page.mouse.up();
  await expectInkCount(page, 1);

  // Ink has no DOM node: a click on the drawn line itself selects it.
  await page.mouse.click(canvasBox.x + 140, canvasBox.y + 105);
  await expect(page.locator(".live-canvas-element.is-selected")).toHaveCount(1);
  const rectangleBox = await rectangle.boundingBox();
  if (!rectangleBox) throw new Error("The rectangle cannot be selected.");
  await page.keyboard.down("Shift");
  await page.mouse.click(
    rectangleBox.x + rectangleBox.width / 2,
    rectangleBox.y + rectangleBox.height / 2,
  );
  await page.keyboard.up("Shift");
  await expect(page.locator(".live-canvas-element.is-selected")).toHaveCount(2);

  const resizeGroup = page.getByRole("group", { name: "Auswahlgrösse ändern" });
  const southEast = resizeGroup.getByRole("button", {
    name: "Auswahl von unten rechts skalieren",
  });
  await expect(southEast).toBeVisible();
  const strokeBefore = await strokeBox();
  const rectangleBefore = await rectangle.boundingBox();
  const growHandle = await southEast.boundingBox();
  if (!strokeBefore || !rectangleBefore || !growHandle) {
    throw new Error("The resize handle is unavailable.");
  }
  await page.mouse.move(
    growHandle.x + growHandle.width / 2,
    growHandle.y + growHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(growHandle.x + 90, growHandle.y + 65, { steps: 8 });
  await expect.poll(async () => (await strokeBox())?.width ?? 0)
    .toBeGreaterThan(strokeBefore.width);
  expect(await inkOverlayIsBlank(page)).toBe(true);
  await page.mouse.up();
  await waitForSaved(page);

  const strokeGrown = await strokeBox();
  const rectangleGrown = await rectangle.boundingBox();
  if (!strokeGrown || !rectangleGrown) throw new Error("The resized drawings disappeared.");
  expect(strokeGrown.width).toBeGreaterThan(strokeBefore.width);
  expect(rectangleGrown.width).toBeGreaterThan(rectangleBefore.width);

  await toolbar.getByRole("button", { name: "Rückgängig", exact: true }).click();
  await expect.poll(async () => (await strokeBox())?.width ?? 0)
    .toBeCloseTo(strokeBefore.width, 0);
  await toolbar.getByRole("button", { name: "Wiederholen", exact: true }).click();
  await expect.poll(async () => (await rectangle.boundingBox())?.width ?? 0)
    .toBeCloseTo(rectangleGrown.width, 0);

  const shrinkHandle = await southEast.boundingBox();
  if (!shrinkHandle) throw new Error("The resize handle disappeared after redo.");
  await page.mouse.move(
    shrinkHandle.x + shrinkHandle.width / 2,
    shrinkHandle.y + shrinkHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(shrinkHandle.x - 70, shrinkHandle.y - 50, { steps: 8 });
  await page.mouse.up();
  await waitForSaved(page);
  const strokeShrunk = await strokeBox();
  const rectangleShrunk = await rectangle.boundingBox();
  if (!strokeShrunk || !rectangleShrunk) throw new Error("The shrunken drawings disappeared.");
  expect(strokeShrunk.width).toBeLessThan(strokeGrown.width);
  expect(rectangleShrunk.width).toBeLessThan(rectangleGrown.width);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(async () => (await strokeBox())?.width ?? 0)
    .toBeCloseTo(strokeShrunk.width, 0);
  await expect.poll(async () => (
    await page.locator('.live-canvas-shape[data-shape-kind="rectangle"]').locator("..").boundingBox()
  )?.width ?? 0).toBeCloseTo(rectangleShrunk.width, 0);
});

test("every drawing tool creates, transforms, erases, undoes, redoes, and persists its intended element", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await gotoApp(page);

  const toolbar = await ribbonTab(page, "Zeichnen");
  const canvas = page.getByRole("application", {
    name: "Gemeinsame Seitenzeichenfläche",
  });
  await toolbar.getByRole("button", { name: "Stift", exact: true }).click();
  await expect(
    toolbar.getByRole("button", { name: "Stift", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await dragOnCanvas(page, canvas, { x: 70, y: 55 }, { x: 235, y: 60 });
  await expectInkCount(page, 1);
  expect((await inkStrokes(page))[0].color).toBe("#1d4ed8");
  const penPoint = (await inkStrokes(page))[0].samplePoint;
  // The stroke is painted in the chosen blue on its canvas tile.
  await expect.poll(async () => {
    const pixel = await inkPixelAt(page, penPoint);
    return pixel !== null && pixel.b > pixel.r + 60;
  }).toBe(true);

  await toolbar
    .getByRole("button", { name: "Textmarker", exact: true })
    .click();
  await dragOnCanvas(page, canvas, { x: 70, y: 95 }, { x: 235, y: 100 });
  await expectInkCount(page, 2);
  expect((await inkStrokes(page))[1]).toMatchObject({ tool: "highlighter", opacity: 0.36 });

  const shapes = [
    { label: "Linie", kind: "line", start: { x: 300, y: 50 }, end: { x: 400, y: 60 } },
    { label: "Pfeil", kind: "arrow", start: { x: 300, y: 90 }, end: { x: 400, y: 110 } },
    { label: "Vektor", kind: "vektor", start: { x: 300, y: 130 }, end: { x: 400, y: 150 } },
    { label: "Rechteck", kind: "rectangle", start: { x: 60, y: 180 }, end: { x: 145, y: 245 } },
    { label: "Ellipse", kind: "ellipse", start: { x: 165, y: 180 }, end: { x: 250, y: 245 } },
    { label: "Dreieck", kind: "triangle", start: { x: 270, y: 180 }, end: { x: 355, y: 245 } },
    { label: "Koordinatenachsen", kind: "axes", start: { x: 375, y: 180 }, end: { x: 470, y: 255 } },
  ] as const;

  for (const shape of shapes) {
    const tools = await openToolbarGroup(page, "Werkzeuge");
    await tools
      .getByRole("button", { name: shape.label, exact: true })
      .click();
    await expect(
      tools.getByRole("button", { name: shape.label, exact: true }),
    ).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await dragOnCanvas(page, canvas, shape.start, shape.end);
    await expect(
      page.locator(`.live-canvas-shape[data-shape-kind="${shape.kind}"]`),
    ).toHaveCount(1);
  }

  const rectangle = page
    .locator('.live-canvas-shape[data-shape-kind="rectangle"]')
    .locator("..");
  await toolbar
    .getByRole("button", { name: "Auswählen", exact: true })
    .click();
  const rectangleBeforeMove = await rectangle.boundingBox();
  if (!rectangleBeforeMove) throw new Error("The rectangle is not selectable.");
  await page.mouse.move(
    rectangleBeforeMove.x + rectangleBeforeMove.width / 2,
    rectangleBeforeMove.y + rectangleBeforeMove.height * 0.9,
  );
  await page.mouse.down();
  await page.mouse.move(
    rectangleBeforeMove.x + rectangleBeforeMove.width / 2 + 24,
    rectangleBeforeMove.y + rectangleBeforeMove.height * 0.9 + 18,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(rectangle).toHaveClass(/is-selected/);
  const rectangleAfterMove = await rectangle.boundingBox();
  if (!rectangleAfterMove) throw new Error("The moved rectangle disappeared.");
  expect(rectangleAfterMove.x - rectangleBeforeMove.x).toBeCloseTo(24, 0);
  expect(rectangleAfterMove.y - rectangleBeforeMove.y).toBeCloseTo(18, 0);

  let more = await openToolbarGroup(page, "Mehr");
  await more.getByRole("button", { name: "Auswahl vergrössern", exact: true }).click();
  const rectangleAfterResize = await rectangle.boundingBox();
  if (!rectangleAfterResize) throw new Error("The resized rectangle disappeared.");
  expect(rectangleAfterResize.width).toBeGreaterThan(rectangleAfterMove.width);

  more = await openToolbarGroup(page, "Mehr");
  await more.getByRole("button", { name: "15° drehen", exact: true }).click();
  await expect(rectangle).toHaveCSS("transform", "matrix(0.965926, 0.258819, -0.258819, 0.965926, 0, 0)");

  more = await ribbonTab(page, "Start");
  await more.getByRole("button", { name: "Kopieren", exact: true }).click();
  await expect(page.locator('.live-canvas-editor p.sr-only[role="status"]')).toContainText(
    "1 Element(e) kopiert.",
  );
  more = await ribbonTab(page, "Start");
  await more.getByRole("button", { name: "Einfügen", exact: true }).click();
  await expect(
    page.locator('.live-canvas-shape[data-shape-kind="rectangle"]'),
  ).toHaveCount(2);

  await (await openToolbarGroup(page, "Werkzeuge"))
    .getByRole("button", { name: "Lasso", exact: true })
    .click();
  const lassoCanvasBox = await canvas.boundingBox();
  if (!lassoCanvasBox) throw new Error("The canvas is unavailable for lasso selection.");
  await page.mouse.move(lassoCanvasBox.x + 40, lassoCanvasBox.y + 35);
  await page.mouse.down();
  await page.mouse.move(lassoCanvasBox.x + 265, lassoCanvasBox.y + 35, { steps: 4 });
  await page.mouse.move(lassoCanvasBox.x + 265, lassoCanvasBox.y + 125, { steps: 4 });
  await page.mouse.move(lassoCanvasBox.x + 40, lassoCanvasBox.y + 125, { steps: 4 });
  await page.mouse.move(lassoCanvasBox.x + 40, lassoCanvasBox.y + 35, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".live-canvas-element.is-selected")).toHaveCount(2);

  await (await openToolbarGroup(page, "Werkzeuge"))
    .getByRole("button", { name: "Strichradierer", exact: true })
    .click();
  const firstStrokePoint = (await inkStrokes(page))[0].samplePoint;
  await page.mouse.click(firstStrokePoint.x, firstStrokePoint.y);
  await expectInkCount(page, 1);

  await toolbar.getByRole("button", { name: "Rückgängig", exact: true }).click();
  await expectInkCount(page, 2);
  await toolbar.getByRole("button", { name: "Wiederholen", exact: true }).click();
  await expectInkCount(page, 1);

  await (await openToolbarGroup(page, "Werkzeuge"))
    .getByRole("button", { name: "Punktradierer", exact: true })
    .click();
  const { id: remainingStrokeId, box: remainingStrokeBox } = (await inkStrokes(page))[0];
  const eraserCanvasBox = await canvas.boundingBox();
  if (!eraserCanvasBox) throw new Error("The canvas is unavailable for point erasing.");
  await dragOnCanvas(
    page,
    canvas,
    {
      x: remainingStrokeBox.x - eraserCanvasBox.x + remainingStrokeBox.width / 2,
      y: remainingStrokeBox.y - eraserCanvasBox.y - 18,
    },
    {
      x: remainingStrokeBox.x - eraserCanvasBox.x + remainingStrokeBox.width / 2,
      y: remainingStrokeBox.y - eraserCanvasBox.y + remainingStrokeBox.height + 18,
    },
  );
  await expect.poll(async () => (await inkStrokes(page)).some((stroke) => stroke.id === remainingStrokeId))
    .toBe(false);
  await expect.poll(async () => inkCount(page)).toBeGreaterThan(0);
  const pointErasedStrokeCount = await inkCount(page);

  const richTextElements = page.locator('[data-element-kind="richText"]');
  const richTextCountBefore = await richTextElements.count();
  await (await openToolbarGroup(page, "Einfügen"))
    .getByRole("button", { name: "Text hinzufügen", exact: true })
    .click();
  await expect(richTextElements).toHaveCount(richTextCountBefore + 1);
  const insertedText = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
  await insertedText.fill("Werkzeugtest");
  await insertedText.press("Escape");

  await waitForSaved(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  for (const shape of shapes) {
    const expectedCount = shape.kind === "rectangle" ? 2 : 1;
    await expect(
      page.locator(`.live-canvas-shape[data-shape-kind="${shape.kind}"]`),
    ).toHaveCount(expectedCount);
  }
  await expectInkCount(page, pointErasedStrokeCount);
});

test("view controls remain open for related adjustments and pan plus zoom reset the viewport cleanly", async ({
  page,
}) => {
  await gotoApp(page);
  const canvas = page.getByRole("application", {
    name: "Gemeinsame Seitenzeichenfläche",
  });
  const viewport = page.getByLabel("Ansicht der Zeichenfläche");

  const tools = await openToolbarGroup(page, "Werkzeuge");
  await tools.getByRole("button", { name: "Rasterfang", exact: true }).click();
  await expect(
    tools.getByRole("button", { name: "Rasterfang", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await tools.getByRole("button", { name: "15°-Winkelfang", exact: true }).click();
  await tools.getByRole("button", { name: "Lineal", exact: true }).click();
  await expect(tools.getByRole("spinbutton", { name: "Linealwinkel" })).toBeVisible();

  const zoom = (await ribbonTab(page, "Ansicht")).getByRole("group", { name: "Zoom und Ansicht" });
  await zoom.getByRole("button", { name: "Vergrössern" }).click();
  await zoom.getByRole("button", { name: "Vergrössern" }).click();
  await expect(
    zoom.getByRole("button", { name: "Ansicht zurücksetzen" }),
  ).toHaveText("120 %");
  await zoom.getByRole("button", { name: "Verkleinern" }).click();
  await expect(
    zoom.getByRole("button", { name: "Ansicht zurücksetzen" }),
  ).toHaveText("110 %");
  await zoom.getByRole("button", { name: "Ansicht zurücksetzen" }).click();
  await expect(
    zoom.getByRole("button", { name: "Ansicht zurücksetzen" }),
  ).toHaveText("100 %");

  await (await openToolbarGroup(page, "Werkzeuge"))
    .getByRole("button", { name: "Verschieben", exact: true })
    .click();
  const viewportBefore = await canvas.boundingBox();
  const viewportBox = await viewport.boundingBox();
  if (!viewportBefore || !viewportBox) throw new Error("The canvas viewport is not visible.");
  // A free page starts at its top-left corner, as in OneNote: dragging it
  // right or down from there shows no desk, dragging it left and up pans.
  await page.mouse.move(viewportBox.x + 500, viewportBox.y + 350);
  await page.mouse.down();
  await page.mouse.move(viewportBox.x + 535, viewportBox.y + 375, { steps: 5 });
  await page.mouse.up();
  const viewportAnchored = await canvas.boundingBox();
  if (!viewportAnchored) throw new Error("The anchored canvas disappeared.");
  expect(viewportAnchored.x).toBeCloseTo(viewportBefore.x, 0);
  expect(viewportAnchored.y).toBeCloseTo(viewportBefore.y, 0);
  await page.mouse.move(viewportBox.x + 535, viewportBox.y + 375);
  await page.mouse.down();
  await page.mouse.move(viewportBox.x + 500, viewportBox.y + 350, { steps: 5 });
  await page.mouse.up();
  const viewportAfter = await canvas.boundingBox();
  if (!viewportAfter) throw new Error("The panned canvas disappeared.");
  expect(viewportAfter.x - viewportBefore.x).toBeCloseTo(-35, 0);
  expect(viewportAfter.y - viewportBefore.y).toBeCloseTo(-25, 0);

  const reset = (await ribbonTab(page, "Ansicht"))
    .getByRole("button", { name: "Ansicht zurücksetzen" });
  await reset.click();
  const viewportReset = await canvas.boundingBox();
  if (!viewportReset) throw new Error("The reset canvas disappeared.");
  expect(viewportReset.x).toBeCloseTo(viewportBefore.x, 0);
  expect(viewportReset.y).toBeCloseTo(viewportBefore.y, 0);
});

test("the highlighter multiplies over pen ink so the writing underneath stays dark", async ({
  page,
}) => {
  await gotoApp(page);
  const toolbar = await ribbonTab(page, "Zeichnen");
  const canvas = page.getByRole("application", {
    name: "Gemeinsame Seitenzeichenfläche",
  });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The shared canvas has no visible bounds.");

  await toolbar.getByRole("button", { name: "Stift", exact: true }).click();
  await dragOnCanvas(page, canvas, { x: 80, y: 150 }, { x: 260, y: 150 });
  await toolbar.getByRole("button", { name: "Textmarker", exact: true }).click();
  await dragOnCanvas(page, canvas, { x: 170, y: 90 }, { x: 170, y: 210 });
  await expectInkCount(page, 2);

  const crossing = { x: box.x + 170, y: box.y + 150 };
  await expect.poll(async () => {
    const pixel = await inkPixelAt(page, crossing);
    return pixel !== null && pixel.b > pixel.r + 60;
  }).toBe(true);
  const highlightOnly = await inkPixelAt(page, { x: box.x + 170, y: box.y + 110 });
  expect(highlightOnly).not.toBeNull();
  expect(highlightOnly!.r).toBeGreaterThan(highlightOnly!.b);
});

test("Ctrl+wheel zooms the canvas around the pointer instead of the whole app", async ({
  page,
}) => {
  await gotoApp(page);
  const canvas = page.getByRole("application", {
    name: "Gemeinsame Seitenzeichenfläche",
  });
  const viewport = page.getByLabel("Ansicht der Zeichenfläche");
  const box = await viewport.boundingBox();
  const before = await canvas.boundingBox();
  if (!box || !before) throw new Error("The canvas viewport is not visible.");
  await page.evaluate(() => {
    (window as Window & { __wheelHandled?: boolean[] }).__wheelHandled = [];
    window.addEventListener("wheel", (event) => {
      (window as Window & { __wheelHandled?: boolean[] }).__wheelHandled?.push(event.defaultPrevented);
    });
  });

  const anchor = { x: box.x + 300, y: box.y + 200 };
  const pageAnchorBefore = { x: (anchor.x - before.x) / 1, y: (anchor.y - before.y) / 1 };
  await page.mouse.move(anchor.x, anchor.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");

  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(before.width * 1.2);
  const after = await canvas.boundingBox();
  if (!after) throw new Error("The zoomed canvas disappeared.");
  const zoom = after.width / before.width;
  // The page point under the pointer stays under the pointer.
  expect(after.x + pageAnchorBefore.x * zoom).toBeCloseTo(anchor.x, 0);
  expect(after.y + pageAnchorBefore.y * zoom).toBeCloseTo(anchor.y, 0);
  expect(await page.evaluate(() => (window as Window & { __wheelHandled?: boolean[] }).__wheelHandled)).toEqual([true]);
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
});

test("a free page keeps a viewport of empty paper below the lowest ink", async ({
  page,
}) => {
  await gotoApp(page);
  const canvas = page.getByRole("application", {
    name: "Gemeinsame Seitenzeichenfläche",
  });
  await expect(canvas).toHaveClass(/live-canvas-surface--free/);
  const viewport = page.getByLabel("Ansicht der Zeichenfläche");
  const viewportBox = await viewport.boundingBox();
  if (!viewportBox) throw new Error("The canvas viewport is not visible.");

  await (await ribbonTab(page, "Zeichnen"))
    .getByRole("button", { name: "Stift", exact: true }).click();
  // Scroll down past the first screen and keep writing there.
  for (let step = 0; step < 3; step += 1) {
    await page.mouse.move(viewportBox.x + 300, viewportBox.y + 300);
    await page.mouse.wheel(0, viewportBox.height * 0.8);
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("The canvas disappeared.");
    const y = viewportBox.y + viewportBox.height - 60;
    await page.mouse.move(viewportBox.x + 200, y);
    await page.mouse.down();
    await page.mouse.move(viewportBox.x + 320, y + 10, { steps: 6 });
    await page.mouse.up();
    await expectInkCount(page, step + 1);
  }
  const lowest = Math.max(...(await inkStrokes(page)).map((stroke) => stroke.box.y + stroke.box.height));
  await expect.poll(async () => {
    const canvasBox = await canvas.boundingBox();
    return (canvasBox?.y ?? 0) + (canvasBox?.height ?? 0) - lowest;
  }).toBeGreaterThanOrEqual(viewportBox.height - 2);
});

test("one eraser swipe removes every stroke it crosses and a lasso moves ink together", async ({
  page,
}) => {
  await gotoApp(page);
  const toolbar = await ribbonTab(page, "Zeichnen");
  const canvas = page.getByRole("application", {
    name: "Gemeinsame Seitenzeichenfläche",
  });
  await toolbar.getByRole("button", { name: "Stift", exact: true }).click();
  for (const x of [80, 120, 160]) {
    await dragOnCanvas(page, canvas, { x, y: 60 }, { x: x + 4, y: 140 });
  }
  await dragOnCanvas(page, canvas, { x: 300, y: 60 }, { x: 380, y: 70 });
  await expectInkCount(page, 4);

  // Lasso the three vertical strokes, then drag the selection by one of them.
  await (await openToolbarGroup(page, "Werkzeuge"))
    .getByRole("button", { name: "Lasso", exact: true })
    .click();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The shared canvas has no visible bounds.");
  const loop = [{ x: 60, y: 40 }, { x: 190, y: 40 }, { x: 190, y: 160 }, { x: 60, y: 160 }, { x: 60, y: 40 }];
  await page.mouse.move(box.x + loop[0].x, box.y + loop[0].y);
  await page.mouse.down();
  for (const point of loop.slice(1)) await page.mouse.move(box.x + point.x, box.y + point.y, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".live-canvas-ink-selection.is-selected")).toHaveCount(3);
  const before = await inkStrokes(page);
  const grab = before[1].samplePoint;
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 40, grab.y + 200, { steps: 6 });
  await page.mouse.up();
  // A moved stroke is drawn again above the page's other ink, so strokes are found by id, not by position.
  const strokeById = async (id: string) => (await inkStrokes(page)).find((stroke) => stroke.id === id);
  await expect.poll(async () => ((await strokeById(before[0].id))?.box.y ?? 0) - before[0].box.y).toBeCloseTo(200, 0);
  const moved = await Promise.all(before.slice(0, 3).map(async (stroke) => (await strokeById(stroke.id))!));
  for (const index of [0, 1, 2]) {
    expect(moved[index].box.x - before[index].box.x).toBeCloseTo(40, 0);
  }
  expect((await strokeById(before[3].id))?.box).toEqual(before[3].box);

  // A single swipe across the three moved strokes erases them all, as one undo step.
  await (await openToolbarGroup(page, "Werkzeuge"))
    .getByRole("button", { name: "Strichradierer", exact: true })
    .click();
  const y = moved[0].samplePoint.y;
  await page.mouse.move(moved[0].box.x - 30, y);
  await page.mouse.down();
  await page.mouse.move(moved[2].box.x + moved[2].box.width + 30, y, { steps: 3 });
  await page.mouse.up();
  await expectInkCount(page, 1);
  await toolbar.getByRole("button", { name: "Rückgängig", exact: true }).click();
  await expectInkCount(page, 4);
});
