import type { Page } from "@playwright/test";
import {
  addTextFromRibbon,
  expect,
  expectNoDocumentOverflow,
  gotoApp,
  ribbonTab,
  test,
  waitForSaved,
} from "./support";

// A Windows 2-in-1 used as a tablet: a touch screen without the mobile emulation.
test.use({ hasTouch: true, isMobile: false, viewport: { width: 1280, height: 800 } });

const MIN_TARGET = 44;

async function forceTouchMode(page: Page, choice: "Auto" | "Ein" | "Aus"): Promise<void> {
  const view = await ribbonTab(page, "Ansicht");
  await view.getByRole("radio", { name: choice, exact: true }).click();
}

async function touchModeAttribute(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset.touchMode);
}

async function height(locator: ReturnType<Page["locator"]>): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element has no box.");
  return box.height;
}

/** A finger held on a point for longer than the long-press delay. */
async function longPress(page: Page, x: number, y: number): Promise<void> {
  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(700);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("the Touch-Modus choice is automatic by default and can be forced on or off", async ({ page }) => {
  await gotoApp(page);
  const view = await ribbonTab(page, "Ansicht");
  await expect(view.getByRole("radio", { name: "Auto", exact: true })).toHaveAttribute("aria-checked", "true");

  // A finger is the latest pointer, so the automatic mode turns touch mode on.
  await page.getByRole("tab", { name: "Start" }).tap();
  await expect.poll(() => touchModeAttribute(page)).toBe("on");

  // A mouse moving on a machine whose primary pointer is fine turns it off again.
  const primaryCoarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
  if (!primaryCoarse) {
    await page.mouse.move(400, 400);
    await page.mouse.move(420, 410);
    await expect.poll(() => touchModeAttribute(page)).toBe("off");
  }

  await forceTouchMode(page, "Ein");
  await page.mouse.move(600, 500);
  await expect.poll(() => touchModeAttribute(page)).toBe("on");
  await forceTouchMode(page, "Aus");
  await page.getByRole("tab", { name: "Start" }).tap();
  await expect.poll(() => touchModeAttribute(page)).toBe("off");

  // The choice is remembered.
  await forceTouchMode(page, "Ein");
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect.poll(() => touchModeAttribute(page)).toBe("on");
  const again = await ribbonTab(page, "Ansicht");
  await expect(again.getByRole("radio", { name: "Ein", exact: true })).toHaveAttribute("aria-checked", "true");
});

test("touch mode enlarges ribbon buttons, rows and menu rows to at least 44 px", async ({ page }) => {
  await gotoApp(page);
  await forceTouchMode(page, "Aus");
  const start = await ribbonTab(page, "Start");
  const compactButton = await height(start.locator(".ribbon-button").first());
  const compactRow = await height(page.locator(".page-row").first());
  expect(compactButton).toBeLessThan(MIN_TARGET);

  await forceTouchMode(page, "Ein");
  const touchStart = await ribbonTab(page, "Start");
  for (const button of await touchStart.locator(".ribbon-button:visible").all()) {
    expect(await height(button)).toBeGreaterThanOrEqual(MIN_TARGET);
  }
  for (const tab of await page.locator(".ribbon__tab").all()) {
    expect(await height(tab)).toBeGreaterThanOrEqual(MIN_TARGET - 4);
  }
  expect(await height(page.locator(".page-row").first())).toBeGreaterThan(compactRow);
  expect(await height(page.locator(".page-row").first())).toBeGreaterThanOrEqual(MIN_TARGET);
  for (const row of await page.locator(".section-row > button:first-child:visible").all()) {
    expect(await height(row)).toBeGreaterThanOrEqual(MIN_TARGET);
  }
  await expectNoDocumentOverflow(page);
});

test("a long press opens the context menu with large rows", async ({ page }) => {
  await gotoApp(page);
  await forceTouchMode(page, "Ein");
  const row = page.locator(".page-row__target").first();
  const box = await row.boundingBox();
  if (!box) throw new Error("The page row has no box.");
  await longPress(page, box.x + box.width / 2, box.y + box.height / 2);

  const menu = page.getByRole("menu").first();
  await expect(menu).toBeVisible();
  for (const item of await menu.getByRole("menuitem").all()) {
    expect(await height(item)).toBeGreaterThanOrEqual(MIN_TARGET);
  }
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("the browser's own gestures and menus stay out of the app chrome", async ({ page }) => {
  await gotoApp(page);
  await forceTouchMode(page, "Ein");
  const root = page.locator("html");
  await expect(root).toHaveCSS("overscroll-behavior-y", "none");
  await expect(root).toHaveCSS("touch-action", "pan-x pan-y");
  await expect(page.locator(".ribbon")).toHaveCSS("user-select", "none");
  const allowed = await page.evaluate(() => {
    const target = document.querySelector(".ribbon__tab");
    return target?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  expect(allowed).toBe(false);
});

test("a text box stays above the on-screen keyboard", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeKeyboard extends EventTarget {
      overlaysContent = false;
      boundingRect = { x: 0, y: 0, width: 0, height: 0 };
    }
    const keyboard = new FakeKeyboard();
    Object.defineProperty(navigator, "virtualKeyboard", { value: keyboard, configurable: true });
    Object.defineProperty(window, "__openFakeKeyboard", {
      value: (heightPx: number) => {
        keyboard.boundingRect = { x: 0, y: 0, width: window.innerWidth, height: heightPx };
        keyboard.dispatchEvent(new Event("geometrychange"));
      },
    });
  });
  await gotoApp(page);
  await forceTouchMode(page, "Ein");
  await addTextFromRibbon(page);
  const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
  await expect(editor).toBeFocused();
  await expect.poll(() => page.evaluate(() => Reflect.get(navigator, "virtualKeyboard").overlaysContent)).toBe(true);

  // The keyboard covers most of the window, so the text box has to move up.
  const before = await editor.boundingBox();
  await page.evaluate(() => Reflect.get(window, "__openFakeKeyboard")(560));
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.keyboard)).toBe("open");
  const app = page.locator(".notebook-app");
  expect(await height(app)).toBeLessThanOrEqual(800 - 560);
  await expect.poll(async () => {
    const box = await editor.boundingBox();
    return box ? box.y + box.height <= 800 - 560 : false;
  }).toBe(true);
  await expect(page.locator(".ribbon")).toBeVisible();
  const after = await editor.boundingBox();
  expect(before && after && after.y <= before.y).toBe(true);

  await page.evaluate(() => Reflect.get(window, "__openFakeKeyboard")(0));
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.keyboard)).toBe("closed");
  expect(await height(app)).toBe(800);
});

test("portrait and landscape keep the page reachable", async ({ page }) => {
  await gotoApp(page);
  await forceTouchMode(page, "Ein");
  await addTextFromRibbon(page);
  const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
  await editor.fill("Notiz im Hochformat");
  await waitForSaved(page);

  for (const size of [{ width: 800, height: 1280 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(size);
    await expect.poll(() => touchModeAttribute(page)).toBe("on");
    await expectNoDocumentOverflow(page);
    await expect(editor).toBeVisible();
    const box = await editor.boundingBox();
    expect(box).not.toBeNull();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  }
});
