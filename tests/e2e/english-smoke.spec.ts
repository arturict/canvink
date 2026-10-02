import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import {
  chooseLanguage,
  expect,
  gotoApp,
  openNotebookSwitcher,
  openPageSettings,
  openTopbarMore,
  ribbonTab,
  test,
  waitForSaved,
} from "./support";

// The rest of the suite runs as a German browser (playwright.config.ts). This
// spec is the English counterpart: a browser that reports en-US gets the whole
// UI in English, and no German is left on the screens of the main journeys.
test.use({ locale: "en-US" });

const SHOTS_DIR = process.env.CANVINK_I18N_SHOTS;

// German words that are not also English, plus any German letter.
const GERMAN = /\b(Seite|Seiten|Abschnitt\w*|Notizbuch\w*|Notizbücher|Suchen|Einfügen|Zeichnen|Ansicht|Datei\w*|Schliessen|Öffnen|Abbrechen|Speichern|Löschen|Stift\w*|Farbe|Linien|Hinzufügen|Menüband|Teilen|Verlauf|Mehr|Hilfe|Schnelle|Gemeinsamer|Vollbild|Wiederherstellen|Rückgängig|Umbenennen|Neue[rsn]?|Beispiele|Vorlagen|Willkommen|Besprechung|Ideen|Hier starten|Auswahl|Fehler|Lokal\w*|Arbeitsbereich|und|oder|nicht|wird|für|mit|von)\b|[äöüÄÖÜß]/;

/** Visible text, plus the attributes a screen reader or a tooltip shows. */
async function visibleStrings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found = new Set<string>();
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      const parent = node.parentElement;
      if (text && parent && !["SCRIPT", "STYLE"].includes(parent.tagName) && visible(parent)) found.add(text);
    }
    for (const element of document.body.querySelectorAll("[aria-label],[title],[placeholder],[alt]")) {
      if (!visible(element)) continue;
      for (const attribute of ["aria-label", "title", "placeholder", "alt"]) {
        const value = element.getAttribute(attribute)?.trim();
        if (value) found.add(value);
      }
    }
    return [...found];
  });
}

async function expectNoGerman(page: Page, stage: string): Promise<void> {
  const german = (await visibleStrings(page)).filter((text) => GERMAN.test(text));
  expect(german, `German text left on screen at "${stage}"`).toEqual([]);
  if (SHOTS_DIR) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS_DIR, `${stage.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`) });
  }
}

test("the whole UI is English for an English browser, with no German left", async ({ page }) => {
  await gotoApp(page);
  await waitForSaved(page);

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByLabel("Page title")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Notebook navigation" })).toBeVisible();
  await expectNoGerman(page, "01 workspace");

  for (const [name, tab] of [["Insert", "Einfügen"], ["Draw", "Zeichnen"], ["View", "Ansicht"], ["Home", "Start"]] as const) {
    await ribbonTab(page, tab);
    await expect(page.getByRole("tab", { name, selected: true })).toBeVisible();
    await expectNoGerman(page, `02 ribbon ${name}`);
  }

  // Draw tools and the pen settings.
  await ribbonTab(page, "Zeichnen");
  await page.locator(".pen-style-menu__button").click();
  await expect(page.locator(".pen-style-menu__body")).toBeVisible();
  await expectNoGerman(page, "03 pen settings");
  await page.keyboard.press("Escape");

  await openPageSettings(page);
  await expectNoGerman(page, "04 page settings");
  await page.getByRole("button", { name: "Close page settings" }).click();

  const switcher = await openNotebookSwitcher(page);
  await expectNoGerman(page, "05 notebook switcher");
  await switcher.getByRole("button", { name: "New notebook" }).waitFor();
  await page.keyboard.press("Escape");

  const search = page.getByRole("combobox", { name: "Search workspace locally" });
  await search.fill("note");
  await expectNoGerman(page, "06 search");
  await search.fill("");

  const section = page.getByRole("navigation", { name: "Notebook navigation" }).locator(".section-row > button").first();
  await section.click({ button: "right" });
  await expectNoGerman(page, "07 section menu");
  await page.keyboard.press("Escape");

  await openTopbarMore(page);
  await expectNoGerman(page, "08 more menu");
  await page.getByRole("menuitem", { name: "Import OneNote" }).click();
  await expect(page.getByRole("dialog", { name: /OneNote/ })).toBeVisible();
  await expectNoGerman(page, "09 import");
  await page.getByRole("button", { name: "Close import dialog" }).click();

  await openTopbarMore(page);
  await page.getByRole("menuitem", { name: "History", exact: true }).click();
  await expectNoGerman(page, "10 history");
  await page.keyboard.press("Escape");
});

test("the language switch applies without a reload and the choice survives one", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await page.locator(".app-topbar").getByRole("button", { name: "More", exact: true }).click();
  await chooseLanguage(page, "de");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByLabel("Seitentitel")).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByLabel("Seitentitel")).toBeVisible();
});

test("the desktop sign-in page is English too", async ({ page }) => {
  await page.goto("/desktop-login", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("alert")).toContainText("This link is not valid");
  await expectNoGerman(page, "11 desktop login");
});
