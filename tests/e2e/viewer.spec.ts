import { expect, inkCount, test } from "./support";
import type { Locator, Page } from "@playwright/test";

/**
 * The phone app (CANVINK_VIEWER=1, src/mobile): its own shell with Start,
 * Notizbücher and Suche, notebook → section → page stacks, back through the
 * history, the reading view of a page, text editing, and never any ink.
 */

async function openApp(page: Page): Promise<void> {
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mobile-home")).toBeVisible({ timeout: 60_000 });
}

/** The screen on top of the visible tab. */
function screen(page: Page): Locator {
  return page.locator('.m-tab[data-active="true"] .m-layer[data-state="top"]');
}

function tab(page: Page, name: "Start" | "Notizbücher" | "Suche"): Locator {
  return page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("button", { name, exact: true });
}

async function openSamplePage(page: Page): Promise<void> {
  await screen(page).getByRole("button", { name: /Hier starten/ }).first().click();
  await expect(page.getByTestId("mobile-page")).toBeVisible();
  await expect(page.getByRole("application", { name: "Gemeinsame Seitenzeichenfläche" })).toBeVisible();
}

test.describe("phone app", () => {
  test("starts on Start with the recent pages and no desktop shell", async ({ page }) => {
    await openApp(page);
    await expect(tab(page, "Start")).toHaveAttribute("aria-current", "page");
    await expect(screen(page).getByRole("heading", { name: "Zuletzt geändert" })).toBeVisible();
    await expect(screen(page).getByTestId("mobile-page-row").first()).toBeVisible();
    await expect(page.locator(".v2-notebook-app")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Zeichnen" })).toHaveCount(0);
  });

  test("walks notebook, section and page and back up with the system back", async ({ page }) => {
    await openApp(page);
    await tab(page, "Notizbücher").click();
    await expect(screen(page).getByRole("heading", { name: "Notizbücher" })).toBeVisible();
    await screen(page).locator(".m-notebook").first().click();
    await expect(screen(page).getByTestId("mobile-notebook")).toBeVisible();
    await screen(page).getByTestId("mobile-section-row").filter({ hasText: "Beispiele" }).click();
    await expect(screen(page).getByTestId("mobile-section")).toBeVisible();
    await screen(page).getByTestId("mobile-page-row").filter({ hasText: "Hier starten" }).click();
    await expect(page.getByTestId("mobile-page")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeHidden();

    await page.goBack();
    await expect(screen(page).getByTestId("mobile-section")).toBeVisible();
    await page.goBack();
    await expect(screen(page).getByTestId("mobile-notebook")).toBeVisible();
    await page.goBack();
    await expect(screen(page).getByTestId("mobile-notebooks")).toBeVisible();
    // Back from another tab's first screen returns to Start.
    await page.goBack();
    await expect(tab(page, "Start")).toHaveAttribute("aria-current", "page");
  });

  test("turns to the next page of the section and shows its position", async ({ page }) => {
    await openApp(page);
    await openSamplePage(page);
    const position = page.getByTestId("mobile-page-position");
    await expect(position).toHaveText(/Seite 1 von 2/);
    await page.getByRole("button", { name: "Nächste Seite" }).click();
    await expect(position).toHaveText(/Seite 2 von 2/);
    await expect(page.getByTestId("mobile-page").getByRole("heading", { level: 1 })).toHaveText("Ideen");
    // Turning pages adds no back step: back returns to Start.
    await page.goBack();
    await expect(page.getByTestId("mobile-home")).toBeVisible();
  });

  test("a pen and a finger write no ink", async ({ page }) => {
    await openApp(page);
    await openSamplePage(page);
    const surface = page.getByRole("application", { name: "Gemeinsame Seitenzeichenfläche" });
    const box = (await page.locator(".m-reader .live-canvas-viewport").boundingBox())!;
    const before = await inkCount(page);
    expect(before).toBeGreaterThan(0);
    await expect(surface).toBeVisible();

    const client = await page.context().newCDPSession(page);
    const y = box.y + box.height * 0.7;
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x + 60, y, button: "left", buttons: 1, pointerType: "pen" } as never);
    for (let step = 1; step <= 10; step += 1) {
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + 60 + step * 14, y: y + step * 3, button: "left", buttons: 1, pointerType: "pen" } as never);
    }
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + 200, y: y + 30, button: "left", pointerType: "pen" } as never);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 60, y: y - 80 }] });
    for (let step = 1; step <= 10; step += 1) {
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + 60 + step * 14, y: y - 80 + step * 3 }] });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    await page.waitForTimeout(800);
    expect(await inkCount(page)).toBe(before);
  });

  test("edits text with the formatting bar and keeps it after a restart", async ({ page }) => {
    await openApp(page);
    await openSamplePage(page);
    const text = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
    await text.click();
    await expect(text).toBeFocused();
    await expect(page.locator(".m-format-bar .canvink-rich-text-toolbar")).toBeVisible();
    await page.keyboard.press("End");
    await page.keyboard.type(" Rechnung 12 mal 7 gleich 84");
    await expect(text).toContainText("gleich 84");
    await page.getByRole("button", { name: "Fertig" }).click();
    await expect(page.locator(".m-format-bar .canvink-rich-text-toolbar")).toHaveCount(0);
    await page.waitForTimeout(1_200);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("mobile-home")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("mobile-continue")).toContainText("Hier starten");
    await page.getByTestId("mobile-continue").click();
    await expect(page.getByTestId("mobile-page").getByText("gleich 84")).toBeVisible();
  });

  test("a finger tap on a text block starts editing at once; a drag over it only pans", async ({ page }) => {
    await openApp(page);
    await openSamplePage(page);
    const reader = page.getByTestId("mobile-page");
    const text = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
    await expect(text).toBeVisible();
    const client = await page.context().newCDPSession(page);
    const touch = async (x: number, y: number, moves: Array<[number, number]> = []) => {
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (const [dx, dy] of moves) {
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx, y: y + dy }] });
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const centre = async () => {
      const box = (await text.boundingBox())!;
      return { x: box.x + Math.min(box.width / 2, 120), y: box.y + Math.min(box.height / 2, 14) };
    };

    // One tap: caret, formatting bar, and the bars stay.
    const spot = await centre();
    await touch(spot.x, spot.y);
    await expect(text).toBeFocused();
    await expect(page.locator(".m-format-bar .canvink-rich-text-toolbar")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(reader).toHaveAttribute("data-chrome", "shown");
    await page.keyboard.type("x");
    await expect(text).toContainText("x");

    // A drag that starts on the text moves the page; it does not start editing.
    await page.getByRole("button", { name: "Fertig" }).click();
    await expect(text).not.toBeFocused();
    const start = await centre();
    await touch(start.x, start.y, [[0, 10], [0, 30], [0, 60]]);
    await page.waitForTimeout(600);
    await expect(text).not.toBeFocused();
    await expect(page.locator(".m-format-bar .canvink-rich-text-toolbar")).toHaveCount(0);
  });

  test("a tap in the empty lower part of a text block edits it too", async ({ page }) => {
    await openApp(page);
    await openSamplePage(page);
    const reader = page.getByTestId("mobile-page");
    const text = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
    await expect(text).toBeVisible();
    // A block taller than its text, as one the person stretched (the frame, not the lines, holds the height).
    const point = await page.evaluate(() => {
      const blocks = document.querySelectorAll<HTMLElement>(".live-canvas-element[data-element-kind='richText']");
      const block = blocks[blocks.length - 1];
      block.style.minHeight = `${block.getBoundingClientRect().height + 80}px`;
      const rect = block.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height - 6, onEditable: Boolean(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height - 6)?.closest("[contenteditable='true']")) };
    });
    expect(point.onEditable).toBe(false);
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(text).toBeFocused();
    await page.waitForTimeout(500);
    await expect(reader).toHaveAttribute("data-chrome", "shown");
  });

  test("a tap on empty paper still hides and shows the bars", async ({ page }) => {
    await openApp(page);
    await openSamplePage(page);
    const reader = page.getByTestId("mobile-page");
    const viewport = (await page.locator(".m-reader .live-canvas-viewport").boundingBox())!;
    const client = await page.context().newCDPSession(page);
    const tapAtBottom = async () => {
      // Empty paper well below the text of the sample page, clear of the pager.
      const point = { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height * 0.5 };
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    await tapAtBottom();
    await expect(reader).toHaveAttribute("data-chrome", "hidden");
    await page.waitForTimeout(400);
    await tapAtBottom();
    await expect(reader).toHaveAttribute("data-chrome", "shown");
  });

  test("pins a page so it shows on Start", async ({ page }) => {
    await openApp(page);
    await openSamplePage(page);
    await page.getByRole("button", { name: "Seite anheften" }).click();
    await expect(page.getByRole("button", { name: "Seite lösen" })).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("mobile-page").getByRole("button", { name: "Zurück" }).click();
    await expect(screen(page).locator(".m-pinned")).toContainText("Hier starten");
  });

  test("searches all notes, marks the words and opens a result", async ({ page }) => {
    await openApp(page);
    await tab(page, "Suche").click();
    const field = page.getByRole("searchbox", { name: "In allen Notizen suchen" });
    await expect(field).toBeFocused();
    await field.fill("Werkzeug");
    const result = page.getByTestId("mobile-search-result").first();
    await expect(result).toContainText("Hier starten", { timeout: 30_000 });
    await expect(result.locator("mark").first()).toHaveText(/Werkzeug/i);
    await result.click();
    await expect(page.getByTestId("mobile-page")).toBeVisible();
    await page.goBack();
    // The search keeps its words, and remembers them.
    await expect(field).toHaveValue("Werkzeug");
    await field.fill("");
    await expect(page.getByRole("heading", { name: "Letzte Suchen" })).toBeVisible();
  });

  test("closes a sheet with back before leaving the page", async ({ page }) => {
    await openApp(page);
    await openSamplePage(page);
    await page.getByRole("button", { name: "Weitere Aktionen" }).click();
    const sheet = page.getByTestId("mobile-page-more").getByRole("dialog");
    await expect(sheet).toBeVisible();
    await page.goBack();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId("mobile-page")).toBeVisible();
  });

  test("hands the Android back gesture to the screen stack, with its predictive progress", async ({ page }) => {
    // The app's native half (MainActivity) stands in as a stub bridge: it
    // records whether the page wants back, and calls __canvinkBack as Android would.
    await page.addInitScript(() => {
      const calls: boolean[] = [];
      (window as Window & { __backCalls?: boolean[] }).__backCalls = calls;
      (window as Window & { CanvinkAndroid?: unknown }).CanvinkAndroid = {
        haptic() {},
        setBackEnabled(enabled: boolean) { calls.push(enabled); },
        insets: () => JSON.stringify({ top: 24, bottom: 16, left: 0, right: 0, keyboard: 0, fontScale: 1 }),
        setSystemBars() {},
        shareText() {},
        shareFile() {},
        ready() {},
        metric() {},
      };
    });
    await openApp(page);
    const backEnabled = () => page.evaluate(() => (window as Window & { __backCalls?: boolean[] }).__backCalls?.at(-1));
    expect(await backEnabled()).toBe(false);
    await openSamplePage(page);
    await expect.poll(backEnabled).toBe(true);
    // The system bar insets reach the shell.
    await expect(page.locator(".m-reader__bar")).toHaveCSS("padding-top", "24px");

    const back = (phase: string, progress: number) => page.evaluate(([name, value]) => {
      (window as Window & { __canvinkBack?: (phase: string, progress: number, edge: number) => void }).__canvinkBack?.(name as string, value as number, 0);
    }, [phase, progress] as const);
    await back("started", 0);
    await back("progress", 0.6);
    const top = page.locator('.m-tab[data-active="true"] .m-layer[data-state="top"]');
    await expect(top).toHaveAttribute("style", /scale\(0\.8\d+\)/);
    // The screen below shows through while the gesture is held.
    await expect(page.locator('.m-tab[data-active="true"] .m-layer[data-state="below-visible"]')).toHaveCount(1);
    await back("cancelled", 0);
    await expect(page.getByTestId("mobile-page")).toBeVisible();
    await back("pressed", 1);
    await expect(page.getByTestId("mobile-page")).toHaveCount(0);
    await expect(page.getByTestId("mobile-home")).toBeVisible();
    await expect.poll(backEnabled).toBe(false);
  });

  test("fits a 360 px wide phone without sideways scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await openApp(page);
    for (const name of ["Start", "Notizbücher", "Suche"] as const) {
      await tab(page, name).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }
  });
});
