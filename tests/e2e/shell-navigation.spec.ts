import {
  activeNotebookTitle,
  contextCommand,
  createNotebook,
  expect,
  gotoApp,
  openContextMenu,
  openNotebookSwitcher,
  saveStatus,
  test,
  waitForSaved,
} from "./support";
import type { Page } from "@playwright/test";

function navigation(page: Page) {
  return page.getByRole("navigation", { name: "Notizbuchnavigation" });
}

function sectionButton(page: Page, title: string) {
  return navigation(page).locator(".section-row > button").filter({
    has: page.locator("span", { hasText: new RegExp(`^${title}$`) }),
  });
}

function pageRow(page: Page, title: string) {
  return navigation(page).locator(".page-row__target").filter({
    has: page.locator("span", { hasText: new RegExp(`^${title}$`) }),
  });
}

test("section and page context menus replace the always-visible dots", async ({ page }) => {
  await gotoApp(page);
  await expect(navigation(page).getByLabel(/^Aktionen für/)).toHaveCount(0);

  // Right-click opens the menu at the pointer.
  const examples = sectionButton(page, "Beispiele");
  const box = await examples.boundingBox();
  if (!box) throw new Error("Beispiele is not visible.");
  await examples.click({ button: "right", position: { x: 40, y: 10 } });
  const menu = page.getByRole("menu", { name: "Abschnitt Beispiele" });
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(Math.abs((menuBox?.x ?? 0) - (box.x + 40))).toBeLessThan(3);
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Umbenennen",
    "Abschnittsfarbe",
    "Neuer Abschnitt",
    "Neue Abschnittsgruppe",
    "Verschieben oder kopieren…",
    "Duplizieren",
    "Nach oben",
    "Nach unten",
    "Löschen",
  ]);
  await expect(menu.getByRole("menuitem", { name: "Umbenennen" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Abschnittsfarbe" })).toBeFocused();

  // The colour submenu opens with the right arrow; a colour persists.
  await page.keyboard.press("ArrowRight");
  const colours = page.getByRole("menu", { name: "Abschnittsfarbe" });
  await expect(colours.getByRole("menuitemradio", { name: "Automatisch" })).toHaveAttribute("aria-checked", "true");
  await colours.getByRole("menuitemradio", { name: "Rot" }).click();
  await expect(menu).toBeHidden();
  await waitForSaved(page);
  await expect(examples.locator(".section-color")).toHaveCSS("background-color", "rgb(209, 52, 56)");

  // Shift+F10 on a focused row opens the menu; Escape returns focus to it.
  await examples.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(examples).toBeFocused();

  // The browser menu is only suppressed on navigation rows.
  const suppressedElsewhere = await page.evaluate(() => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 700, clientY: 500 });
    document.querySelector(".page-header__meta")?.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(suppressedElsewhere).toBe(false);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(sectionButton(page, "Beispiele").locator(".section-color")).toHaveCSS("background-color", "rgb(209, 52, 56)");
});

test("pages move with OneNote's move-or-copy dialog, indent and outdent from the menu", async ({ page }) => {
  await gotoApp(page);
  await sectionButton(page, "Beispiele").click();

  await contextCommand(page, pageRow(page, "Ideen"), "Unterseite erstellen");
  await waitForSaved(page);
  await expect(pageRow(page, "Ideen").locator("..")).toHaveCSS("padding-left", "30px");

  const menu = await openContextMenu(page, pageRow(page, "Ideen"));
  await expect(menu.getByRole("menuitem", { name: "Unterseite erstellen" })).toHaveAttribute("aria-disabled", "true");
  await menu.getByRole("menuitem", { name: "Unterseite heraufstufen" }).click();
  await waitForSaved(page);
  await expect(pageRow(page, "Ideen").locator("..")).toHaveCSS("padding-left", "10px");

  await contextCommand(page, pageRow(page, "Ideen"), "Verschieben oder kopieren…");
  const dialog = page.getByRole("dialog", { name: "Seite verschieben oder kopieren" });
  await expect(dialog.getByRole("combobox")).toBeFocused();
  await dialog.getByRole("combobox").fill("notizen");
  await expect(dialog.getByRole("option")).toHaveText(["Notizen"]);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await waitForSaved(page);
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Ideen");
  await expect(sectionButton(page, "Notizen")).toHaveAttribute("aria-current", "true");
  await expect(pageRow(page, "Ideen")).toBeVisible();
});

