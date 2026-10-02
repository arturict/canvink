import type { CDPSession, Page } from "@playwright/test";
import { expect, expectInkCount, gotoApp, inkStrokes, ribbonTab, test } from "./support";

/**
 * A Windows 2-in-1 with an active pen with two barrel buttons (Dell Active
 * Pen) reports its buttons as pointer-event bits: barrel `buttons & 2`, an
 * extra barrel button as `buttons & 4`, the eraser end as `buttons & 32`.
 * Chromium's DevTools input drops some of those bits, so the events that
 * matter are dispatched as PointerEvents, with the plain tip going through
 * the DevTools protocol like in pen-input.spec.ts.
 */
test.use({ hasTouch: true });

interface Session {
  client: CDPSession;
  view: { x: number; y: number; width: number; height: number };
}

async function openCanvas(page: Page): Promise<Session> {
  // Records what the page puts on the clipboard so the clip can be inspected.
  await page.addInitScript(() => {
    const clips: Blob[] = [];
    (window as unknown as { __clips: Blob[] }).__clips = clips;
    Object.defineProperty(Clipboard.prototype, "write", {
      configurable: true,
      value: async (items: ClipboardItem[]) => {
        clips.push(await items[0].getType("image/png"));
      },
    });
  });
  await gotoApp(page);
  await (await ribbonTab(page, "Zeichnen")).getByRole("button", { name: "Stift", exact: true }).click();
  const view = await page.getByLabel("Ansicht der Zeichenfläche").boundingBox();
  if (!view) throw new Error("The canvas view has no bounds.");
  return { client: await page.context().newCDPSession(page), view };
}

function tip(
  { client }: Session,
  type: "mousePressed" | "mouseMoved" | "mouseReleased",
  x: number,
  y: number,
) {
  return client.send("Input.dispatchMouseEvent", {
    type, x, y, pointerType: "pen",
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: type === "mouseMoved" ? 0 : 1,
    force: type === "mouseReleased" ? 0 : 0.5,
  });
}

async function tipStroke(session: Session, from: { x: number; y: number }, to: { x: number; y: number }) {
  await tip(session, "mousePressed", from.x, from.y);
  for (let step = 1; step <= 10; step += 1) {
    const t = step / 10;
    await tip(session, "mouseMoved", from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
  }
  await tip(session, "mouseReleased", to.x, to.y);
}

type Pt = { x: number; y: number };

/**
 * One pen gesture with the given button bits: pointerdown, moves along the
 * path, pointerup. `contact` adds the tip bit (1); without it the pen hovers
 * while the button is held.
 */
async function buttonGesture(
  page: Page,
  path: Pt[],
  options: { buttons: number; button: number; contact: boolean },
) {
  await page.evaluate(({ path: points, options: o }) => {
    const target = document.elementFromPoint(points[0].x, points[0].y);
    if (!target) throw new Error("Nothing under the pen.");
    const bits = o.buttons | (o.contact ? 1 : 0);
    const fire = (type: string, point: Pt, button: number, held: number) =>
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 91, pointerType: "pen", isPrimary: true,
        clientX: point.x, clientY: point.y, button, buttons: held, pressure: o.contact && held ? 0.5 : 0,
      }));
    fire("pointerdown", points[0], o.button, bits);
    for (const point of points.slice(1)) fire("pointermove", point, -1, bits);
    fire("pointerup", points[points.length - 1], o.button, 0);
  }, { path, options });
}

const BARREL = { buttons: 2, button: 2, contact: true } as const;
const SECOND = { buttons: 4, button: 1, contact: true } as const;
const ERASER_END = { buttons: 32, button: 5, contact: true } as const;

function loop(left: number, top: number, right: number, bottom: number): Pt[] {
  return [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }, { x: left, y: top + 2 },
  ];
}

async function setSlot(page: Page, slot: "barrel" | "secondary" | "eraserEnd", action: string) {
  await page.getByRole("button", { name: "Farbe und Stärke anpassen" }).click();
  await page.locator(`select[data-pen-slot="${slot}"]`).selectOption(action);
  await page.keyboard.press("Escape");
}

test("the barrel button, and the eraser end, erase by default in contact and while hovering, and the pen writes again after", async ({ page }) => {
  const session = await openCanvas(page);
  const y = session.view.y + 260;
  const left = session.view.x + 200;
  const wiper = (x: number): Pt[] => [{ x, y: y - 40 }, { x, y: y - 10 }, { x, y: y + 10 }, { x, y: y + 40 }];

  for (const options of [
    BARREL,
    { ...BARREL, contact: false },
    ERASER_END,
    { ...ERASER_END, contact: false },
  ]) {
    await tipStroke(session, { x: left, y }, { x: left + 200, y });
    await expectInkCount(page, 1);
    await buttonGesture(page, wiper(left + 100), options);
    await expectInkCount(page, 0);
  }
  // Windows raises contextmenu for the barrel button; it must never open a menu for a pen.
  const prevented = await page.evaluate(({ x, y: py }) => {
    const target = document.elementFromPoint(x, py);
    const event = new PointerEvent("contextmenu", {
      bubbles: true, cancelable: true, composed: true, pointerType: "pen", clientX: x, clientY: py, button: 2,
    });
    target?.dispatchEvent(event);
    return event.defaultPrevented;
  }, { x: left + 100, y });
  expect(prevented).toBe(true);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await tipStroke(session, { x: left, y: y + 80 }, { x: left + 200, y: y + 80 });
  await expectInkCount(page, 1);
});

