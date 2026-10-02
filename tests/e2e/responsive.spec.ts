import {
  createQuickNote,
  expect,
  expectNoDocumentOverflow,
  gotoApp,
  openFileMenu,
  openTopbarMore,
  test,
} from "./support";

test("desktop keeps navigation, capture, assets, and editor inside the viewport", async ({
  page,
}) => {
  await gotoApp(page);

  await expect(
    page.getByRole("navigation", { name: "Notizbuchnavigation" }),
  ).toBeVisible();
  await openTopbarMore(page);
  await expect(page.getByRole("menuitem", { name: "Schnelle Notiz", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "OneNote importieren" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Rollback-Kopie", exact: true }).click({ trial: true });
  await page.getByRole("menuitem", { name: "Diagnose", exact: true }).click({ trial: true });
  await expectNoDocumentOverflow(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Mehr" })).toHaveCount(0);
  await expect(page.getByLabel("Seitentitel")).toBeVisible();
  await openFileMenu(page);
  await expect(page.getByRole("menuitem", { name: "Export", exact: true })).toBeVisible();
  // Inserting is the Einfügen tab's job; the file menu no longer repeats it.
  await expect(page.getByRole("menuitem", { name: "Bild", exact: true })).toHaveCount(0);
  await expectNoDocumentOverflow(page);
});

test("keeps one trash dialog when an open desktop view becomes compact", async ({
  page,
}) => {
  await gotoApp(page);
  await page.getByRole("button", { name: /^Papierkorb/ }).click();
  const trash = page.getByRole("dialog", { name: "Papierkorb" });
  await expect(trash).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => window.matchMedia("(max-width: 820px)").matches),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Navigation schliessen", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);

  await trash.getByRole("button", { name: "Papierkorb schliessen" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test.describe("tablet", () => {
  test.use({ viewport: { width: 900, height: 800 } });

  test("keeps import and export controls reachable outside the canvas scroller", async ({
    page,
  }) => {
    await gotoApp(page);
    await openFileMenu(page);
    await expect(page.getByRole("menuitem", { name: ".canvink importieren", exact: true })).toBeInViewport();
    await expect(page.getByRole("menuitem", { name: "Notizbuch .canvink", exact: true })).toBeInViewport();
    await page.getByRole("menuitem", { name: "Export", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Seite PDF", exact: true })).toBeInViewport();
    await expectNoDocumentOverflow(page);
  });
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2.75,
  });

  test("supports focused capture and explicit navigation without horizontal overflow", async ({
    page,
  }) => {
    await gotoApp(page);
    const navigation = page.getByRole("navigation", {
      name: "Notizbuchnavigation",
    });
    await expect(navigation).toBeVisible();
    await navigation
      .getByRole("button", { name: "Navigation schliessen" })
      .click();
    await expect(navigation).toBeHidden();
    await page.locator(".app-topbar").getByRole("button", { name: "Mehr", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "OneNote importieren" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expectNoDocumentOverflow(page);

    const note = {
      title: "Mobile Erfassung",
      body: "Direkt im fokussierten mobilen Editor erfasst.",
    };
    await createQuickNote(page, note);
    await expectNoDocumentOverflow(page);

    await page.getByRole("button", { name: "Navigation öffnen" }).click();
    await expect(navigation).toBeVisible();
    await expect(
      navigation.locator('.page-row__target[aria-current="page"]'),
    ).toContainText(note.title);
    await navigation
      .getByRole("button", { name: "Navigation schliessen" })
      .click();
    await expect(page.getByLabel("Seitentitel")).toHaveValue(note.title);
    await expect(
      page.getByRole("textbox", { name: "Gemeinsamer Text" }).last(),
    ).toContainText(note.body);
    await expectNoDocumentOverflow(page);
  });

  test("keeps navigation and trash as separate, closable layers", async ({
    page,
  }) => {
    await gotoApp(page);
    const navigation = page.getByRole("navigation", {
      name: "Notizbuchnavigation",
    });
    await navigation.getByRole("button", { name: /^Papierkorb/ }).click();
    const trash = page.getByRole("dialog", { name: "Papierkorb" });
    await expect(trash).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await trash.getByRole("button", { name: "Papierkorb schliessen" }).click();
    await expect(trash).toBeHidden();
    await expect(navigation).toBeVisible();
  });
});

test("the topbar brand is the green Canvink tile, styled by the app itself", async ({ page }) => {
  // The landing page's CSS once supplied this style; with the landing scoped,
  // the app showed a bare book icon until it owned the rule (2026-10-01).
  await gotoApp(page);
  const mark = page.locator(".app-topbar__brand .brand-mark");
  await expect(mark).toBeVisible();
  const style = await mark.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { background: computed.backgroundColor, color: computed.color };
  });
  expect(style.background).toBe("rgb(63, 104, 89)");
  expect(style.color).toBe("rgb(255, 255, 255)");
});
