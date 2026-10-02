import { readFile } from "node:fs/promises";
import type { Download, Locator, Page } from "@playwright/test";
import { acceptConfirm, chooseLanguage, expect, expectInkCount, inkStrokes, ribbonTab, test, waitForSaved } from "./support";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const MATH_FIELD = "math-field.math-block__field";
/** The graph's legend lists its series once the math engine, a lazily loaded chunk, has computed them; a busy machine takes long for that. */
const GRAPH_SERIES_TIMEOUT_MS = 60_000;

async function gotoMathApp(page: Page): Promise<void> {
  await page.goto('/app?__canvinkFeatureMath=1', { waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
}

async function switchToEnglish(page: Page): Promise<void> {
  await page.locator(".app-topbar").getByRole("button", { name: "Mehr", exact: true }).click();
  await chooseLanguage(page, "en");
  await page.locator(".app-topbar").getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "English", exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
}

function canvas(page: Page): Locator {
  return page.getByRole("application", { name: "Shared page canvas" });
}

function toolbar(page: Page): Promise<Locator> {
  return ribbonTab(page, "Zeichnen");
}

// The former toolbar menus now live in ribbon tabs.
async function openToolbarGroup(page: Page, label: "Insert"): Promise<Locator> {
  void label;
  return ribbonTab(page, "Einfügen");
}

function mathElements(page: Page): Locator {
  return page.locator('[data-element-kind="math"]');
}

function exactResult(mathElement: Locator): Locator {
  return mathElement.locator('.math-block__result-field');
}

async function createTypedMath(page: Page, x: number, y: number): Promise<Locator> {
  const surface = canvas(page);
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error("The shared canvas has no visible bounds.");
  const before = await mathElements(page).count();
  await (await openToolbarGroup(page, "Insert"))
    .getByRole("button", { name: "Math", exact: true })
    .click();
  await page.mouse.click(bounds.x + x, bounds.y + y);
  await expect(mathElements(page)).toHaveCount(before + 1);
  return mathElements(page).nth(before);
}

async function setMathLatex(element: Locator, latex: string): Promise<void> {
  const field = element.locator(MATH_FIELD);
  await expect(field).toBeVisible();
  await field.evaluate((node, nextLatex) => {
    const mathField = node as HTMLElement & { value: string };
    mathField.value = nextLatex;
    mathField.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: "insertText",
    }));
  }, latex);
  await expect(field).toHaveAttribute("data-latex", latex);
}

async function drawPointerStroke(
  page: Page,
  surface: Locator,
  pointerType: "mouse" | "pen",
  points: readonly { x: number; y: number }[],
): Promise<void> {
  if (points.length < 2) throw new Error("A test stroke needs at least two points.");
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error("The shared canvas has no visible bounds.");
  const screenPoint = (point: { x: number; y: number }) => ({ x: bounds.x + point.x, y: bounds.y + point.y });
  if (pointerType === "mouse") {
    const first = screenPoint(points[0]);
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    for (const point of points.slice(1)) {
      const screen = screenPoint(point);
      await page.mouse.move(screen.x, screen.y);
    }
    await page.mouse.up();
    return;
  }
  const session = await page.context().newCDPSession(page);
  try {
    const first = screenPoint(points[0]);
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: first.x, y: first.y, button: "left", buttons: 1, clickCount: 1,
      pointerType: "pen", force: 0.55,
    });
    for (const point of points.slice(1)) {
      const screen = screenPoint(point);
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: screen.x, y: screen.y, button: "left", buttons: 1,
        pointerType: "pen", force: 0.55,
      });
    }
    const last = screenPoint(points.at(-1)!);
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: last.x, y: last.y, button: "left", buttons: 0, clickCount: 1,
      pointerType: "pen", force: 0,
    });
  } finally {
    await session.detach();
  }
}

async function graphFingerprint(graph: Locator): Promise<string> {
  return graph.locator(".graph-board__surface").evaluate((surface) =>
    [...surface.querySelectorAll<SVGPathElement>("svg path")]
      .map((path) => path.getAttribute("d") ?? "")
      .filter(Boolean)
      .join("|"),
  );
}

