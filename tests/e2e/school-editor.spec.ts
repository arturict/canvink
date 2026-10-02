import type { Locator, Page } from "@playwright/test";
import {
  chooseLanguage,
  expect,
  gotoApp,
  inkStrokes,
  openPageSettings,
  ribbonTab,
  test,
  waitForSaved,
} from "./support";

// The former toolbar menus now live in ribbon tabs.
async function openToolbarGroup(page: Page, label: "Werkzeuge" | "Tools"): Promise<Locator> {
  void label;
  return ribbonTab(page, "Zeichnen");
}

function lineAngleDegrees(points: string): number {
  const coordinates = points.trim().split(/\s+/).map((pair) => pair.split(",").map(Number));
  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (!first || !last) throw new Error("Expected at least two ruler-aligned points.");
  return Math.atan2(last[1] - first[1], last[0] - first[0]) * 180 / Math.PI;
}

test("creates a snapped SVG school-paper shape and preserves it across zoom and reload", async ({
  page,
}) => {
  await gotoApp(page);

  const canvas = page.getByRole("application", {
    name: "Gemeinsame Seitenzeichenfläche",
  });
  await openPageSettings(page);
  await page.getByRole("group", { name: "Papierhintergrund" }).getByRole("button", { name: "Millimeter" }).click();
  await page.getByRole("button", { name: "Seiteneinstellungen schliessen", exact: true }).click();
  await expect(canvas).toHaveClass(/live-canvas-surface--millimeter/);
  const view = await openToolbarGroup(page, "Werkzeuge");
  const gridSnap = view.getByRole("button", { name: "Rasterfang", exact: true });
  await gridSnap.click();
  await expect((await openToolbarGroup(page, "Werkzeuge")).getByRole("button", {
    name: "Rasterfang", exact: true,
  })).toHaveAttribute("aria-pressed", "true");
  const shapes = await openToolbarGroup(page, "Werkzeuge");
  await shapes.getByRole("button", { name: "Rechteck", exact: true }).click();
  await expect((await openToolbarGroup(page, "Werkzeuge")).getByRole("button", {
    name: "Rechteck", exact: true,
  })).toHaveAttribute("aria-pressed", "true");

  const box = await canvas.boundingBox();
  if (!box) throw new Error("Die Zeichenfläche hat keinen sichtbaren Rahmen.");
  await page.mouse.move(box.x + 73, box.y + 77);
  await page.mouse.down();
  await page.mouse.move(box.x + 198, box.y + 153, { steps: 4 });
  await page.mouse.up();

  const rectangle = page.locator(
    '.live-canvas-shape[data-shape-kind="rectangle"]',
  );
  await expect(rectangle).toBeVisible();
  const element = rectangle.locator("..");
  await expect(element).toHaveCSS("left", "70px");
  await expect(element).toHaveCSS("top", "80px");
  await expect(rectangle.locator("rect")).toHaveCount(1);

  const zoom = (await ribbonTab(page, "Ansicht")).getByRole("group", { name: "Zoom und Ansicht" });
  await zoom.getByRole("button", { name: "Vergrössern" }).click();
  await expect(
    (await ribbonTab(page, "Ansicht"))
      .getByRole("button", { name: "Ansicht zurücksetzen" }),
  ).toHaveText("110 %");
  await waitForSaved(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await openPageSettings(page);
  await expect(
    page.getByRole("group", { name: "Papierhintergrund" }).getByRole("button", { name: "Millimeter" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator('.live-canvas-shape[data-shape-kind="rectangle"] rect'),
  ).toBeVisible();
});

test("moves and freely rotates a persistent ruler that aligns ink and straight tools through zoom and pan", async ({
  page,
}) => {
  await gotoApp(page);

  const tools = await ribbonTab(page, "Zeichnen");
  const view = await openToolbarGroup(page, "Werkzeuge");
  const rulerToggle = view.getByRole("button", { name: "Lineal", exact: true });
  await rulerToggle.click();
  const ruler = page.getByRole("group", { name: /Verschiebbares Lineal/ });
  const reopenedView = await openToolbarGroup(page, "Werkzeuge");
  await expect(reopenedView.getByRole("button", { name: "Lineal", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  const angleInput = reopenedView.getByRole("spinbutton", { name: "Linealwinkel" });
  await expect(ruler).toBeVisible();

  await angleInput.fill("36");
  await ruler.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(ruler).toHaveAttribute("data-ruler-angle", "37");
  await expect(ruler).toHaveAccessibleName("Verschiebbares Lineal, 37 Grad");

  const xBeforeKeyboard = Number(await ruler.getAttribute("data-ruler-x"));
  await page.keyboard.press("Shift+ArrowRight");
  await expect(ruler).toHaveAttribute("data-ruler-x", String(xBeforeKeyboard + 10));


  const body = ruler.locator(".live-canvas-ruler__body");
  const beforeDragX = Number(await ruler.getAttribute("data-ruler-x"));
  const beforeDragY = Number(await ruler.getAttribute("data-ruler-y"));
  const bodyBox = await body.boundingBox();
  if (!bodyBox) throw new Error("The visible ruler has no pointer target.");
  await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(bodyBox.x + bodyBox.width / 2 + 32, bodyBox.y + bodyBox.height / 2 + 18, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Number(await ruler.getAttribute("data-ruler-x"))).toBeCloseTo(beforeDragX + 32, 0);
  await expect.poll(async () => Number(await ruler.getAttribute("data-ruler-y"))).toBeCloseTo(beforeDragY + 18, 0);

  const beforeZoom = await ruler.boundingBox();
  if (!beforeZoom) throw new Error("The ruler disappeared before zooming.");
  const zoom = (await ribbonTab(page, "Ansicht")).getByRole("group", { name: "Zoom und Ansicht" });
  await zoom.getByRole("button", { name: "Vergrössern" }).click();
  const afterZoom = await ruler.boundingBox();
  if (!afterZoom) throw new Error("The ruler disappeared after zooming.");
  expect(afterZoom.width / beforeZoom.width).toBeCloseTo(1.1, 1);

  await (await openToolbarGroup(page, "Werkzeuge")).getByRole("button", { name: "Verschieben", exact: true }).click();
  const viewport = page.getByLabel("Ansicht der Zeichenfläche");
  const viewportBox = await viewport.boundingBox();
  if (!viewportBox) throw new Error("The canvas viewport is not visible.");
  const beforePan = await ruler.boundingBox();
  if (!beforePan) throw new Error("The ruler disappeared before panning.");
  await page.mouse.move(viewportBox.x + 24, viewportBox.y + viewportBox.height - 24);
  await page.mouse.down();
  await page.mouse.move(viewportBox.x + 59, viewportBox.y + viewportBox.height - 4, { steps: 4 });
  await page.mouse.up();
  const afterPan = await ruler.boundingBox();
  if (!afterPan) throw new Error("The ruler disappeared after panning.");
  expect(afterPan.x - beforePan.x).toBeCloseTo(35, 0);
  expect(afterPan.y - beforePan.y).toBeCloseTo(20, 0);

  await (await ribbonTab(page, "Ansicht"))
    .getByRole("button", { name: "Ansicht zurücksetzen" })
    .click();
  const canvas = page.getByRole("application", { name: "Gemeinsame Seitenzeichenfläche" });
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("The canvas has no visible bounds.");
  const rulerX = Number(await ruler.getAttribute("data-ruler-x"));
  const rulerY = Number(await ruler.getAttribute("data-ruler-y"));
  const angle = 37 * Math.PI / 180;
  const tangent = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -tangent.y, y: tangent.x };
  const edgeCenter = { x: rulerX - normal.x * 36, y: rulerY - normal.y * 36 };
  const screenPoint = (distance: number) => ({
    x: canvasBox.x + edgeCenter.x + tangent.x * distance - normal.x * 8,
    y: canvasBox.y + edgeCenter.y + tangent.y * distance - normal.y * 8,
  });

  await (await openToolbarGroup(page, "Werkzeuge"))
    .getByRole("button", { name: "Linie", exact: true })
    .click();
  let start = screenPoint(-150);
  let end = screenPoint(150);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  const line = page.locator('.live-canvas-shape[data-shape-kind="line"] line').last();
  await expect(line).toBeVisible();
  const lineCoordinates = ["x1", "y1", "x2", "y2"].map(async (name) => Number(await line.getAttribute(name)));
  const [x1, y1, x2, y2] = await Promise.all(lineCoordinates);
  expect(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI).toBeCloseTo(37, 0);

  await tools.getByRole("button", { name: "Stift", exact: true }).click();
  start = screenPoint(-120);
  end = screenPoint(120);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await inkStrokes(page)).length).toBeGreaterThan(0);
  const ink = (await inkStrokes(page)).at(-1);
  expect(lineAngleDegrees(ink?.localPoints ?? "")).toBeCloseTo(37, 0);
  await waitForSaved(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(page.getByRole("group", { name: /Verschiebbares Lineal/ })).toHaveAttribute("data-ruler-angle", "37");
  await expect(page.locator('.live-canvas-shape[data-shape-kind="line"]')).toBeVisible();
  await expect.poll(async () => (await inkStrokes(page)).at(-1)?.localPoints ?? "").toBe(ink?.localPoints);

  await page.locator(".app-topbar").getByRole("button", { name: "Mehr", exact: true }).click();
  await chooseLanguage(page, "en");
  await expect(page.getByRole("group", { name: "Movable ruler, 37 degrees" })).toBeVisible();
  await expect((await openToolbarGroup(page, "Tools")).getByRole("spinbutton", { name: "Ruler angle" })).toHaveValue("37");
});

// Dragging pages between sections is a feature of the nested tree navigation
// used below 1100 px; wide windows show OneNote-style section and page columns.
test.describe("tree navigation", () => {
test.use({ viewport: { width: 1000, height: 900 } });

test("moves and modifier-copies a page subtree by drag across sections while preventing cycles", async ({
  page,
}) => {
  await gotoApp(page);
  // The tree unfolds only the open section; unfold the others to drag between them.
  for (const title of ["Beispiele", "Vorlagen"]) {
    await page.locator(".section-row > button").filter({ hasText: new RegExp(`^${title}$`) }).click();
  }

  const start = page.getByRole("button", {
    name: "Hier starten Frei",
    exact: true,
  });
  const ideas = page.getByRole("button", { name: "Ideen Frei", exact: true });
  const startRow = start.locator("..");
  const ideasRow = ideas.locator("..");
  // OneNote's gesture: drop below "Ideen" and drag to the right to make
  // "Hier starten" its subpage.
  const ideasBox = await ideasRow.boundingBox();
  if (!ideasBox) throw new Error("The Ideen row is not visible.");
  await start.dragTo(ideasRow, {
    targetPosition: { x: ideasBox.width / 2 + 40, y: ideasBox.height - 3 },
  });
  await waitForSaved(page);
  await expect(startRow).toHaveCSS("padding-left", "64px");

  // Dropping a page among its own subpages leaves the tree unchanged.
  await ideas.dragTo(startRow);
  await expect(startRow).toHaveCSS("padding-left", "64px");
  await expect(ideasRow).toHaveCSS("padding-left", "44px");

  const notesSection = page.locator(".section-block").filter({
    has: page.getByRole("button", { name: "Notizen", exact: true }),
  });
  await ideas.dragTo(notesSection, { targetPosition: { x: 20, y: 10 } });
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Ideen");
  await waitForSaved(page);

  const movedIdeas = notesSection.getByRole("button", {
    name: "Ideen Frei",
    exact: true,
  });
  const movedChild = notesSection.getByRole("button", {
    name: "Hier starten Frei",
    exact: true,
  });
  await expect(movedIdeas).toBeVisible();
  await expect(movedChild.locator("..")).toHaveCSS("padding-left", "64px");

  const templatesSection = page.locator(".section-block").filter({
    has: page.getByRole("button", { name: "Vorlagen", exact: true }),
  });
  await page.keyboard.down("Control");
  try {
    await movedIdeas.dragTo(templatesSection, {
      targetPosition: { x: 20, y: 10 },
    });
  } finally {
    await page.keyboard.up("Control");
  }
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Ideen – Kopie");
  await waitForSaved(page);

  const copiedIdeas = templatesSection.getByRole("button", {
    name: "Ideen – Kopie Frei",
    exact: true,
  });
  const copiedChild = templatesSection.getByRole("button", {
    name: "Hier starten Frei",
    exact: true,
  });
  await expect(copiedIdeas).toBeVisible();
  await expect(copiedChild.locator("..")).toHaveCSS("padding-left", "64px");
  await expect(
    notesSection.getByRole("button", { name: "Ideen Frei", exact: true }),
  ).toBeVisible();
  await expect(
    notesSection
      .getByRole("button", { name: "Hier starten Frei", exact: true })
      .locator(".."),
  ).toHaveCSS("padding-left", "64px");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Ideen – Kopie");
  await expect(
    templatesSection.getByRole("button", {
      name: "Ideen – Kopie Frei",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    templatesSection
      .getByRole("button", { name: "Hier starten Frei", exact: true })
      .locator(".."),
  ).toHaveCSS("padding-left", "64px");
  await expect(
    notesSection.getByRole("button", { name: "Ideen Frei", exact: true }),
  ).toBeVisible();
  await expect(
    notesSection
      .getByRole("button", { name: "Hier starten Frei", exact: true })
      .locator(".."),
  ).toHaveCSS("padding-left", "64px");
});
});
