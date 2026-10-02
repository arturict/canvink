import {
  activeNotebookTitle,
  addTextFromRibbon,
  contextCommand,
  expect,
  notebookOption,
  openNotebookSwitcher,
  gotoApp,
  openTopbarMore,
  submitInlineRename,
  test,
  waitForSaved,
} from "./support";
import type { Page } from "@playwright/test";

async function addText(page: Page): Promise<void> {
  await addTextFromRibbon(page);
}

test("first start leads directly to a durable, searchable local note", async ({
  page,
}) => {
  await gotoApp(page);

  await openTopbarMore(page);
  await page
    .getByRole("menuitem", { name: "Schnelle Notiz", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
  await expect(editor).toBeFocused();
  await editor.fill("Der erste nützliche Gedanke bleibt lokal erhalten.");
  await page.getByLabel("Seitentitel").fill("Erster Wert");
  await waitForSaved(page);

  const element = editor.locator(
    "xpath=ancestor::*[contains(@class, 'live-canvas-element')]",
  );
  await expect(element).toHaveCSS("left", "72px");
  await expect(element).toHaveCSS("top", "72px");
  await expect(element).toHaveCSS("width", "560px");
  await expect(element).toHaveCSS("height", "160px");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Erster Wert");
  await expect(
    page.getByRole("textbox", { name: "Gemeinsamer Text" }).last(),
  ).toContainText("Der erste nützliche Gedanke bleibt lokal erhalten.");

  const search = page.getByRole("combobox", {
    name: "Arbeitsbereich lokal durchsuchen",
  });
  await search.fill("nützliche Gedanke");
  const result = page
    .getByRole("listbox", { name: "Suchergebnisse" })
    .getByRole("option", { name: /Erster Wert/ });
  await expect(result).toBeVisible();
  await result.focus();
  await result.press("Enter");
  await expect(page.getByLabel("Seitentitel")).toBeFocused();
});

test("a note can be organized into a named notebook and section, then found again", async ({
  page,
}) => {
  await gotoApp(page);

  const switcher = await openNotebookSwitcher(page);
  await contextCommand(page, notebookOption(page, switcher, "Notizbuch"), "Umbenennen");
  await submitInlineRename(page, "Produktnotizbuch");
  await waitForSaved(page);
  await expect(activeNotebookTitle(page)).toHaveText("Produktnotizbuch");

  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.getByRole("button", { name: "Neuer Abschnitt", exact: true }).click();
  await waitForSaved(page);
  const newSection = page.locator(".section-block").filter({
    has: page.getByRole("button", { name: "Neuer Abschnitt", exact: true }),
  });
  await contextCommand(page, newSection.locator(".section-row > button"), "Umbenennen");
  await submitInlineRename(page, "Forschung");
  await waitForSaved(page);
  const researchSection = page.locator(".section-block").filter({
    has: page.getByRole("button", { name: "Forschung", exact: true }),
  });
  await expect(researchSection).toBeVisible();
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Unbenannte Seite");
  await addText(page);

  const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
  await expect(editor).toBeFocused();
  await editor.fill("Kundinnen wollen zuerst erfassen und später ordnen.");
  await page.getByLabel("Seitentitel").fill("Interview-Synthese");
  await waitForSaved(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  const navigation = page.getByRole("navigation", {
    name: "Notizbuchnavigation",
  });
  await expect(activeNotebookTitle(page)).toHaveText("Produktnotizbuch");
  await expect(
    navigation.getByRole("button", { name: "Forschung", exact: true }),
  ).toBeVisible();
  const search = page.getByRole("combobox", {
    name: "Arbeitsbereich lokal durchsuchen",
  });
  await search.fill("später ordnen");
  await page
    .getByRole("listbox", { name: "Suchergebnisse" })
    .getByRole("option", { name: /Interview-Synthese/ })
    .click();
  await expect(page.getByLabel("Seitentitel")).toHaveValue(
    "Interview-Synthese",
  );
  await expect(navigation.locator('.page-row__target[aria-current="page"]')).toContainText(
    "Interview-Synthese",
  );
  await expect(
    page.getByRole("textbox", { name: "Gemeinsamer Text" }).last(),
  ).toContainText("Kundinnen wollen zuerst erfassen und später ordnen.");
});

test("the add-text control creates one focused rich-text object and persists it", async ({
  page,
}) => {
  await gotoApp(page);
  const elements = page.locator(".live-canvas-element");
  const before = await elements.count();

  await addText(page);
  await expect(elements).toHaveCount(before + 1);
  const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
  await expect(editor).toBeFocused();
  await editor.fill("Direktes Schreiben auf der Seite.");
  await waitForSaved(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(
    page.getByRole("textbox", { name: "Gemeinsamer Text" }).filter({
      hasText: "Direktes Schreiben auf der Seite.",
    }),
  ).toBeVisible();
});