async function downloadedBytes(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error(`Download ${download.suggestedFilename()} has no local path.`);
  return readFile(path);
}

/** Walks the File menu ("Export" or "Advanced" first, then the command) and returns the download it starts. */
async function clickDownload(
  page: Page,
  ...path: Array<string | RegExp>
): Promise<Download> {
  await page.locator(".ribbon__tabs").getByRole("button", { name: "File", exact: true }).click();
  const last = path.pop();
  if (last === undefined) throw new Error("clickDownload needs a menu item.");
  for (const name of path) await page.getByRole("menuitem", { name, exact: true }).click();
  const pending = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("menuitem", { name: last }).click();
  return pending;
}

test("typed MathLive formulas recompute variables, scrubbers, graphs, exports, reload, and offline state", async ({
  context,
  page,
}) => {
  await gotoMathApp(page);
  await switchToEnglish(page);
  await page.getByLabel("Page title").fill("Math Canvas browser round-trip");

  const definition = await createTypedMath(page, 55, 45);
  await expect(definition.locator(".math-block")).toHaveAttribute("data-input-kind", "typed");
  await setMathLatex(definition, "\\frac{1}{3}");
  await expect(definition.locator(".math-block__status")).toHaveText("Ready");
  await expect(exactResult(definition)).toHaveAttribute("data-latex", "\\frac{1}{3}");

  await definition.getByLabel("Number display").selectOption("decimal");
  await expect(definition.getByLabel("Result", { exact: true })).toHaveText("0.\\overline{3}");
  await definition.getByLabel("Number display").selectOption("exact");
  await expect(exactResult(definition)).toHaveAttribute("data-latex", "\\frac{1}{3}");
  await definition.getByLabel("Result mode").selectOption("off");
  await expect(definition.getByLabel("Result", { exact: true })).toHaveCount(0);
  await definition.getByLabel("Result mode").selectOption("suggest");
  await definition.getByRole("button", { name: "Insert result permanently" }).click();
  await expect(definition.locator(".math-block__result")).toHaveAttribute("data-result-mode", "insert");
  await definition.getByLabel("Result mode").selectOption("suggest");

  await setMathLatex(definition, "a=2");
  await expect(exactResult(definition)).toHaveAttribute("data-latex", "2");
  const dependent = await createTypedMath(page, 455, 45);
  await setMathLatex(dependent, "a+1");
  await expect(exactResult(dependent)).toHaveAttribute("data-latex", "3");

  const graphSource = await createTypedMath(page, 55, 275);
  await setMathLatex(graphSource, "x^2+y^2=a^2");
  const graphButton = (await openToolbarGroup(page, "Insert"))
    .getByRole("button", { name: "Graph selection" });
  await expect(graphButton).toBeEnabled();
  await graphButton.click();
  const graph = page.locator('[data-element-kind="graph"]').last();
  await expect(graph.getByRole("region", { name: "Interactive graph" })).toBeVisible();
  await expect(graph.locator(".graph-board__legend input[type=checkbox]")).toBeChecked({ timeout: GRAPH_SERIES_TIMEOUT_MS });
  await expect.poll(() => graphFingerprint(graph)).not.toBe("");
  const initialGraph = await graphFingerprint(graph);
  const graphSurface = graph.getByRole("img", {
    name: "Graph surface with coordinate inspection",
  });
  await expect(graphSurface).toBeVisible();
  const graphInteractiveSurface = graph.locator(".graph-board__surface");
  const inspectedPoint = graph.getByLabel("Inspected graph coordinate");
  await expect(inspectedPoint).toHaveText("Select a curve to inspect coordinates");
  await graphInteractiveSurface.scrollIntoViewIfNeeded();
  const graphBounds = await graphInteractiveSurface.boundingBox();
  if (!graphBounds) throw new Error("The interactive graph has no visible bounds.");
  // The source is a radius-2 circle in the default -10..10 viewport. Inspect
  // the curve at approximately (2, 0), rather than the empty centre.
  await page.mouse.click(
    graphBounds.x + graphBounds.width * 0.6,
    graphBounds.y + graphBounds.height * 0.5,
  );
  await expect(inspectedPoint).toContainText(/x = .+, y = .+/);

  // The toggle lives in the Insert tab; later steps switch to the Draw tab for
  // Undo, so it is looked up again each time instead of kept as a stale locator.
  const sidebarToggle = async () => (await openToolbarGroup(page, "Insert"))
    .getByRole("button", { name: "Math sidebar", exact: true });
  await (await sidebarToggle()).click();
  await expect(await sidebarToggle()).toHaveAttribute("aria-pressed", "true");
  const mathSidebar = page.getByRole("complementary", { name: "Math sidebar" });
  const palette = mathSidebar.getByRole("complementary", { name: "Calculator palette" });
  await expect(palette.getByRole("heading", { name: "Scientific" })).toBeVisible();
  await palette.getByRole("button", { name: "+", exact: true }).click();
  await expect(mathElements(page)).toHaveCount(4);
  await expect(mathElements(page).last().locator(MATH_FIELD)).toHaveAttribute("data-latex", "+");
  await (await toolbar(page)).getByRole("button", { name: "Undo", exact: true }).click();
  await expect(mathElements(page)).toHaveCount(3);

  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 640, height: 900 });
  const mobileNavigation = page.getByRole("navigation", { name: /Notebook navigation|Notizbuchnavigation/ });
  if (await mobileNavigation.isVisible()) {
    await mobileNavigation
      .getByRole("button", { name: /Close (?:notebook )?navigation|Navigation schliessen/ })
      .click();
  }
  await expect(mathSidebar).toBeVisible();
  await palette.getByRole("button", { name: "−", exact: true }).click();
  await expect(mathElements(page)).toHaveCount(4);
  await expect(mathElements(page).last().locator(MATH_FIELD)).toHaveAttribute("data-latex", "-");
  await (await toolbar(page)).getByRole("button", { name: "Undo", exact: true }).click();
  await expect(mathElements(page)).toHaveCount(3);
  if (desktopViewport) await page.setViewportSize(desktopViewport);

  const units = mathSidebar.getByRole("complementary", { name: "Units and currencies" });
  await expect(units.getByText("Unit conversion is unavailable in the web version", { exact: true })).toBeVisible();
  await expect(units.getByRole("button", { name: "Convert", exact: true })).toBeDisabled();
  await units.getByRole("tab", { name: "Currencies", exact: true }).click();
  await expect(units.getByRole("tab", { name: "Currencies", exact: true })).toHaveAttribute("aria-selected", "true");

  const history = mathSidebar.locator("section").filter({
    has: page.getByRole("heading", { name: "Calculator history" }),
  });
  const dependentHistory = history.locator("li").filter({ has: page.locator("code", { hasText: "a+1" }) });
  await expect(dependentHistory.locator("output")).toHaveText("3");
  await dependentHistory.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(mathElements(page)).toHaveCount(4);
  await expect(mathElements(page).last().locator(MATH_FIELD)).toHaveAttribute("data-latex", "a+1");
  await (await toolbar(page)).getByRole("button", { name: "Undo", exact: true }).click();
  await expect(mathElements(page)).toHaveCount(3);
  await mathSidebar.getByLabel("Automatically start handwriting recognition on this page").uncheck();
  await (await sidebarToggle()).click();
  await expect(mathSidebar).toBeHidden();

  const scrubber = definition.getByRole("button", { name: "Drag number 2 horizontally" });
  await scrubber.focus();
  await page.keyboard.press("ArrowRight");
  await expect(definition.locator(MATH_FIELD)).toHaveAttribute("data-latex", "a=3");
  await expect(exactResult(dependent)).toHaveAttribute("data-latex", "4");
  await expect.poll(() => graphFingerprint(graph)).not.toBe(initialGraph);

  await (await toolbar(page)).getByRole("button", { name: "Undo", exact: true }).click();
  await expect(exactResult(dependent)).toHaveAttribute("data-latex", "3");
  await (await toolbar(page)).getByRole("button", { name: "Redo", exact: true }).click();
  await expect(exactResult(dependent)).toHaveAttribute("data-latex", "4");

  const viewportBefore = await graphFingerprint(graph);
  await graphInteractiveSurface.scrollIntoViewIfNeeded();
  const zoomIn = graphInteractiveSurface.locator(".JXG_navigation_button_in");
  await expect(zoomIn).toBeVisible();
  await zoomIn.click();
  await expect.poll(() => graphFingerprint(graph)).not.toBe(viewportBefore);
  await graph.getByLabel("Equal axis scale").uncheck();
  await graph.locator(".graph-board__legend input[type=checkbox]").uncheck({ timeout: GRAPH_SERIES_TIMEOUT_MS });
  await waitForSaved(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  const reopenedGraph = page.locator('[data-element-kind="graph"]').last();
  await expect(reopenedGraph.getByLabel("Equal axis scale")).not.toBeChecked();
  await expect(reopenedGraph.locator(".graph-board__legend input[type=checkbox]")).not.toBeChecked({ timeout: GRAPH_SERIES_TIMEOUT_MS });
  const persistedViewport = await graphFingerprint(reopenedGraph);
  await reopenedGraph.getByRole("button", { name: "Reset view" }).click();
  await expect.poll(() => graphFingerprint(reopenedGraph)).not.toBe(persistedViewport);
  await reopenedGraph.locator(".graph-board__legend input[type=checkbox]").check({ timeout: GRAPH_SERIES_TIMEOUT_MS });
  await (await openToolbarGroup(page, "Insert"))
    .getByRole("button", { name: "Math sidebar", exact: true })
    .click();
  await expect(page.getByLabel("Automatically start handwriting recognition on this page")).not.toBeChecked();
  await waitForSaved(page);

  const markdown = await downloadedBytes(await clickDownload(page, "Export", "Page Markdown"));
  const markdownText = markdown.toString("utf8");
  expect(markdownText).toContain("Math Canvas browser round-trip");
  expect(markdownText).toContain("> Math: `a=3` = `3`");
  expect(markdownText).toContain("> Graph: `x^2+y^2=a^2`");

  const png = await downloadedBytes(await clickDownload(page, "Export", "Page PNG"));
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const pdf = await downloadedBytes(await clickDownload(page, "Export", "Page PDF"));
  expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");

  const jsonDownload = await clickDownload(page, "Advanced", "Current schema JSON");
  const jsonPath = await jsonDownload.path();
  if (!jsonPath) throw new Error("The current-schema JSON export has no local path.");
  const currentJsonText = (await readFile(jsonPath)).toString("utf8");
  const currentJson = JSON.parse(currentJsonText) as {
    format: string;
    schemaVersion: number;
    pages: Array<{ title: string; elementsById: Record<string, { kind: string }> }>;
  };
  expect(currentJson).toMatchObject({ format: "canvink-portable-json-v3", schemaVersion: 3 });
  const exportedPage = currentJson.pages.find((candidate) => candidate.title === "Math Canvas browser round-trip");
  expect(exportedPage).toBeDefined();
  expect(Object.values(exportedPage?.elementsById ?? {}).filter((element) => element.kind === "math")).toHaveLength(3);
  expect(Object.values(exportedPage?.elementsById ?? {}).filter((element) => element.kind === "graph")).toHaveLength(1);
  expect(currentJsonText).not.toMatch(/bearer|authorization|apiKey|providerConfig|endpoint/i);

  const bundleDownload = await clickDownload(page, /Notebook \.canvink/);
  const bundlePath = await bundleDownload.path();
  if (!bundlePath) throw new Error("The Math Canvas bundle has no local path.");
  const mathIdsBeforeImport = await mathElements(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-element-id")),
  );
  await page.locator('input[type="file"][accept^=".canvink"]').setInputFiles(bundlePath);
  await acceptConfirm(page);
  await expect(page.locator(".v2-notice")).toContainText(/imported/i);
  await expect(page.getByLabel("Page title")).toHaveValue("Math Canvas browser round-trip");
  await expect(mathElements(page)).toHaveCount(3);
  await expect(page.locator('[data-element-kind="graph"]')).toHaveCount(1);
  expect(await mathElements(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-element-id")),
  )).toEqual(mathIdsBeforeImport);

  await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles(jsonPath);
  await acceptConfirm(page);
  await expect(page.locator(".v2-notice")).toContainText(/Schema-v3 JSON imported additively/i);
  await expect(page.getByLabel("Page title")).toHaveValue("Math Canvas browser round-trip");
  await expect(mathElements(page)).toHaveCount(3);
  await expect(page.locator('[data-element-kind="graph"]')).toHaveCount(1);

  await expect.poll(() => page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return false;
    const registration = await navigator.serviceWorker.ready;
    return Boolean(registration.active && navigator.serviceWorker.controller);
  })).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await context.setOffline(true);
  try {
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForSaved(page);
    await expect(page.getByLabel("Page title")).toHaveValue("Math Canvas browser round-trip");
    await expect(mathElements(page)).toHaveCount(3);
    await expect(page.locator('[data-element-kind="graph"]')).toHaveCount(1);
    await expect(exactResult(mathElements(page).nth(1))).toHaveAttribute("data-latex", "4");
  } finally {
    await context.setOffline(false);
  }
});

