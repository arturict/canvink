import type { Page } from "@playwright/test";
import { acceptConfirm, confirmDialog, contextCommand, expect, gotoApp, inlineRenameField, submitInlineRename, test, waitForSaved } from "./support";

function navigation(page: Page) {
  return page.getByRole("navigation", { name: "Notizbuchnavigation" });
}

function sectionButton(page: Page, title: string) {
  return navigation(page).locator(".section-row > button").filter({
    has: page.locator("span", { hasText: new RegExp(`^${title}$`) }),
  });
}

function groupButton(page: Page, title: string) {
  return navigation(page).locator(".section-group__button").filter({
    has: page.locator("span", { hasText: new RegExp(`^${title}$`) }),
  });
}

/** The list of sections and groups inside a group. */
function groupContents(page: Page, title: string) {
  return navigation(page).getByRole("list", { name: title, exact: true });
}

test("section groups: create, fill by drag and by dialog, fold across reloads, rename, nest and delete", async ({ page }) => {
  await gotoApp(page);

  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.getByRole("button", { name: "Neue Abschnittsgruppe", exact: true }).click();
  // The group appears at once with its default name, ready to be renamed.
  await expect(inlineRenameField(page)).toHaveValue("Neue Abschnittsgruppe");
  await submitInlineRename(page, "Mathematik");
  await waitForSaved(page);
  await expect(groupButton(page, "Mathematik")).toHaveAttribute("aria-expanded", "true");

  // Dropping a section on a group moves it in.
  await sectionButton(page, "Beispiele").dragTo(groupButton(page, "Mathematik"));
  await waitForSaved(page);
  await expect(groupContents(page, "Mathematik").locator(".section-row > button")).toHaveText(["Beispiele"]);

  // "Verschieben oder kopieren…" offers the group as a destination.
  await contextCommand(page, sectionButton(page, "Notizen"), "Verschieben oder kopieren…");
  const dialog = page.getByRole("dialog", { name: "Abschnitt verschieben oder kopieren" });
  await dialog.getByRole("option", { name: "Mathematik", exact: true }).click();
  await dialog.getByRole("button", { name: "Verschieben", exact: true }).click();
  await waitForSaved(page);
  await expect(groupContents(page, "Mathematik").locator(".section-row > button")).toHaveText(["Beispiele", "Notizen"]);
  // At the top level sections come first and groups after them, as in OneNote.
  await expect(navigation(page).locator(".section-list > .section-block .section-row > button")).toHaveText(["Vorlagen"]);

  // Folding persists across a reload while the open section is elsewhere.
  await sectionButton(page, "Vorlagen").click();
  await groupButton(page, "Mathematik").click();
  await expect(groupButton(page, "Mathematik")).toHaveAttribute("aria-expanded", "false");
  await expect(sectionButton(page, "Beispiele")).toBeHidden();
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(groupButton(page, "Mathematik")).toHaveAttribute("aria-expanded", "false");
  await groupButton(page, "Mathematik").click();
  await expect(groupContents(page, "Mathematik").locator(".section-row > button")).toHaveText(["Beispiele", "Notizen"]);

  // Rename and nest from the group's context menu.
  await contextCommand(page, groupButton(page, "Mathematik"), "Umbenennen");
  await submitInlineRename(page, "Mathe");
  await waitForSaved(page);
  await contextCommand(page, groupButton(page, "Mathe"), "Neue Abschnittsgruppe");
  await submitInlineRename(page, "Algebra");
  await waitForSaved(page);
  await expect(groupContents(page, "Mathe").locator(".section-group__button")).toHaveText(["Algebra"]);

  // Deleting a group sends its sections to the trash.
  await contextCommand(page, groupButton(page, "Mathe"), "Löschen");
  await expect(confirmDialog(page).getByRole("heading", { name: "Abschnittsgruppe löschen?" })).toBeVisible();
  expect(await acceptConfirm(page)).toContain("2 Abschnitten");
  await waitForSaved(page);
  await expect(groupButton(page, "Mathe")).toHaveCount(0);
  await expect(groupButton(page, "Algebra")).toHaveCount(0);
  await expect(navigation(page).locator(".section-row > button")).toHaveText(["Vorlagen"]);
  await expect(page.getByRole("button", { name: "Papierkorb (2)" })).toBeVisible();
});

test("arrow keys move through the page list and fold subpages", async ({ page }) => {
  await gotoApp(page);
  await sectionButton(page, "Beispiele").click();
  const rows = navigation(page).locator(".page-pane .page-row__target");
  await contextCommand(page, rows.filter({ hasText: "Ideen" }), "Unterseite erstellen");
  await waitForSaved(page);

  await rows.first().focus();
  await expect(rows.first()).toContainText("Hier starten");
  await page.keyboard.press("ArrowDown");
  await expect(rows.filter({ hasText: "Ideen" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(rows.filter({ hasText: "Ideen" })).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(rows.filter({ hasText: "Ideen" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Ideen");
});
