import { addTextFromRibbon, expect, expectInkCount, gotoApp, inkCount, ribbonTab, test } from "./support";

// Regression: on a page with a text box, every pen stroke after the first was lost.
test("every pen stroke is kept on a page that has a text box", async ({ page }) => {
  await gotoApp(page);
  await addTextFromRibbon(page);
  await page.keyboard.type("Aufgabe 1");
  await page.keyboard.press("Escape");
  const draw = await ribbonTab(page, "Zeichnen");
  await draw.getByRole("button", { name: "Stift", exact: true }).click();
  const surface = page.getByLabel("Ansicht der Zeichenfläche");
  const box = (await surface.boundingBox())!;
  const before = await inkCount(page);
  for (let i = 0; i < 3; i += 1) {
    const y = box.y + 320 + i * 60;
    await page.mouse.move(box.x + 120, y);
    await page.mouse.down();
    for (let s = 1; s <= 12; s += 1) await page.mouse.move(box.x + 120 + s * 15, y + Math.sin(s) * 8);
    await page.mouse.up();
    await expectInkCount(page, before + i + 1);
  }
  await page.waitForTimeout(800);
  await expect.poll(() => inkCount(page)).toBe(before + 3);
});

// Regression: clicking a slash-menu entry with the mouse did nothing.
test("a slash-menu entry runs when clicked with the mouse", async ({ page }) => {
  await gotoApp(page);
  await addTextFromRibbon(page);
  await page.keyboard.type("/");
  const menu = page.getByRole("listbox", { name: "Block einfügen" });
  await expect(menu).toBeVisible();
  await menu.getByRole("option", { name: /Überschrift 1/ }).click();
  await page.keyboard.type("Titel");
  await expect(page.locator(".live-canvas-element h1", { hasText: "Titel" })).toBeVisible();
});
