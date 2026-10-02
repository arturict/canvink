import type { Page } from "@playwright/test";
import {
  activeNotebookTitle,
  confirmDialog,
  contextCommand,
  expect,
  gotoApp,
  inlineRenameField,
  notebookOption,
  openNotebookSwitcher,
  submitInlineRename,
  test,
  waitForSaved,
} from "./support";

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

function pageRow(page: Page, title: string) {
  return navigation(page).locator(".page-row__target").filter({
    has: page.locator("span", { hasText: new RegExp(`^${title}$`) }),
  });
}

async function reload(page: Page): Promise<void> {
  await waitForSaved(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
}

test("a section is renamed in place: Escape cancels, an empty name reverts, Enter saves and survives a reload", async ({ page }) => {
  await gotoApp(page);
  const notes = sectionButton(page, "Notizen");

  await contextCommand(page, notes, "Umbenennen");
  const field = inlineRenameField(page);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Notizen");
  // The whole name is selected, so typing replaces it.
  expect(await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]))
    .toEqual([0, "Notizen".length]);
  await field.fill("Verworfen");
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(notes).toBeFocused();
  await expect(sectionButton(page, "Verworfen")).toHaveCount(0);

  await contextCommand(page, notes, "Umbenennen");
  await inlineRenameField(page).fill("   ");
  await inlineRenameField(page).press("Enter");
  await expect(inlineRenameField(page)).toHaveCount(0);
  await expect(notes).toBeVisible();

  await contextCommand(page, notes, "Umbenennen");
  await submitInlineRename(page, "Stundenplan");
  await expect(sectionButton(page, "Stundenplan")).toBeFocused();
  await reload(page);
  await expect(sectionButton(page, "Stundenplan")).toBeVisible();
  await expect(sectionButton(page, "Notizen")).toHaveCount(0);
});

test("F2 and a double click rename sections and pages; leaving the field saves", async ({ page }) => {
  await gotoApp(page);
  const section = sectionButton(page, "Beispiele");
  await section.focus();
  await page.keyboard.press("F2");
  await submitInlineRename(page, "Übungen");
  await expect(sectionButton(page, "Übungen")).toBeFocused();
  await sectionButton(page, "Übungen").click();

  const ideas = pageRow(page, "Ideen");
  await ideas.focus();
  await page.keyboard.press("F2");
  await submitInlineRename(page, "Einfälle");
  await expect(pageRow(page, "Einfälle")).toBeFocused();

  await pageRow(page, "Einfälle").focus();
  await page.keyboard.press("F2");
  await inlineRenameField(page).fill("Entwürfe");
  // Clicking elsewhere ends the edit and keeps the name.
  await navigation(page).locator(".sidebar-heading").first().click();
  await expect(inlineRenameField(page)).toHaveCount(0);
  await waitForSaved(page);
  await reload(page);
  await sectionButton(page, "Übungen").click();
  await expect(pageRow(page, "Entwürfe")).toBeVisible();

  // A double click on a section that is not open yet renames it as well.
  await sectionButton(page, "Vorlagen").dblclick();
  await submitInlineRename(page, "Vorlagen 2");
  await reload(page);
  await expect(sectionButton(page, "Vorlagen 2")).toBeVisible();
});

test("a page is renamed from its context menu, Escape keeps the old title", async ({ page }) => {
  await gotoApp(page);
  await sectionButton(page, "Beispiele").click();
  await contextCommand(page, pageRow(page, "Ideen"), "Umbenennen");
  await inlineRenameField(page).fill("Nicht speichern");
  await inlineRenameField(page).press("Escape");
  await expect(pageRow(page, "Ideen")).toBeFocused();

  await contextCommand(page, pageRow(page, "Ideen"), "Umbenennen");
  await submitInlineRename(page, "Ideensammlung");
  await reload(page);
  await sectionButton(page, "Beispiele").click();
  await expect(pageRow(page, "Ideensammlung")).toBeVisible();
});

test("a notebook is renamed in place in the switcher, from the menu and with F2", async ({ page }) => {
  await gotoApp(page);
  const switcher = await openNotebookSwitcher(page);
  await contextCommand(page, notebookOption(page, switcher, "Notizbuch"), "Umbenennen");
  await inlineRenameField(page).fill("Verworfen");
  await inlineRenameField(page).press("Escape");
  // Escape ends the rename only; the switcher stays open.
  await expect(switcher).toBeVisible();
  await expect(notebookOption(page, switcher, "Notizbuch")).toBeVisible();

  await contextCommand(page, notebookOption(page, switcher, "Notizbuch"), "Umbenennen");
  await submitInlineRename(page, "Schule");
  await waitForSaved(page);
  await expect(activeNotebookTitle(page)).toHaveText("Schule");

  await contextCommand(page, notebookOption(page, switcher, "Schule"), "Umbenennen");
  await submitInlineRename(page, "Schule 2027");
  await waitForSaved(page);
  await expect(switcher).toBeVisible();
  await reload(page);
  await expect(activeNotebookTitle(page)).toHaveText("Schule 2027");

  await openNotebookSwitcher(page);
  await page.getByRole("combobox", { name: "Suchen", exact: true }).press("F2");
  await submitInlineRename(page, "Schule 2028");
  await waitForSaved(page);
  await expect(activeNotebookTitle(page)).toHaveText("Schule 2028");
});

test("a new section group is named in place; deleting one asks in an alert dialog", async ({ page }) => {
  await gotoApp(page);
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.getByRole("button", { name: "Neue Abschnittsgruppe", exact: true }).click();
  await expect(inlineRenameField(page)).toHaveValue("Neue Abschnittsgruppe");
  // Escape keeps the default name, like a new section in OneNote.
  await inlineRenameField(page).press("Escape");
  await waitForSaved(page);
  await expect(groupButton(page, "Neue Abschnittsgruppe")).toBeFocused();

  await groupButton(page, "Neue Abschnittsgruppe").dblclick();
  await submitInlineRename(page, "Fächer");
  await reload(page);
  await expect(groupButton(page, "Fächer")).toBeVisible();

  // A group that holds sections asks before it goes to the trash.
  await sectionButton(page, "Notizen").dragTo(groupButton(page, "Fächer"));
  await waitForSaved(page);
  await contextCommand(page, groupButton(page, "Fächer"), "Löschen");
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Abschnittsgruppe löschen?" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Abbrechen" })).toBeFocused();
  // Focus stays inside the dialog.
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Löschen" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Abbrechen" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(groupButton(page, "Fächer")).toBeVisible();

  await contextCommand(page, groupButton(page, "Fächer"), "Löschen");
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(groupButton(page, "Fächer")).toBeVisible();

  await contextCommand(page, groupButton(page, "Fächer"), "Löschen");
  await dialog.getByRole("button", { name: "Löschen" }).click();
  await waitForSaved(page);
  await expect(groupButton(page, "Fächer")).toHaveCount(0);
});