test("button 2 lassos, the selection moves with the pen tip, and the bar copies and deletes it", async ({ page }) => {
  const session = await openCanvas(page);
  const y = session.view.y + 260;
  const left = session.view.x + 200;
  await tipStroke(session, { x: left, y }, { x: left + 120, y });
  await tipStroke(session, { x: left, y: y + 150 }, { x: left + 120, y: y + 150 });
  await expectInkCount(page, 2);

  // Knopf 2 is the lasso by default; the loop circles only the upper stroke.
  await buttonGesture(page, loop(left - 30, y - 40, left + 150, y + 40), SECOND);
  await expectInkCount(page, 2);
  await expect(page.locator(".live-canvas-ink-selection")).toHaveCount(1);
  const bar = page.getByRole("toolbar", { name: "Auswahl" });
  await expect(bar).toBeVisible();

  // The pen tip drags the selection; the other stroke stays put.
  const [first] = (await inkStrokes(page)).sort((a, b) => a.box.y - b.box.y);
  await tipStroke(session, { x: left + 60, y }, { x: left + 60, y: y - 80 });
  await expect.poll(async () => (await inkStrokes(page)).sort((a, b) => a.box.y - b.box.y)[0].box.y)
    .toBeLessThan(first.box.y - 60);
  const strokes = (await inkStrokes(page)).sort((a, b) => a.box.y - b.box.y);
  expect(Math.abs(strokes[1].box.y - (y + 150))).toBeLessThan(6);

  // Kopieren keeps the selection; Löschen removes it.
  await bar.getByRole("button", { name: "Kopieren", exact: true }).click();
  await expect(page.locator(".live-canvas-ink-selection")).toHaveCount(1);
  await bar.getByRole("button", { name: "Löschen" }).click();
  await expectInkCount(page, 1);
  await expect(page.getByRole("toolbar", { name: "Auswahl" })).toHaveCount(0);
});

test("a button mapped to the rectangle selects what the rectangle covers; mapped to nothing it leaves the pen writing", async ({ page }) => {
  const session = await openCanvas(page);
  const y = session.view.y + 260;
  const left = session.view.x + 200;
  await tipStroke(session, { x: left, y }, { x: left + 120, y });
  await tipStroke(session, { x: left, y: y + 150 }, { x: left + 120, y: y + 150 });

  await setSlot(page, "barrel", "rectangleSelect");
  await buttonGesture(page, [{ x: left - 30, y: y - 40 }, { x: left + 160, y: y + 60 }], BARREL);
  await expectInkCount(page, 2);
  await expect(page.locator(".live-canvas-ink-selection")).toHaveCount(1);

  await setSlot(page, "barrel", "none");
  await buttonGesture(page, [{ x: left, y: y + 300 }, { x: left + 100, y: y + 300 }], BARREL);
  await expectInkCount(page, 3);
});

test("a button mapped to Bildausschnitt copies the clip as PNG and can insert it as an image", async ({ page }) => {
  const session = await openCanvas(page);
  const y = session.view.y + 260;
  const left = session.view.x + 200;
  await tipStroke(session, { x: left, y }, { x: left + 120, y });
  await setSlot(page, "secondary", "screenshot");

  await buttonGesture(page, [{ x: left - 20, y: y - 40 }, { x: left + 80, y: y }, { x: left + 150, y: y + 40 }], SECOND);
  const bar = page.getByRole("toolbar", { name: "Bildausschnitt" });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("Bildausschnitt kopiert.");
  await expectInkCount(page, 1);

  // The clipboard got a PNG of the region: white paper with the stroke in it.
  const clip = await page.evaluate(async () => {
    const [blob] = (window as unknown as { __clips: Blob[] }).__clips;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas context.");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let inked = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index] < 200 || data[index + 2] < 200) inked += 1;
    return { type: blob.type, width: bitmap.width, height: bitmap.height, inked };
  });
  expect(clip.type).toBe("image/png");
  expect(clip.width).toBeGreaterThan(300);
  expect(clip.inked).toBeGreaterThan(50);
  expect(clip.inked).toBeLessThan(clip.width * clip.height / 2);

  await bar.getByRole("button", { name: "Als Bild einfügen" }).click();
  await expect(page.locator('.live-canvas-element[data-element-kind="image"]')).toHaveCount(1);
  await expect(page.getByRole("toolbar", { name: "Bildausschnitt" })).toHaveCount(0);
});

test("Knopf testen reports which button the pen fires, hovering or in contact", async ({ page }) => {
  await openCanvas(page);
  await page.getByRole("button", { name: "Farbe und Stärke anpassen" }).click();
  const pad = page.locator('[data-pen-test-pad="true"]');
  const result = pad.locator("output");
  await expect(result).toHaveText("Noch keine Meldung.");
  const send = (type: string, button: number, buttons: number) => pad.evaluate((element, args) => {
    const box = element.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent(args.type, {
      bubbles: true, cancelable: true, pointerId: 5, pointerType: "pen", isPrimary: true,
      clientX: box.x + 20, clientY: box.y + 10, button: args.button, buttons: args.buttons,
    }));
  }, { type, button, buttons });

  await send("pointermove", -1, 2);
  await expect(result).toContainText("Schwebt · Knopf 1 → Radierer");
  await send("pointermove", -1, 4);
  await expect(result).toContainText("Knopf 2 → Lasso");
  await expect(result).toContainText("buttons 4");
  await send("pointerdown", 5, 33);
  await expect(result).toContainText("Kontakt · Radierer-Ende → Radierer");
  await send("pointermove", -1, 0);
  await expect(result).toContainText("kein Knopf");
});