test("ordinary ink stays local while explicit browser Math ink remains safely pending", async ({ page }) => {
  const fetches: Array<{ url: string; method: string; body: string }> = [];
  const consoleMessages: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "fetch" || request.resourceType() === "xhr") {
      fetches.push({ url: request.url(), method: request.method(), body: request.postData() ?? "" });
    }
  });
  page.on("console", (message) => consoleMessages.push(message.text()));
  await gotoMathApp(page);
  await switchToEnglish(page);
  await page.evaluate(() => {
    const target = window as typeof window & { __CANVINK_MATH_TIMER_FIRED__?: number };
    target.__CANVINK_MATH_TIMER_FIRED__ = 0;
    const original = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...arguments_: unknown[]) =>
      original((...callbackArguments: unknown[]) => {
        if (timeout === 900) target.__CANVINK_MATH_TIMER_FIRED__ = (target.__CANVINK_MATH_TIMER_FIRED__ ?? 0) + 1;
        if (typeof handler === "function") handler(...callbackArguments);
        else globalThis.eval(handler);
      }, timeout, ...arguments_)) as typeof window.setTimeout;
  });

  const surface = canvas(page);
  await (await toolbar(page)).getByRole("button", { name: "Pen", exact: true }).click();
  await drawPointerStroke(page, surface, "mouse", [
    { x: 70, y: 100 }, { x: 95, y: 115 }, { x: 125, y: 105 },
  ]);
  await expectInkCount(page, 1);
  await expect(mathElements(page)).toHaveCount(0);

  await (await openToolbarGroup(page, "Insert"))
    .getByRole("button", { name: "Math", exact: true })
    .click();
  await drawPointerStroke(page, surface, "pen", [
    { x: 455, y: 100 }, { x: 480, y: 120 }, { x: 510, y: 92 },
  ]);
  await expect(mathElements(page)).toHaveCount(1);
  const inkMath = mathElements(page).first();
  await expect(inkMath.locator(".math-block")).toHaveAttribute("data-input-kind", "ink");
  await expect(inkMath.locator(".math-block")).toHaveAttribute("data-status", "pending");
  await expect(inkMath.locator(".math-block__ink polyline")).toHaveCount(1);
  await expectInkCount(page, 1);

  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __CANVINK_MATH_TIMER_FIRED__?: number }).__CANVINK_MATH_TIMER_FIRED__ ?? 0,
  )).toBeGreaterThan(0);
  await expect(inkMath.locator(".math-block")).toHaveAttribute("data-status", "pending");
  await inkMath.getByLabel("Automatic recognition for this block").selectOption("disabled");
  await expect(inkMath.getByLabel("Automatic recognition for this block")).toHaveValue("disabled");
  const appOrigin = new URL(page.url()).origin;
  const outboundDataRequests = fetches.filter((request) => (
    new URL(request.url).origin !== appOrigin
    || request.method !== "GET"
    || request.body.length > 0
    || /math_recognize|\/v1\/math\/recognize/i.test(request.url)
  ));
  expect(outboundDataRequests, "No normal or Math ink may leave the browser build").toEqual([]);
  expect(await page.evaluate(() => typeof window.__TAURI_INTERNALS__)).toBe("undefined");
  const observable = `${consoleMessages.join("\n")}\n${fetches.map((request) => `${request.url}\n${request.body}`).join("\n")}`;
  expect(observable).not.toContain('"x":455');
  expect(observable).not.toMatch(/math_recognize|\/v1\/math\/recognize|Authorization|Bearer/i);
});

