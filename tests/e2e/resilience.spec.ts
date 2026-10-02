import type { Page } from "@playwright/test";
import {
  addTextFromRibbon,
  armOneShotIndexedDbWriteFailure,
  contextCommand,
  createQuickNote,
  expect,
  gotoApp,
  installOneShotIndexedDbWriteFailure,
  saveStatus,
  test,
  waitForSaved,
} from "./support";

async function openInsertAndAddText(page: Page): Promise<void> {
  await addTextFromRibbon(page);
}

// Corrupt activation and atomic rollback are covered by schema-v2-activation,
// assets-v2, and security-v2. These checks keep the user-facing resilience
// journeys that remain part of the activated V2 application.

test("one failed local topology save stays visible and an explicit retry succeeds", async ({
  page,
}) => {
  await installOneShotIndexedDbWriteFailure(page);
  await gotoApp(page);
  await createQuickNote(page, {
    title: "Speicherfehler-Prüfung",
    body: "Diese Notiz ist zuerst sicher gespeichert.",
  });
  const canvasToolbar = page.getByRole("region", { name: "Menüband" });
  const canvasViewport = page.getByLabel("Ansicht der Zeichenfläche");
  const toolbarBefore = await canvasToolbar.boundingBox();
  const canvasBefore = await canvasViewport.boundingBox();
  if (!toolbarBefore || !canvasBefore) throw new Error("Canvas layout was not measurable before the save failure.");
  await armOneShotIndexedDbWriteFailure(page);

  const navigation = page.getByRole("navigation", {
    name: "Notizbuchnavigation",
  });
  const row = navigation.locator(".page-row").filter({
    has: page.getByRole("button", { name: /Speicherfehler-Prüfung Frei/ }),
  });
  await contextCommand(page, row.locator(".page-row__target"), "Duplizieren");
  await expect(saveStatus(page)).toHaveAttribute("data-state", "error");
  await expect(saveStatus(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("alert").filter({
    hasText: /injected one IndexedDB write failure|Arbeitsbereichsstruktur wurde abgelehnt/i,
  })).toBeVisible();
  await expect(page.getByLabel("Seitentitel")).toHaveValue(
    "Speicherfehler-Prüfung",
  );
  await saveStatus(page).click();
  await expect(saveStatus(page)).toHaveAttribute("aria-expanded", "true");
  const errorDetails = page.getByRole("region", { name: "Speichern fehlgeschlagen" });
  await expect(errorDetails).toContainText(/injected one IndexedDB write failure|Arbeitsbereichsstruktur wurde abgelehnt/i);
  expect((await canvasToolbar.boundingBox())?.y).toBe(toolbarBefore.y);
  expect((await canvasViewport.boundingBox())?.y).toBe(canvasBefore.y);
  // The status icon toggles its popover; Escape closes it as well.
  await saveStatus(page).click();
  await expect(saveStatus(page)).toHaveAttribute("aria-expanded", "false");
  await expect(errorDetails).toBeHidden();

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(page.getByLabel("Seitentitel")).toHaveValue(
    "Speicherfehler-Prüfung",
  );

  const recoveredNavigation = page.getByRole("navigation", {
    name: "Notizbuchnavigation",
  });
  const recoveredRow = recoveredNavigation.locator(".page-row").filter({
    has: page.getByRole("button", { name: /Speicherfehler-Prüfung Frei/ }),
  });
  await contextCommand(page, recoveredRow.locator(".page-row__target"), "Duplizieren");
  await waitForSaved(page);
  await expect(page.getByLabel("Seitentitel")).toHaveValue(
    "Speicherfehler-Prüfung – Kopie",
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await page
    .getByRole("navigation", { name: "Notizbuchnavigation" })
    .getByRole("button", { name: /Speicherfehler-Prüfung – Kopie Frei/ })
    .click();
  await expect(page.getByLabel("Seitentitel")).toHaveValue(
    "Speicherfehler-Prüfung – Kopie",
  );
  await expect(
    page.getByRole("textbox", { name: "Gemeinsamer Text" }).last(),
  ).toContainText("Diese Notiz ist zuerst sicher gespeichert.");
});

test("offline after load still permits durable local capture", async ({
  context,
  page,
}) => {
  await gotoApp(page);
  await context.setOffline(true);
  try {
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await createQuickNote(page, {
      title: "Offline-Feldnotiz",
      body: "Diese Notiz wurde ohne Netzwerk lokal gespeichert.",
    });
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved");
  } finally {
    await context.setOffline(false);
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Offline-Feldnotiz");
  await expect(
    page.getByRole("textbox", { name: "Gemeinsamer Text" }).last(),
  ).toContainText("Diese Notiz wurde ohne Netzwerk lokal gespeichert.");
});

test("new-page, empty-search, and empty-trash states expose a next action", async ({
  page,
}) => {
  await gotoApp(page);
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.getByRole("button", { name: "Canvas-Seite", exact: true }).click();
  await waitForSaved(page);
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Unbenannte Seite");
  await openInsertAndAddText(page);
  await expect(
    page.getByRole("textbox", { name: "Gemeinsamer Text" }).last(),
  ).toBeFocused();

  const search = page.getByRole("combobox", {
    name: "Arbeitsbereich lokal durchsuchen",
  });
  await search.fill("kein-treffer-7f80f248");
  // With no match there is no list, only the message, and the clear button stays.
  await expect(page.getByRole("region", { name: "Lokale Suche" })).toContainText(
    "Keine lokalen Treffer.",
  );
  await expect(page.getByRole("listbox", { name: "Suchergebnisse" })).toHaveCount(0);
  await page.getByRole("button", { name: "Suche löschen" }).click();
  await expect(search).toHaveValue("");

  await page.getByRole("button", { name: /^Papierkorb/ }).click();
  const trash = page.getByRole("dialog", { name: "Papierkorb" });
  await expect(trash).toBeVisible();
  await expect(
    trash.getByRole("button", { name: "Rollback-Kopie herunterladen" }),
  ).toBeEnabled();
  await trash.getByRole("button", { name: "Papierkorb schliessen" }).click();
  await expect(trash).toBeHidden();
});

test("the accessible canvas label stays concise without truncating note content", async ({
  page,
}) => {
  await gotoApp(page);
  const tail = "ENDE-DARF-NICHT-VERLOREN-GEHEN";
  const body = `${"Langer zugänglicher Notizinhalt. ".repeat(120)}${tail}`;
  const editor = await createQuickNote(page, {
    title: "Zugängliche lange Notiz",
    body,
  });

  const canvas = page.getByRole("application", {
    name: "Gemeinsame Seitenzeichenfläche",
  });
  await expect(canvas).toBeVisible();
  expect((await canvas.getAttribute("aria-label"))?.length).toBeLessThan(80);
  await expect(editor).toContainText(tail);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(
    page.getByRole("textbox", { name: "Gemeinsamer Text" }).last(),
  ).toContainText(tail);
});
