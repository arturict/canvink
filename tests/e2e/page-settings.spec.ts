import type { Locator, Page } from "@playwright/test";
import {
  expect,
  gotoApp,
  openPageSettings,
  ribbonTab,
  test,
  waitForSaved,
} from "./support";

const canvas = (page: Page) =>
  page.getByRole("application", { name: "Gemeinsame Seitenzeichenfläche" });
const paper = (page: Page) => page.getByRole("group", { name: "Papierhintergrund" });
const popover = (page: Page) => page.locator(".page-settings-menu__popover");
const choice = (group: Locator, name: string) => group.getByRole("button", { name, exact: true });

async function reopen(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await openPageSettings(page);
}

test("paper, spacing, colour, page mode and template persist after a reload", async ({ page }) => {
  await gotoApp(page);
  await openPageSettings(page);

  await choice(paper(page), "Liniert").click();
  await expect(canvas(page)).toHaveClass(/live-canvas-surface--lined/);
  await choice(page.getByRole("group", { name: "Abstand" }), "Breit").click();
  await choice(page.getByRole("group", { name: "Linienfarbe" }), "Rot").click();
  await choice(page.getByRole("group", { name: "Linienstärke" }), "Kräftig").click();
  await choice(page.getByRole("group", { name: "Seitenmodus" }), "A4").click();
  await page.getByRole("switch", { name: "Als Vorlage" }).click();
  await expect(page.getByRole("switch", { name: "Als Vorlage" })).toHaveAttribute("aria-checked", "true");
  await waitForSaved(page);

  await reopen(page);
  await expect(choice(paper(page), "Liniert")).toHaveAttribute("aria-pressed", "true");
  await expect(choice(paper(page), "Kariert")).toHaveAttribute("aria-pressed", "false");
  await expect(choice(page.getByRole("group", { name: "Abstand" }), "Breit")).toHaveAttribute("aria-pressed", "true");
  await expect(choice(page.getByRole("group", { name: "Linienfarbe" }), "Rot")).toHaveAttribute("aria-pressed", "true");
  await expect(choice(page.getByRole("group", { name: "Linienstärke" }), "Kräftig")).toHaveAttribute("aria-pressed", "true");
  await expect(choice(page.getByRole("group", { name: "Seitenmodus" }), "A4")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("switch", { name: "Als Vorlage" })).toHaveAttribute("aria-checked", "true");

  // Plain paper has no spacing or colour to set.
  await choice(paper(page), "Leer").click();
  await expect(page.getByRole("group", { name: "Abstand" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Linienfarbe" })).toHaveCount(0);
  await choice(page.getByRole("group", { name: "Seitenmodus" }), "Frei").click();
  await page.getByRole("switch", { name: "Als Vorlage" }).click();
  await waitForSaved(page);

  await reopen(page);
  await expect(choice(paper(page), "Leer")).toHaveAttribute("aria-pressed", "true");
  await expect(choice(page.getByRole("group", { name: "Seitenmodus" }), "Frei")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("switch", { name: "Als Vorlage" })).toHaveAttribute("aria-checked", "false");
});

test("the ribbon's Linien gallery and the panel show the same paper", async ({ page }) => {
  await gotoApp(page);
  await openPageSettings(page);
  await choice(paper(page), "Kariert").click();
  await page.getByRole("button", { name: "Seiteneinstellungen schliessen" }).click();
  const view = await ribbonTab(page, "Ansicht");
  await view.getByRole("button", { name: "Linien", exact: true }).click();
  await expect(page.getByRole("button", { name: "Grosses Raster", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("tags are a chip input: Enter adds, x and Backspace remove, and they persist", async ({ page }) => {
  await gotoApp(page);
  await openPageSettings(page);
  await expect(page.getByText("Noch keine Schlagwörter.")).toHaveCount(0);
  const input = page.getByLabel("Schlagwort hinzufügen");
  await input.fill("Prüfung");
  await input.press("Enter");
  await input.fill("Wichtig");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Schlagwort prufung entfernen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Schlagwort wichtig entfernen" })).toBeVisible();
  await waitForSaved(page);

  await reopen(page);
  await expect(page.getByRole("button", { name: "Schlagwort prufung entfernen" })).toBeVisible();
  await page.getByRole("button", { name: "Schlagwort prufung entfernen" }).click();
  await page.getByLabel("Schlagwort hinzufügen").press("Backspace");
  await expect(page.locator(".chip-input li")).toHaveCount(0);
  await waitForSaved(page);

  await reopen(page);
  await expect(page.locator(".chip-input li")).toHaveCount(0);
});

test("page settings no longer hold move, copy or the parent page", async ({ page }) => {
  await gotoApp(page);
  await openPageSettings(page);
  await expect(page.getByLabel("Ziel zum Verschieben oder Kopieren")).toHaveCount(0);
  await expect(page.getByLabel("Übergeordnete Seite")).toHaveCount(0);
  await expect(popover(page).getByRole("button", { name: /^(Verschieben|Kopieren)$/ })).toHaveCount(0);
  await expect(popover(page).locator("select")).toHaveCount(0);
});

test("the panel fits at 1440x900 without scrolling and opens with the keyboard", async ({ page }) => {
  await gotoApp(page);
  const button = page.getByRole("button", { name: "Seiteneinstellungen", exact: true });
  await button.focus();
  await page.keyboard.press("Enter");
  const panel = popover(page);
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box && box.y + box.height <= 900).toBe(true);
  expect(await panel.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  // Escape closes it again.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the panel is a bottom sheet that fits the screen", async ({ page }) => {
    await gotoApp(page);
    const drawer = page.getByRole("navigation", { name: "Notizbuchnavigation" });
    await drawer.getByRole("button", { name: "Navigation schliessen" }).click();
    await expect(drawer).toBeHidden();
    await page.getByRole("button", { name: "Seiteneinstellungen", exact: true }).click();
    const panel = popover(page);
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    if (!box) throw new Error("The panel has no box.");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(Math.round(box.y + box.height)).toBe(844);
    await choice(paper(page), "Liniert").tap();
    await expect(choice(paper(page), "Liniert")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("touch mode", () => {
  test.use({ hasTouch: true, isMobile: false, viewport: { width: 1280, height: 800 } });

  test("every control in the panel is at least 44 px", async ({ page }) => {
    await gotoApp(page);
    const view = await ribbonTab(page, "Ansicht");
    await view.getByRole("radio", { name: "Ein", exact: true }).click();
    await openPageSettings(page);
    await choice(paper(page), "Liniert").click();
    const boxes = await popover(page)
      .locator("button:not(.page-settings-menu__scrim), input")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { label: node.getAttribute("aria-label") ?? node.textContent ?? "", w: rect.width, h: rect.height };
        }),
      );
    expect(boxes.length).toBeGreaterThan(10);
    for (const box of boxes.filter((entry) => !entry.label.startsWith("Schlagwort "))) {
      expect(box.h, box.label).toBeGreaterThanOrEqual(44);
      expect(box.w, box.label).toBeGreaterThanOrEqual(44);
    }
  });
});
