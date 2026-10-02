import type { CDPSession, Page } from "@playwright/test";
import { expect, expectInkCount, gotoApp, inkPixelAt, inkStrokes, ribbonTab, test } from "./support";

/**
 * A Windows 2-in-1 with an active pen (Dell Active Pen and the like) delivers
 * pointer events of type "pen" with pressure, tilt and buttons. Headless
 * Chromium reproduces them through the DevTools protocol, so these tests
 * drive the canvas the way the pen and the palm would.
 */
test.use({ hasTouch: true });

interface Session {
  client: CDPSession;
  view: { x: number; y: number; width: number; height: number };
}

async function openCanvas(page: Page, storage: Record<string, string> = {}): Promise<Session> {
  await page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value);
  }, storage);
  await gotoApp(page);
  await (await ribbonTab(page, "Zeichnen")).getByRole("button", { name: "Stift", exact: true }).click();
  const view = await page.getByLabel("Ansicht der Zeichenfläche").boundingBox();
  if (!view) throw new Error("The canvas view has no bounds.");
  return { client: await page.context().newCDPSession(page), view };
}

type PenPhase = "mousePressed" | "mouseMoved" | "mouseReleased";

function pen(
  { client }: Session,
  type: PenPhase,
  x: number,
  y: number,
  options: { force?: number; buttons?: number; button?: "none" | "left" | "right"; tiltX?: number; tiltY?: number } = {},
) {
  const buttons = options.buttons ?? (type === "mousePressed" ? 1 : 0);
  // A release names the button that lifted; a move names the buttons held down.
  const contact = type === "mouseReleased" || buttons !== 0;
  return client.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    pointerType: "pen",
    button: options.button ?? (contact ? "left" : "none"),
    buttons,
    clickCount: type === "mouseMoved" ? 0 : 1,
    force: options.force ?? (contact ? 0.5 : 0),
    tiltX: options.tiltX ?? 0,
    tiltY: options.tiltY ?? 0,
  });
}

async function penStroke(
  session: Session,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
  force: (progress: number) => number = () => 0.5,
  options: { buttons?: number; button?: "left" | "right" } = {},
) {
  const buttons = options.buttons ?? 1;
  const button = options.button ?? "left";
  await pen(session, "mousePressed", from.x, from.y, { force: force(0), buttons, button });
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    await pen(session, "mouseMoved", from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress, {
      force: force(progress),
      buttons,
      button,
    });
  }
  await pen(session, "mouseReleased", to.x, to.y, { force: 0, buttons: 0, button });
}

function touch(
  { client }: Session,
  type: "touchStart" | "touchMove" | "touchEnd",
  points: Array<{ x: number; y: number; id?: number; radius?: number }>,
) {
  return client.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((point, index) => ({
      x: point.x,
      y: point.y,
      id: point.id ?? index + 1,
      radiusX: point.radius ?? 8,
      radiusY: point.radius ?? 8,
    })),
  });
}

async function fingerDrag(session: Session, from: { x: number; y: number }, to: { x: number; y: number }, radius?: number) {
  await touch(session, "touchStart", [{ ...from, radius }]);
  for (let step = 1; step <= 5; step += 1) {
    await touch(session, "touchMove", [{
      x: from.x + ((to.x - from.x) * step) / 5,
      y: from.y + ((to.y - from.y) * step) / 5,
      radius,
    }]);
  }
  await touch(session, "touchEnd", []);
}

const surface = (page: Page) => page.getByRole("application", { name: "Gemeinsame Seitenzeichenfläche" });

async function surfaceOrigin(page: Page) {
  const box = await surface(page).boundingBox();
  if (!box) throw new Error("The page surface has no bounds.");
  return { x: box.x, y: box.y };
}

/** Painted rows above and below a centre line at one screen column: the line's thickness. */
async function thicknessAt(page: Page, x: number, centreY: number): Promise<number> {
  let rows = 0;
  for (let y = centreY - 20; y <= centreY + 20; y += 1) if (await inkPixelAt(page, { x, y })) rows += 1;
  return rows;
}

test("a pen stroke follows the pressure: thin where light, thicker where firm, and it starts and ends with the pen", async ({ page }) => {
  const session = await openCanvas(page);
  const y = session.view.y + 260;
  const left = session.view.x + 200;
  // Light at both ends, firm in the middle.
  await penStroke(session, { x: left, y }, { x: left + 300, y }, 30, (progress) => 0.08 + 0.85 * Math.sin(progress * Math.PI));
  await expectInkCount(page, 1);
  const [stroke] = await inkStrokes(page);
  expect(stroke.box.x).toBeLessThan(left + 2);
  expect(stroke.box.x + stroke.box.width).toBeGreaterThan(left + 298);
  const light = await thicknessAt(page, left + 12, y);
  const firm = await thicknessAt(page, left + 150, y);
  expect(light).toBeGreaterThan(0);
  expect(firm).toBeGreaterThan(light + 1);
  // The very first sample of the stroke is inked (no gap at the pen-down point).
  expect(await inkPixelAt(page, { x: left + 1, y })).not.toBeNull();
});

