import type { Page } from "@playwright/test";
import {
  contextCommand,
  expect,
  expectInkCount,
  gotoApp,
  inkCount,
  ribbonTab,
  test,
  waitForSaved,
} from "./support";

/** How many ink segments this browser profile holds; a segment appears once drawn ink has been sealed. */
async function segmentCount(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve) => {
    const request = indexedDB.open("canvink-ink-segments");
    request.onerror = () => resolve(0);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("segments")) {
        db.close();
        resolve(0);
        return;
      }
      const keys = db.transaction("segments").objectStore("segments").getAllKeys();
      keys.onsuccess = () => {
        db.close();
        resolve(keys.result.filter((key) => String(key).startsWith("blob:")).length);
      };
      keys.onerror = () => {
        db.close();
        resolve(0);
      };
    };
  }));
}

async function drawStrokes(page: Page, count: number): Promise<void> {
  const draw = await ribbonTab(page, "Zeichnen");
  await draw.getByRole("button", { name: "Stift", exact: true }).click();
  const surface = page.getByLabel("Ansicht der Zeichenfläche");
  const box = (await surface.boundingBox())!;
  for (let index = 0; index < count; index += 1) {
    const y = box.y + 140 + index * 50;
    await page.mouse.move(box.x + 120, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) await page.mouse.move(box.x + 120 + step * 14, y + Math.sin(step) * 8);
    await page.mouse.up();
  }
}

async function newCanvasPage(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.getByRole("button", { name: "Canvas-Seite", exact: true }).click();
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Unbenannte Seite");
  await waitForSaved(page);
}

test("ink drawn on a page is sealed into a segment and survives a reload, also before it was sealed", async ({ page }) => {
  await gotoApp(page);
  await newCanvasPage(page);
  const before = await inkCount(page);
  await drawStrokes(page, 3);
  await expectInkCount(page, before + 3);

  // Reloading as soon as the page reads as saved, before the strokes are sealed: they are still in the
  // journal (written a moment after a stroke), and come back.
  await waitForSaved(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Unbenannte Seite");
  await expectInkCount(page, before + 3);

  // After a rest they are part of a segment, and reload from it.
  await expect.poll(() => segmentCount(page), { timeout: 20_000 }).toBeGreaterThan(0);
  await drawStrokes(page, 2);
  await expectInkCount(page, before + 5);
  await expect.poll(() => segmentCount(page), { timeout: 20_000 }).toBeGreaterThan(1);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectInkCount(page, before + 5);
});

test("undo takes back the last stroke of a page whose earlier ink was sealed", async ({ page }) => {
  await gotoApp(page);
  await newCanvasPage(page);
  const before = await inkCount(page);
  await drawStrokes(page, 3);
  await expect.poll(() => segmentCount(page), { timeout: 20_000 }).toBeGreaterThan(0);
  await drawStrokes(page, 1);
  await expectInkCount(page, before + 4);
  await page.keyboard.press("Control+z");
  await expectInkCount(page, before + 3);
  await page.keyboard.press("Control+Shift+z");
  await expectInkCount(page, before + 4);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expectInkCount(page, before + 2);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectInkCount(page, before + 2);
});

test("a page can be rebuilt in the current ink format: same ink, the old page goes to the trash", async ({ page }) => {
  await gotoApp(page);
  await newCanvasPage(page);
  const before = await inkCount(page);
  await drawStrokes(page, 3);
  await expectInkCount(page, before + 3);
  await expect.poll(() => segmentCount(page), { timeout: 20_000 }).toBeGreaterThan(0);

  const row = page.locator(".page-row__target").filter({ hasText: "Unbenannte Seite" }).first();
  await contextCommand(page, row, "Neu aufbauen (öffnet schneller)");
  // The rebuild ends with the old page in the trash; the copy is checked against it before that.
  await expect(page.getByRole("button", { name: "Papierkorb (1)" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Unbenannte Seite");
  await expectInkCount(page, before + 3);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectInkCount(page, before + 3);
  await expect(page.locator(".page-row__target").filter({ hasText: "Unbenannte Seite" })).toHaveCount(1);
});
