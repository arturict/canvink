import type { Locator, Page } from "@playwright/test";
import {
  activeNotebookTitle,
  createNotebook,
  expect,
  gotoApp,
  notebookOption,
  openNotebookSwitcher,
  test,
  waitForSaved,
} from "./support";

function navigation(page: Page): Locator {
  return page.getByRole("navigation", { name: "Notizbuchnavigation" });
}

function panel(page: Page): Locator {
  return page.locator(".full-page-nav__panel");
}

function pageRow(page: Page, title: string): Locator {
  return navigation(page).locator(".page-row__target").filter({
    has: page.locator("span", { hasText: new RegExp(`^${title}$`) }),
  });
}

async function enterFullPage(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Vollbild öffnen", exact: true }).click();
  const toolbar = page.getByRole("toolbar", { name: "Zeichenwerkzeuge" });
  await expect(toolbar).toBeVisible();
  return toolbar;
}

async function openNavigation(page: Page): Promise<void> {
  await page.getByRole("toolbar", { name: "Zeichenwerkzeuge" })
    .getByRole("button", { name: "Navigation", exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

async function expectFullPage(page: Page): Promise<void> {
  await expect(page.locator(".v2-notebook-app.is-full-page")).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Zeichenwerkzeuge" })).toBeVisible();
}

const pageTitle = (page: Page) => page.getByLabel("Seitentitel");

test("the navigation panel opens in fullscreen, switches page, section and notebook and closes again", async ({ page }) => {
  await gotoApp(page);
  // A second page and a second notebook to navigate to.
  await page.getByRole("button", { name: /^Seite hinzufügen/ }).first().click();
  await pageTitle(page).fill("Zweite Seite");
  await waitForSaved(page);
  const firstNotebook = await activeNotebookTitle(page).innerText();
  await createNotebook(page);
  await expect(activeNotebookTitle(page)).not.toHaveText(firstNotebook);
  await waitForSaved(page);

  await enterFullPage(page);
  // Closed, the panel does not exist: nothing sits over the canvas.
  await expect(panel(page)).toHaveCount(0);

  await openNavigation(page);
  await expect(page.locator(".v2-notebook-app.is-full-page")).toBeVisible();

  // Notebook: through the same switcher as the title bar; the panel stays open.
  await panel(page).locator(".notebook-switcher__button").click();
  const switcher = await openNotebookSwitcher(page);
  await notebookOption(page, switcher, firstNotebook).click();
  await expect(panel(page).locator(".notebook-switcher__title")).toHaveText(firstNotebook);
  await expect(panel(page)).toBeVisible();
  await expectFullPage(page);

  // Page: navigates, closes the panel and stays in fullscreen.
  await pageRow(page, "Zweite Seite").click();
  await expect(pageTitle(page)).toHaveValue("Zweite Seite");
  await expect(panel(page)).toHaveCount(0);
  await expectFullPage(page);

  // Section: another section opens with its pages, one of them is chosen.
  await openNavigation(page);
  await navigation(page).locator(".section-row > button").nth(1).click();
  await navigation(page).locator(".section-block").nth(1).locator(".page-row__target").first().click();
  await expect(pageTitle(page)).not.toHaveValue("Zweite Seite");
  await expect(panel(page)).toHaveCount(0);
  await expectFullPage(page);
});

test("the panel closes on Escape, on a tap outside and on a swipe back; a further Escape leaves fullscreen", async ({ page }) => {
  await gotoApp(page);
  await enterFullPage(page);

  await openNavigation(page);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expectFullPage(page);

  await openNavigation(page);
  await page.mouse.click(1000, 500);
  await expect(panel(page)).toHaveCount(0);
  await expectFullPage(page);

  await openNavigation(page);
  const box = (await panel(page).boundingBox())!;
  await panel(page).dispatchEvent("pointerdown", {
    pointerId: 7, pointerType: "touch", clientX: box.x + 200, clientY: box.y + 300, isPrimary: true,
  });
  await panel(page).dispatchEvent("pointerup", {
    pointerId: 7, pointerType: "touch", clientX: box.x + 60, clientY: box.y + 310, isPrimary: true,
  });
  await expect(panel(page)).toHaveCount(0);
  await expectFullPage(page);

  await page.keyboard.press("Escape");
  await expect(page.locator(".v2-notebook-app.is-full-page")).toHaveCount(0);
});

test("Ctrl+G, Ctrl+PgUp/PgDn and Ctrl+Tab navigate in fullscreen", async ({ page }) => {
  await gotoApp(page);
  await page.getByRole("button", { name: /^Seite hinzufügen/ }).first().click();
  await pageTitle(page).fill("Zweite Seite");
  await waitForSaved(page);
  await enterFullPage(page);

  // Pages of the section, in order.
  await page.keyboard.press("Control+PageUp");
  await expect(pageTitle(page)).not.toHaveValue("Zweite Seite");
  const before = await pageTitle(page).inputValue();
  await page.keyboard.press("Control+PageDown");
  await expect(pageTitle(page)).toHaveValue("Zweite Seite");
  await page.keyboard.press("Control+PageUp");
  await expect(pageTitle(page)).toHaveValue(before);
  await expectFullPage(page);

  // Next section, then back.
  await page.keyboard.press("Control+Tab");
  await expect(pageTitle(page)).not.toHaveValue(before);
  await page.keyboard.press("Control+Shift+Tab");
  await expect(pageTitle(page)).toHaveValue(before);
  await expectFullPage(page);

  // Ctrl+G opens the panel with the notebook switcher.
  await page.keyboard.press("Control+g");
  await expect(panel(page)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Notizbuch wechseln" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Notizbuch wechseln" })).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expectFullPage(page);
});
