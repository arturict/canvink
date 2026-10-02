import {
  contextCommand,
  createQuickNote,
  expect,
  expectNoDocumentOverflow,
  gotoApp,
  test,
  waitForSaved,
} from "./support";

test("formats, finds, resumes, duplicates, and reorders a working page", async ({
  page,
}) => {
  await gotoApp(page);
  const editor = await createQuickNote(page, {
    title: "Launchplan",
    body: "Recherche und Prototyp",
  });

  await editor.press("Control+A");
  const toolbar = page.getByRole("toolbar", { name: "Text formatieren" });
  await toolbar.getByRole("button", { name: /^Fett/ }).click();
  await toolbar.getByRole("button", { name: /^Kursiv/ }).click();
  await toolbar.getByRole("button", { name: /^Unterstrichen/ }).click();
  await expect(toolbar.getByRole("button", { name: /^Fett/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await waitForSaved(page);

  const search = page.getByRole("combobox", {
    name: "Arbeitsbereich lokal durchsuchen",
  });
  await search.fill("Recherche und Prototyp");
  const results = page.getByRole("listbox", { name: "Suchergebnisse" });
  await expect(
    results.getByRole("option", { name: /Launchplan/ }),
  ).toBeVisible();
  await results.getByRole("option", { name: /Launchplan/ }).click();
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Launchplan");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  const resumed = page
    .getByRole("textbox", { name: "Gemeinsamer Text" })
    .last();
  await expect(resumed).toContainText("Recherche und Prototyp");
  await resumed.focus();
  await resumed.press("Control+A");
  await expect(
    page
      .getByRole("toolbar", { name: "Text formatieren" })
      .getByRole("button", { name: /^Fett/ }),
  ).toHaveAttribute("aria-pressed", "true");

  const navigation = page.getByRole("navigation", {
    name: "Notizbuchnavigation",
  });
  await contextCommand(
    page,
    navigation.locator(".page-row__target").filter({ hasText: "Launchplan" }),
    "Duplizieren",
  );
  await waitForSaved(page);
  await expect(page.getByLabel("Seitentitel")).toHaveValue(
    "Launchplan – Kopie",
  );

  await contextCommand(
    page,
    navigation.locator(".page-row__target").filter({ hasText: "Launchplan – Kopie" }),
    "Nach oben",
  );
  await waitForSaved(page);
  const titles = await navigation
    .locator(".page-row__target > span")
    .evaluateAll((elements) =>
      elements.map((element) => element.textContent?.trim()),
    );
  expect(titles.indexOf("Launchplan – Kopie")).toBeLessThan(
    titles.indexOf("Launchplan"),
  );
  await expectNoDocumentOverflow(page);
});

test.describe("mobile core workflows", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("keeps organization controls usable in the mobile navigation journey", async ({
    page,
  }) => {
    await gotoApp(page);
    const navigation = page.getByRole("navigation", {
      name: "Notizbuchnavigation",
    });
    await navigation
      .getByRole("button", { name: "Navigation schliessen" })
      .click();
    await createQuickNote(page, {
      title: "Mobiler Plan",
      body: "Aufgabe für unterwegs",
    });

    await page.getByRole("button", { name: "Navigation öffnen" }).click();
    // A long press opens the same context menu as a right-click.
    const row = navigation.locator(".page-row__target").filter({ hasText: "Mobiler Plan" });
    const box = await row.boundingBox();
    if (!box) throw new Error("The page row is not visible.");
    const point = { clientX: box.x + 30, clientY: box.y + box.height / 2 };
    await row.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 7, isPrimary: true, ...point });
    const menu = page.getByRole("menu", { name: "Seite Mobiler Plan" });
    await expect(menu).toBeVisible();
    await row.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 7, isPrimary: true, ...point });
    await expect(menu.getByRole("menuitem", { name: "Neue Unterseite" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Duplizieren", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Verschieben oder kopieren…" })).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect((menuBox?.x ?? -1) >= 0 && (menuBox?.x ?? 0) + (menuBox?.width ?? 0) <= 390).toBe(true);
    await menu.getByRole("menuitem", { name: "Verschieben oder kopieren…" }).click();
    const dialog = page.getByRole("dialog", { name: "Seite verschieben oder kopieren" });
    await expect(dialog.getByRole("option", { name: /^Beispiele$/ })).toBeVisible();
    await dialog.getByRole("button", { name: "Abbrechen" }).last().click();
    await expect(dialog).toBeHidden();
  });
});
