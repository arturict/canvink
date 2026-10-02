import type { Locator, Page } from "@playwright/test";
import {
  acceptConfirm,
  confirmDialog,
  createNotebook,
  expect,
  gotoApp,
  notebookOption,
  openNotebookSwitcher,
  openTopbarMore,
  test,
  waitForSaved,
} from "./support";

const canvas = (page: Page) =>
  page.getByRole("application", { name: "Gemeinsame Seitenzeichenfläche" });
const settings = (page: Page) => page.getByRole("dialog", { name: "Notizbuch-Einstellungen" });
const choice = (group: Locator, name: string) => group.getByRole("button", { name, exact: true });

async function openFromMore(page: Page): Promise<Locator> {
  await openTopbarMore(page);
  await page.getByRole("menuitem", { name: "Notizbuch-Einstellungen", exact: true }).click();
  const dialog = settings(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function addPage(page: Page): Promise<void> {
  const pages = page.locator(".page-row[data-page-row-id]");
  const before = await pages.count();
  await page.getByRole("button", { name: /^Seite hinzufügen/ }).first().click();
  await expect(pages).toHaveCount(before + 1);
  await waitForSaved(page);
}

test("new pages start with the notebook's paper, and the settings persist after a reload", async ({ page }) => {
  await gotoApp(page);
  let dialog = await openFromMore(page);

  // The notebook's default is what new pages always were: squares.
  const paper = dialog.getByRole("group", { name: "Papierhintergrund" });
  await expect(choice(paper, "Kariert")).toHaveAttribute("aria-pressed", "true");

  await choice(paper, "Liniert").click();
  await choice(dialog.getByRole("group", { name: "Abstand", exact: true }), "Breit").click();
  await choice(dialog.getByRole("group", { name: "Papierfarbe" }), "Creme").click();
  await dialog.getByRole("group", { name: "Seitenformat" }).getByRole("button", { name: "Unendliche Fläche" }).click();
  await waitForSaved(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The page that is open keeps its paper; only the new page follows the defaults.
  await expect(canvas(page)).toHaveClass(/live-canvas-surface--grid/);
  await addPage(page);
  await expect(canvas(page)).toHaveClass(/live-canvas-surface--lined/);
  await expect(canvas(page)).toHaveClass(/live-canvas-surface--free/);

  // Back to squares: the next page is a grid page again.
  dialog = await openFromMore(page);
  await choice(dialog.getByRole("group", { name: "Papierhintergrund" }), "Kariert").click();
  await dialog.getByRole("group", { name: "Seitenformat" }).getByRole("button", { name: "Feste Seite" }).click();
  await waitForSaved(page);
  await page.keyboard.press("Escape");
  await addPage(page);
  await expect(canvas(page)).toHaveClass(/live-canvas-surface--grid/);
  await expect(canvas(page)).toHaveClass(/live-canvas-surface--a4/);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  dialog = await openFromMore(page);
  await expect(choice(dialog.getByRole("group", { name: "Papierhintergrund" }), "Kariert")).toHaveAttribute("aria-pressed", "true");
  await expect(choice(dialog.getByRole("group", { name: "Seitenformat" }), "Feste Seite")).toHaveAttribute("aria-pressed", "true");
  // Switching back to squares reset the spacing to the squares default.
  await expect(choice(dialog.getByRole("group", { name: "Abstand", exact: true }), "Gross")).toHaveAttribute("aria-pressed", "true");
  await expect(choice(dialog.getByRole("group", { name: "Papierfarbe" }), "Creme")).toHaveAttribute("aria-pressed", "true");
});

test("the defaults reach existing pages only through Auf alle Seiten anwenden and its confirmation", async ({ page }) => {
  await gotoApp(page);
  const dialog = await openFromMore(page);
  await choice(dialog.getByRole("group", { name: "Papierhintergrund" }), "Millimeter").click();
  await waitForSaved(page);
  await expect(canvas(page)).toHaveClass(/live-canvas-surface--grid/);

  await dialog.getByRole("button", { name: "Auf alle Seiten anwenden" }).click();
  // Cancelling keeps every page as it is.
  await expect(confirmDialog(page)).toBeVisible();
  await confirmDialog(page).getByRole("button", { name: "Abbrechen" }).click();
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(canvas(page)).toHaveClass(/live-canvas-surface--grid/);

  await dialog.getByRole("button", { name: "Auf alle Seiten anwenden" }).click();
  await acceptConfirm(page);
  await expect(dialog.getByRole("status").filter({ hasText: /Seiten angepasst/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(canvas(page)).toHaveClass(/live-canvas-surface--millimeter/);
});

test("rename, colour and icon are set in the dialog, show in the switcher and persist", async ({ page }) => {
  await gotoApp(page);
  let dialog = await openFromMore(page);

  const name = dialog.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Physik 9b");
  await name.press("Enter");
  await choice(dialog.getByRole("group", { name: "Farbe", exact: true }), "Blau").click();
  await choice(dialog.getByRole("group", { name: "Symbol", exact: true }), "Symbol 🎓").click();
  await expect(dialog.locator(".nb-settings__heading p")).toHaveText("Physik 9b");
  await waitForSaved(page);
  await page.keyboard.press("Escape");

  await expect(page.locator(".notebook-switcher__title")).toHaveText("Physik 9b");
  await expect(page.locator(".notebook-switcher__button .notebook-color--icon")).toHaveText("🎓");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(page.locator(".notebook-switcher__title")).toHaveText("Physik 9b");
  dialog = await openFromMore(page);
  await expect(choice(dialog.getByRole("group", { name: "Farbe", exact: true }), "Blau")).toHaveAttribute("aria-pressed", "true");
  await expect(choice(dialog.getByRole("group", { name: "Symbol", exact: true }), "Symbol 🎓")).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Physik 9b");
});

test("the settings open from the notebook's context menu, from its name and from the More menu", async ({ page }) => {
  await gotoApp(page);
  await createNotebook(page);
  await waitForSaved(page);

  // The context menu of a notebook in the switcher; the dialog is for that notebook, whichever is open.
  const switcher = await openNotebookSwitcher(page);
  const other = notebookOption(page, switcher, "Notizbuch");
  await expect(other).toHaveCount(1);
  await other.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Notizbuch-Einstellungen" }).click();
  let dialog = settings(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".nb-settings__heading p")).toHaveText("Notizbuch");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The notebook's name above the page.
  const open = (await page.locator(".notebook-switcher__title").textContent()) ?? "";
  await page.locator(".page-header__notebook").click();
  dialog = settings(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".nb-settings__heading p")).toHaveText(open);
  await page.getByRole("button", { name: "Notizbuch-Einstellungen schliessen" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".page-header__notebook")).toBeFocused();

  await openFromMore(page);
});

test("Escape closes the dialog, Tab stays inside it and focus returns to the opener", async ({ page }) => {
  await gotoApp(page);
  await openTopbarMore(page);
  const trigger = page.locator(".app-topbar").getByRole("button", { name: "Mehr", exact: true });
  const dialog = await openFromMore(page);
  await expect(dialog).toBeFocused();

  // Tab wraps within the dialog instead of reaching the page behind it.
  for (let step = 0; step < 80; step += 1) {
    await page.keyboard.press("Tab");
    const inside = await dialog.evaluate((element) => element.contains(document.activeElement));
    expect(inside).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  // An unsaved name edit is undone by the first Escape; the second closes the dialog.
  const name = dialog.getByRole("textbox", { name: "Name", exact: true });
  const original = await name.inputValue();
  await name.fill("Nicht übernommen");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(name).toHaveValue(original);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("sorting pages by title is applied in the navigation and takes the move commands away", async ({ page }) => {
  await gotoApp(page);
  // Two pages whose manual order (Zebra, then Apfel) differs from the alphabetical one.
  await addPage(page);
  await page.getByLabel("Seitentitel").fill("Zebra");
  await waitForSaved(page);
  await addPage(page);
  await page.getByLabel("Seitentitel").fill("Apfel");
  await waitForSaved(page);
  const rows = page.locator(".page-row[data-page-row-id] .page-row__title");
  const manual = await rows.allTextContents();
  expect(manual.indexOf("Zebra")).toBeLessThan(manual.indexOf("Apfel"));

  const dialog = await openFromMore(page);
  await choice(dialog.getByRole("group", { name: "Seiten", exact: true }), "Titel").click();
  await waitForSaved(page);
  await page.keyboard.press("Escape");
  const sorted = await rows.allTextContents();
  expect(sorted.indexOf("Apfel")).toBeLessThan(sorted.indexOf("Zebra"));
  expect(sorted).toEqual([...sorted].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })));

  // The user's own order has no visible effect now, so "Nach oben" and "Nach unten" step aside.
  await page.locator(".page-row[data-page-row-id]").filter({ hasText: "Zebra" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Nach oben" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Nach unten" })).toBeDisabled();
  await page.keyboard.press("Escape");

  // Back to manual restores the stored order.
  const again = await openFromMore(page);
  await choice(again.getByRole("group", { name: "Seiten", exact: true }), "Manuell").click();
  await waitForSaved(page);
  await page.keyboard.press("Escape");
  expect(await rows.allTextContents()).toEqual(manual);
});

test("a notebook moves to the trash only after a confirmation, and the last one stays", async ({ page }) => {
  await gotoApp(page);
  let dialog = await openFromMore(page);
  // The only notebook cannot be trashed.
  await expect(dialog.getByRole("button", { name: "In den Papierkorb legen" })).toBeDisabled();
  await page.keyboard.press("Escape");

  await createNotebook(page);
  await waitForSaved(page);
  dialog = await openFromMore(page);
  await dialog.getByRole("button", { name: "In den Papierkorb legen" }).click();
  await expect(confirmDialog(page)).toBeVisible();
  await confirmDialog(page).getByRole("button", { name: "Abbrechen" }).click();
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "In den Papierkorb legen" }).click();
  await acceptConfirm(page);
  await expect(dialog).toHaveCount(0);
  await waitForSaved(page);
  const list = await openNotebookSwitcher(page);
  await expect(list.locator(".notebook-switcher__option:not(.notebook-switcher__option--page)")).toHaveCount(1);
});
