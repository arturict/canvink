import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { generateSeed, seedWorkspace } from "./seededWorkspace";
import { expect, test } from "./support";

/**
 * The search surface on a synthetic school workspace: the notebook "Schule
 * 2026/27" with one coloured section per subject and two more notebooks that
 * share the title "Notizbuch".
 */
const seedBase = join(tmpdir(), "canvink-e2e-search-surface-seed");
let seedDir = seedBase;

const SEARCH_LABEL = "Arbeitsbereich lokal durchsuchen";

async function openApp(page: Page): Promise<void> {
  await seedWorkspace(page, seedDir);
  await page.goto("/app");
  await expect(page.getByLabel("Seitentitel")).toBeVisible({ timeout: 120_000 });
  // A phone-sized window opens with the navigation drawer; the specs run at desktop size.
  await expect(page.getByRole("combobox", { name: SEARCH_LABEL })).toBeVisible();
}

test.describe("search surface", () => {
  test.setTimeout(240_000);

  test.beforeAll(() => {
    test.setTimeout(240_000);
    seedDir = generateSeed(seedBase, ["--school", "1", "--extra-notebook-titles", "Notizbuch,Notizbuch,Projekte"]);
  });

  test("opens with Ctrl+K, answers with grouped results and opens a page from the keyboard", async ({ page }) => {
    await openApp(page);
    const search = page.getByRole("combobox", { name: SEARCH_LABEL });
    const region = page.getByRole("region", { name: "Lokale Suche" });

    await page.keyboard.press("Control+k");
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute("aria-expanded", "true");
    // One surface: scope shortcuts and filter chips, no form controls and no maintenance buttons.
    await expect(region.getByRole("radiogroup", { name: "Suchbereich" }).getByRole("radio")).toHaveCount(4);
    for (const chip of ["Notizbuch", "Abschnitt", "Schlagwörter", "Aufgaben", "Quelle"]) {
      await expect(region.getByRole("button", { name: chip, exact: true })).toBeVisible();
    }
    await expect(region.locator("select")).toHaveCount(0);
    await expect(region.getByRole("button", { name: "Index neu aufbauen" })).toHaveCount(0);

    await search.fill("Physik");
    const results = page.getByRole("listbox", { name: "Suchergebnisse" });
    await expect(results.getByRole("option")).toHaveCount(6);
    // Results sit under the notebook and section they belong to.
    await expect(results.getByRole("group", { name: /Schule 2026\/27.*Physik/ })).toBeVisible();
    await expect(results.locator("mark").first()).toHaveText(/physik/i);

    await search.press("ArrowDown");
    await expect(search).toHaveAttribute("aria-activedescendant", /.+/);
    await expect(results.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
    await search.press("Enter");
    await expect(page.getByLabel("Seitentitel")).toHaveValue(/^Physik – /);
    await expect(results).toHaveCount(0);

    // The empty search offers the page just left and the search just made.
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("listbox", { name: "Letzte Suchen und Seiten" }).getByRole("option", { name: "Physik", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toHaveAttribute("aria-expanded", "false");
  });

  test("narrows by section chips, scope shortcuts and the other filter menus", async ({ page }) => {
    await openApp(page);
    const search = page.getByRole("combobox", { name: SEARCH_LABEL });
    const region = page.getByRole("region", { name: "Lokale Suche" });
    const results = page.getByRole("listbox", { name: "Suchergebnisse" });

    await search.fill("Praktikum");
    await expect(results.getByRole("option", { name: /Praktikum Pendel/ })).toBeVisible();
    await expect(results.getByRole("option", { name: /Praktikum Titration/ })).toBeVisible();

    // Hierarchical, type-to-filter section picker with checkboxes.
    await region.getByRole("button", { name: "Abschnitt", exact: true }).click();
    const picker = page.getByRole("combobox", { name: "Abschnitt filtern" });
    await expect(picker).toBeFocused();
    await expect(page.getByRole("tree", { name: "Abschnitt filtern" }).getByRole("treeitem", { name: /Schule 2026\/27/ })).toBeVisible();
    await picker.fill("physik");
    await expect(page.getByRole("treeitem", { name: /Chemie/ })).toHaveCount(0);
    await picker.press("ArrowDown");
    await picker.press("Enter");
    await expect(page.getByRole("treeitem", { name: /Physik/ })).toHaveAttribute("aria-selected", "true");
    await picker.press("Escape");
    await expect(picker).toHaveCount(0);

    // The choice shows as a removable chip and cuts the results.
    await expect(results.getByRole("option", { name: /Praktikum Pendel/ })).toBeVisible();
    await expect(results.getByRole("option", { name: /Praktikum Titration/ })).toHaveCount(0);
    await region.getByRole("button", { name: "Filter Physik entfernen" }).click();
    await expect(results.getByRole("option", { name: /Praktikum Titration/ })).toBeVisible();

    // Two notebooks share a title; the picker tells them apart.
    await region.getByRole("button", { name: "Notizbuch", exact: true }).click();
    const notebooks = page.getByRole("listbox", { name: "Notizbuch filtern" }).getByRole("option", { name: /^Notizbuch/ });
    await expect(notebooks).toHaveCount(2);
    const names = await notebooks.allInnerTexts();
    expect(new Set(names).size).toBe(2);
    await page.keyboard.press("Escape");

    // Scope shortcuts follow the page that is open (section "Analysis").
    await region.getByRole("radio", { name: "Dieser Abschnitt" }).click();
    await expect(region.getByRole("radio", { name: "Dieser Abschnitt" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Keine lokalen Treffer.")).toBeVisible();
    await region.getByRole("radio", { name: "Alle", exact: true }).click();
    await expect(results.getByRole("option", { name: /Praktikum Pendel/ })).toBeVisible();

    // The short lists use the shared menu: one radio row per choice.
    await region.getByRole("button", { name: "Quelle", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "PDF-Text" }).click();
    await expect(region.getByRole("button", { name: "Quelle: PDF-Text" })).toBeVisible();
    await expect(page.getByText("Keine lokalen Treffer.")).toBeVisible();
    await region.getByRole("button", { name: "Alle Filter entfernen" }).click();
    await expect(results.getByRole("option", { name: /Praktikum Pendel/ })).toBeVisible();
  });

  test("keeps maintenance in the more menu and shows the index only while it works", async ({ page }) => {
    await openApp(page);
    const search = page.getByRole("combobox", { name: SEARCH_LABEL });
    const region = page.getByRole("region", { name: "Lokale Suche" });

    await search.click();
    await expect(region.getByText(/Index wird aufgebaut/)).toHaveCount(0);
    await region.getByRole("button", { name: "Weitere Suchaktionen" }).click();
    await expect(page.getByRole("menuitem", { name: "Lokale OCR" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Index neu aufbauen" }).click();
    // The surface stays open while the shared menu closes and the index is rebuilt.
    await expect(search).toHaveAttribute("aria-expanded", "true");
    await expect(region.getByRole("status")).toContainText("Suchindex wurde neu aufgebaut", { timeout: 30_000 });

    // The "tasks" review is a link on the empty search.
    await expect(region.getByRole("button", { name: "Alle Aufgaben anzeigen" })).toBeVisible();
  });
});
