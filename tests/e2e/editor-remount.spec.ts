import { drawPenStrokesRightAway, gotoApp, waitForSaved, expect, test } from "./support";

test("strokes drawn right after creating a page all count and the pen stays chosen", async ({ page }) => {
  await gotoApp(page);
  await page.getByRole("button", { name: /^Seite hinzufügen/ }).first().click();
  await drawPenStrokesRightAway(page, 4);
  await waitForSaved(page);
});

test("the chosen pen survives a page switch", async ({ page }) => {
  await gotoApp(page);
  await page.getByRole("button", { name: /^Seite hinzufügen/ }).first().click();
  await drawPenStrokesRightAway(page, 1);
  await page.keyboard.press("Control+PageUp");
  await expect(page.getByLabel("Seitentitel")).not.toHaveValue("Unbenannte Seite");
  await expect(page.getByRole("tabpanel", { name: /^(Zeichnen|Draw)$/ }).getByRole("button", { name: "Stift", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
});