test("pinned pages stay in quick access and the switcher after a reload", async ({ page }) => {
  await gotoApp(page);
  await sectionButton(page, "Beispiele").click();
  await expect(navigation(page).getByRole("list", { name: "Schnellzugriff" })).toHaveCount(0);

  await contextCommand(page, pageRow(page, "Ideen"), "An Schnellzugriff anheften");
  await waitForSaved(page);
  const quickAccess = navigation(page).getByRole("list", { name: "Schnellzugriff" });
  await expect(quickAccess.getByRole("button", { name: /Ideen/ })).toBeVisible();
  await expect(pageRow(page, "Ideen").getByLabel("angeheftet")).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await sectionButton(page, "Notizen").click();
  await quickAccess.getByRole("button", { name: /Ideen/ }).click();
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Ideen");

  // The page header's pin button shows and toggles the same state.
  const pinButton = page.getByRole("button", { name: "Vom Schnellzugriff lösen" });
  await expect(pinButton).toHaveAttribute("aria-pressed", "true");

  const switcher = await openNotebookSwitcher(page);
  await expect(switcher.getByRole("option", { name: /Ideen/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await contextCommand(page, quickAccess.getByRole("button", { name: /Ideen/ }), "Vom Schnellzugriff lösen");
  await waitForSaved(page);
  await expect(quickAccess).toHaveCount(0);
  await expect(page.getByRole("button", { name: "An Schnellzugriff anheften" })).toHaveAttribute("aria-pressed", "false");

  // Pins can also be removed right in the notebook switcher, by its button or its menu.
  await page.getByRole("button", { name: "An Schnellzugriff anheften" }).click();
  await waitForSaved(page);
  const reopened = await openNotebookSwitcher(page);
  const option = reopened.getByRole("option", { name: /Ideen/ });
  await option.hover();
  await option.getByRole("button", { name: /Vom Schnellzugriff lösen/ }).click();
  await waitForSaved(page);
  await expect(reopened.getByRole("option", { name: /Ideen/ })).toHaveCount(0);
  await expect(reopened).toBeVisible();
});

test("the notebook switcher returns to the last page of each notebook", async ({ page }) => {
  await gotoApp(page);
  await sectionButton(page, "Beispiele").click();
  await pageRow(page, "Ideen").click();
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Ideen");

  await createNotebook(page);
  await waitForSaved(page);
  await expect(activeNotebookTitle(page)).toHaveText("Neues Notizbuch");

  // Ctrl+G opens the switcher with the previous notebook preselected, so
  // Enter switches back, to exactly the page that was open.
  await page.getByLabel("Seitentitel").focus();
  await page.keyboard.press("Control+g");
  const switcher = page.getByRole("dialog", { name: "Notizbuch wechseln" });
  await expect(switcher.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(activeNotebookTitle(page)).toHaveText("Notizbuch");
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Ideen");

  await page.keyboard.press("Control+g");
  await switcher.getByRole("combobox").fill("neu");
  await expect(switcher.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(activeNotebookTitle(page)).toHaveText("Neues Notizbuch");
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Unbenannte Seite");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await page.keyboard.press("Control+g");
  await page.keyboard.press("Enter");
  await expect(activeNotebookTitle(page)).toHaveText("Notizbuch");
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Ideen");
});

test("dragging a page sideways sets its level and collapsing hides subpages", async ({ page }) => {
  await gotoApp(page);
  await sectionButton(page, "Beispiele").click();
  const ideas = pageRow(page, "Ideen");
  const box = await ideas.boundingBox();
  if (!box) throw new Error("Ideen is not visible.");

  // Mid-drag the drop line shows the level the page will take.
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(box.x + 60 + step * 5, box.y + box.height / 2 + 1);
  }
  const indicator = page.locator(".page-pane .page-drop-indicator");
  await expect(indicator).toBeVisible();
  await page.mouse.up();
  await waitForSaved(page);
  await expect(ideas.locator("..")).toHaveCSS("padding-left", "30px");
  await expect(indicator).toHaveCount(0);

  const collapse = navigation(page).getByRole("button", { name: "Unterseiten von Hier starten ausblenden" });
  await collapse.click();
  await expect(ideas).toBeHidden();
  await navigation(page).getByRole("button", { name: "Unterseiten von Hier starten einblenden" }).click();
  await expect(ideas).toBeVisible();

  // Dragging back to the left promotes it again.
  const nested = await ideas.boundingBox();
  if (!nested) throw new Error("Ideen is not visible.");
  await ideas.dragTo(ideas, {
    sourcePosition: { x: 80, y: nested.height / 2 },
    targetPosition: { x: 40, y: nested.height / 2 + 2 },
  });
  await waitForSaved(page);
  await expect(ideas.locator("..")).toHaveCSS("padding-left", "10px");

  // Reordering: drop "Hier starten" below "Ideen" at the same level.
  const start = pageRow(page, "Hier starten");
  const ideasBox = await ideas.boundingBox();
  if (!ideasBox) throw new Error("Ideen is not visible.");
  await start.dragTo(ideas, { targetPosition: { x: 40, y: ideasBox.height - 2 } });
  await waitForSaved(page);
  await expect(navigation(page).locator(".page-pane .page-row__target > span:first-of-type")).toHaveText(["Ideen", "Hier starten"]);
});

test("typing does not change the title bar's status or shift its controls", async ({ page }) => {
  await gotoApp(page);
  const more = page.locator(".app-topbar").getByRole("button", { name: "Mehr", exact: true });
  const before = await more.boundingBox();
  await expect(saveStatus(page)).toHaveText("");
  await page.getByLabel("Seitentitel").click();
  await page.keyboard.type(" – Notizen", { delay: 30 });
  await expect(saveStatus(page)).toHaveAttribute("aria-label", /gespeichert/);
  expect(await more.boundingBox()).toEqual(before);
  await expect(saveStatus(page)).toHaveText("");
  await waitForSaved(page);
  expect(await more.boundingBox()).toEqual(before);
});