test("a fast stroke keeps every sample the digitizer sent", async ({ page }) => {
  const session = await openCanvas(page);
  const y = session.view.y + 300;
  const left = session.view.x + 120;
  const samples = 240;
  await pen(session, "mousePressed", left, y, { force: 0.4 });
  for (let step = 1; step <= samples; step += 1) {
    await pen(session, "mouseMoved", left + step * 3, y + Math.sin(step / 7) * 12, { force: 0.5, buttons: 1, button: "left" });
  }
  await pen(session, "mouseReleased", left + samples * 3, y, { force: 0, buttons: 0 });
  await expectInkCount(page, 1);
  const [stroke] = await inkStrokes(page);
  // Down + every move + up, minus exact duplicates.
  expect(stroke.localPoints.split(" ").length).toBeGreaterThanOrEqual(samples);
});

test("a hovering pen shows a dot and never draws", async ({ page }) => {
  const session = await openCanvas(page);
  const cursor = page.locator(".live-canvas-pen-cursor");
  const y = session.view.y + 240;
  for (let step = 0; step < 30; step += 1) {
    await pen(session, "mouseMoved", session.view.x + 160 + step * 8, y, { buttons: 0, force: 0 });
  }
  await expect(cursor).toBeVisible();
  const box = await cursor.boundingBox();
  if (!box) throw new Error("The pen cursor has no bounds.");
  expect(box.x + box.width / 2).toBeCloseTo(session.view.x + 160 + 29 * 8, 0);
  await expectInkCount(page, 0);
  await expect(page.locator("[data-ink-stroke-count]")).toHaveAttribute("data-ink-stroke-count", "0");
});

/**
 * Chromium's DevTools input cannot press a pen's eraser end (it drops the
 * buttons bit 32), so this one test dispatches the pointer events Windows Ink
 * produces for it: button 5, buttons 32 next to the contact bit.
 */
async function eraserEndStroke(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.evaluate(({ from: start, to: end }) => {
    const target = document.elementFromPoint(start.x, start.y);
    if (!target) throw new Error("Nothing under the eraser end.");
    const fire = (type: string, x: number, y: number, button: number, buttons: number) =>
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 77, pointerType: "pen",
        isPrimary: true, clientX: x, clientY: y, button, buttons, pressure: buttons === 0 ? 0 : 0.5,
      }));
    fire("pointerdown", start.x, start.y, 5, 33);
    for (let step = 1; step <= 8; step += 1) {
      fire("pointermove", start.x + ((end.x - start.x) * step) / 8, start.y + ((end.y - start.y) * step) / 8, -1, 33);
    }
    fire("pointerup", end.x, end.y, 5, 0);
  }, { from, to });
}

test("the eraser end erases while held and the pen writes again afterwards", async ({ page }) => {
  const session = await openCanvas(page);
  const y = session.view.y + 260;
  const left = session.view.x + 200;
  await penStroke(session, { x: left, y }, { x: left + 200, y }, 12);
  await expectInkCount(page, 1);
  await eraserEndStroke(page, { x: left + 100, y: y - 40 }, { x: left + 100, y: y + 40 });
  await expectInkCount(page, 0);
  await penStroke(session, { x: left, y: y + 80 }, { x: left + 200, y: y + 80 }, 12);
  await expectInkCount(page, 1);
});

