import {
  createQuickNote,
  expect,
  gotoApp,
  openPageSettings,
  test,
  waitForAutosave,
  waitForSaved,
} from "./support";

const SEARCH_LABEL = "Arbeitsbereich lokal durchsuchen";

test("marks a page with tags and a task state, then reviews and finds it again", async ({
  page,
}) => {
  await gotoApp(page);
  // An unmarked page first, so the operators below have something to exclude.
  await createQuickNote(page, {
    title: "Nur eine Notiz",
    body: "Diese Seite ist keine Aufgabe.",
  });
  await createQuickNote(page, {
    title: "Impuls Hausaufgabe",
    body: "Zwei Wagen stossen zusammen.",
  });

  await openPageSettings(page);
  await page.getByRole("group", { name: "Aufgabenstatus" }).getByRole("button", { name: "Offen" }).click();
  const tagInput = page.getByLabel("Schlagwort hinzufügen");
  await tagInput.fill("  Prüfung ");
  await tagInput.press("Enter");
  // The stored tag is the normalized slug, not the typed text.
  await expect(
    page.getByRole("button", { name: "Schlagwort prufung entfernen" }),
  ).toBeVisible();
  await expect(tagInput).toHaveValue("");
  await waitForAutosave(page);
  await page.getByRole("button", { name: "Seiteneinstellungen schliessen" }).click();

  const search = page.getByRole("combobox", { name: SEARCH_LABEL });
  await search.fill("is:open");
  const results = page.getByRole("listbox", { name: "Suchergebnisse" });
  await expect(
    results.getByRole("option", { name: /Impuls Hausaufgabe/ }),
  ).toBeVisible();
  await expect(
    results.getByRole("option", { name: /Nur eine Notiz/ }),
  ).toHaveCount(0);

  await search.fill("tag:prüfung");
  await expect(
    results.getByRole("option", { name: /Impuls Hausaufgabe/ }),
  ).toBeVisible();

  await search.fill("is:done");
  await expect(results.getByRole("option")).toHaveCount(0);

  await search.fill("");
  // The task review is a link on the empty search, not a maintenance button.
  await search.click();
  await page.getByRole("button", { name: "Alle Aufgaben anzeigen" }).click();
  const review = page.locator(".search-panel__tasks");
  await expect(review.getByRole("option", { name: /Impuls Hausaufgabe/ })).toBeVisible();
  await expect(review.getByRole("option", { name: /Nur eine Notiz/ })).toHaveCount(0);

  await review.getByRole("option", { name: /Impuls Hausaufgabe/ }).click();
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Impuls Hausaufgabe");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await openPageSettings(page);
  await expect(
    page.getByRole("group", { name: "Aufgabenstatus" }).getByRole("button", { name: "Offen" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Schlagwort prufung entfernen" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Schlagwort prufung entfernen" }).click();
  await expect(
    page.getByRole("button", { name: "Schlagwort prufung entfernen" }),
  ).toHaveCount(0);
  await page.getByRole("group", { name: "Aufgabenstatus" }).getByRole("button", { name: "Keine" }).click();
  await waitForAutosave(page);

  await page.getByRole("combobox", { name: SEARCH_LABEL }).fill("is:open");
  await expect(
    page.getByRole("listbox", { name: "Suchergebnisse" }).getByRole("option"),
  ).toHaveCount(0);
});