test("selection-to-Math conversion is lossless and atomic across correction, undo, redo, and reload", async ({ page }) => {
  await gotoMathApp(page);
  await switchToEnglish(page);
  const surface = canvas(page);
  await (await toolbar(page)).getByRole("button", { name: "Pen", exact: true }).click();
  await drawPointerStroke(page, surface, "mouse", [
    { x: 90, y: 320 }, { x: 115, y: 300 }, { x: 145, y: 330 }, { x: 175, y: 305 },
  ]);
  await expectInkCount(page, 1);
  const [{ id: strokeId, localPoints: originalPoints }] = await inkStrokes(page);
  await (await toolbar(page)).getByRole("button", { name: "Select", exact: true }).click();
  const surfaceBox = await surface.boundingBox();
  if (!surfaceBox) throw new Error("The shared canvas has no visible bounds.");
  // A click on the ink itself (a drawn point) selects the stroke.
  await page.mouse.click(surfaceBox.x + 115, surfaceBox.y + 300);
  await expect(page.locator(`.live-canvas-ink-selection[data-element-id="${strokeId}"]`))
    .toHaveClass(/is-selected/);
  const convert = (await openToolbarGroup(page, "Insert"))
    .getByRole("button", { name: "Convert selection to math" });
  await expect(convert).toBeEnabled();
  await convert.click();

  await expectInkCount(page, 0);
  const converted = mathElements(page).first();
  await expect(converted.locator(".math-block")).toHaveAttribute("data-input-kind", "ink");
  await expect(converted.locator(".math-block__ink polyline")).toHaveAttribute("points", originalPoints ?? "");
  const convertedId = await converted.getAttribute("data-element-id");

  await (await toolbar(page)).getByRole("button", { name: "Undo", exact: true }).click();
  await expect(mathElements(page)).toHaveCount(0);
  await expectInkCount(page, 1);
  expect((await inkStrokes(page))[0]).toMatchObject({ id: strokeId, localPoints: originalPoints });

  await (await toolbar(page)).getByRole("button", { name: "Redo", exact: true }).click();
  await expectInkCount(page, 0);
  await expect(mathElements(page)).toHaveCount(1);
  await expect(converted).toHaveAttribute("data-element-id", convertedId ?? "");
  await expect(converted.locator(".math-block__ink polyline")).toHaveAttribute("points", originalPoints ?? "");

  await setMathLatex(converted, "6+6");
  await expect(exactResult(converted)).toHaveAttribute("data-latex", "12");
  await expect(converted.locator(".math-block__ink polyline")).toHaveAttribute("points", originalPoints ?? "");
  await (await toolbar(page)).getByRole("button", { name: "Undo", exact: true }).click();
  await expect(converted.locator(MATH_FIELD)).toHaveAttribute("data-latex", "");
  await expect(converted.locator(".math-block__ink polyline")).toHaveAttribute("points", originalPoints ?? "");
  await (await toolbar(page)).getByRole("button", { name: "Redo", exact: true }).click();
  await expect(converted.locator(MATH_FIELD)).toHaveAttribute("data-latex", "6+6");
  await expect(exactResult(converted)).toHaveAttribute("data-latex", "12");
  await waitForSaved(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  const reopened = mathElements(page).first();
  await expect(reopened).toHaveAttribute("data-element-id", convertedId ?? "");
  await expect(reopened.locator(MATH_FIELD)).toHaveAttribute("data-latex", "6+6");
  await expect(exactResult(reopened)).toHaveAttribute("data-latex", "12");
  await expect(reopened.locator(".math-block__ink polyline")).toHaveAttribute("points", originalPoints ?? "");
});