test("the barrel button erases by default and selects with a lasso when the pen menu says so, without a context menu", async ({ page }) => {
  const session = await openCanvas(page);
  const y = session.view.y + 260;
  const left = session.view.x + 200;
  const barrel = { buttons: 2, button: "right" } as const;
  await penStroke(session, { x: left, y }, { x: left + 200, y }, 12);
  await expectInkCount(page, 1);
  // Windows raises contextmenu for the barrel button; the canvas must not show a menu for it.
  await penStroke(session, { x: left + 100, y: y - 40 }, { x: left + 100, y: y + 40 }, 8, () => 0.5, barrel);
  await expectInkCount(page, 0);
  await expect(page.getByRole("menu")).toHaveCount(0);

  await penStroke(session, { x: left, y }, { x: left + 200, y }, 12);
  await expectInkCount(page, 1);
  await page.getByRole("button", { name: "Farbe und Stärke anpassen" }).click();
  await page.locator('select[data-pen-slot="barrel"]').selectOption("lasso");
  await page.keyboard.press("Escape");
  await pen(session, "mousePressed", left - 30, y - 40, barrel);
  for (const [dx, dy] of [[230, -40], [230, 40], [-30, 40], [-30, -40]]) {
    await pen(session, "mouseMoved", left + dx, y + dy, barrel);
  }
  await pen(session, "mouseReleased", left - 30, y - 40, { buttons: 0, button: "right" });
  // The stroke is selected, not erased.
  await expectInkCount(page, 1);
  await expect(page.locator(".live-canvas-ink-selection").first()).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("palm touches during and right after a pen stroke leave no ink and no pan", async ({ page }) => {
  // Touch drawing is on, so only palm rejection can keep the hand out.
  const session = await openCanvas(page, { "canvink:touch-draws": "true" });
  const before = await surfaceOrigin(page);
  const y = session.view.y + 260;
  const left = session.view.x + 200;

  await pen(session, "mousePressed", left, y, { force: 0.5 });
  await pen(session, "mouseMoved", left + 40, y, { force: 0.5, buttons: 1, button: "left" });
  // The hand rests beside the pen tip while it writes.
  await fingerDrag(session, { x: left + 160, y: y + 120 }, { x: left + 260, y: y + 220 });
  await pen(session, "mouseMoved", left + 80, y, { force: 0.5, buttons: 1, button: "left" });
  await pen(session, "mouseReleased", left + 80, y, { force: 0, buttons: 0 });
  await expectInkCount(page, 1);

  // Straight after pen-up the palm is still coming off the glass.
  await fingerDrag(session, { x: left + 160, y: y + 160 }, { x: left + 300, y: y + 260 });
  await expectInkCount(page, 1);
  const after = await surfaceOrigin(page);
  expect(after).toEqual(before);

  // Well after the grace period a finger draws again, because touch drawing is on.
  await page.waitForTimeout(700);
  await fingerDrag(session, { x: left + 160, y: y + 160 }, { x: left + 300, y: y + 200 });
  await expectInkCount(page, 2);
});

test("a hovering pen keeps fingers out even long after its last contact", async ({ page }) => {
  const session = await openCanvas(page, { "canvink:touch-draws": "true" });
  const y = session.view.y + 300;
  for (let step = 0; step < 10; step += 1) {
    await pen(session, "mouseMoved", session.view.x + 300 + step * 4, y, { buttons: 0, force: 0 });
    await page.waitForTimeout(90);
  }
  await fingerDrag(session, { x: session.view.x + 200, y: y + 100 }, { x: session.view.x + 300, y: y + 150 });
  await expectInkCount(page, 0);
});

test("a large touch contact is a palm and is ignored, a fingertip still draws", async ({ page }) => {
  const session = await openCanvas(page, { "canvink:touch-draws": "true" });
  const before = await surfaceOrigin(page);
  const y = session.view.y + 260;
  const left = session.view.x + 200;
  await fingerDrag(session, { x: left, y }, { x: left + 140, y: y + 60 }, 60);
  await expectInkCount(page, 0);
  expect(await surfaceOrigin(page)).toEqual(before);
  await fingerDrag(session, { x: left, y }, { x: left + 140, y: y + 60 }, 8);
  await expectInkCount(page, 1);
});

test("with touch drawing off a finger pans and never draws", async ({ page }) => {
  const session = await openCanvas(page, { "canvink:touch-draws": "false" });
  const before = await surfaceOrigin(page);
  await fingerDrag(session, { x: session.view.x + 300, y: session.view.y + 400 }, { x: session.view.x + 300, y: session.view.y + 300 });
  await expectInkCount(page, 0);
  const after = await surfaceOrigin(page);
  expect(before.y - after.y).toBeGreaterThan(50);
});

test("once a pen has been seen on the device, fingers pan from the next visit on", async ({ page }) => {
  const session = await openCanvas(page);
  await expect(surface(page)).toHaveAttribute("data-touch-draws", "true");
  await pen(session, "mouseMoved", session.view.x + 300, session.view.y + 300, { buttons: 0, force: 0 });
  await expect(surface(page)).toHaveAttribute("data-touch-draws", "false");
  expect(await page.evaluate(() => window.localStorage.getItem("canvink:pen-seen"))).toBe("true");
  await page.reload();
  await expect(surface(page)).toHaveAttribute("data-touch-draws", "false");
});
