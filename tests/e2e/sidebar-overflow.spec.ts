import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { generateSeed, seedWorkspace } from "./seededWorkspace";
import { expect, test } from "./support";

/**
 * A big imported notebook (21 sections in nested groups, long page lists):
 * the navigation columns scroll inside themselves and their footer never
 * covers an entry.
 */
const seedBase = join(import.meta.dirname, "..", "..", "node_modules", ".cache", "canvink-e2e-sidebar-seed");
let seedDir = seedBase; // set to the generated seed in beforeAll
const shotDir = process.env.CANVINK_SIDEBAR_SHOTS ?? "";

const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "820x1180", width: 820, height: 1180 },
  { name: "700x1350", width: 700, height: 1350 },
  { name: "390x844", width: 390, height: 844 },
];

test.beforeAll(() => {
  seedDir = generateSeed(seedBase, ["--pages", "120", "--strokes", "200", "--images", "0", "--sections", "21", "--groups", "9"]);
});

async function openNavigation(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /Navigation/i }).first();
  if (await page.locator(".notebook-sidebar").first().isVisible().catch(() => false)) return;
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
}

/** The footer and the list rows never overlap: rows are clipped by the scroller above the footer. */
async function expectNoOverlap(page: Page, list: Locator, footer: Locator): Promise<void> {
  const listBox = await list.boundingBox();
  const footerBox = await footer.boundingBox();
  expect(listBox && footerBox).toBeTruthy();
  expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(footerBox!.y + 1);
  const scrolls = await list.evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(scrolls).toBe(true);
  // Scroll to the end: the last row ends above the footer.
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const rows = list.locator("button:visible");
  const last = await rows.last().boundingBox();
  expect(last!.y + last!.height).toBeLessThanOrEqual(footerBox!.y + 1);
}

for (const touch of [false, true]) {
  for (const viewport of viewports) {
    test(`${viewport.name}${touch ? " touch" : ""}: footer never overlaps the lists and the last entries are reachable`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedWorkspace(page, seedDir);
      if (touch) await page.addInitScript(() => localStorage.setItem("canvink:touch-mode", "on"));
      await page.goto("/app");
      await expect(page.getByLabel("Seitentitel")).toBeVisible({ timeout: 60_000 });
      await openNavigation(page);
      const sections = page.locator(".section-list");
      await expect(sections).toBeVisible();
      const footer = page.locator(".notebook-sidebar .sidebar-footer");
      await expectNoOverlap(page, sections, footer);
      if (shotDir) {
        mkdirSync(shotDir, { recursive: true });
        await page.screenshot({ path: join(shotDir, `${viewport.name}${touch ? "-touch" : ""}-sections.png`) });
      }

      // The last section is clickable after scrolling.
      const lastSection = sections.locator(".section-row > button:first-child").last();
      await lastSection.scrollIntoViewIfNeeded();
      const title = (await lastSection.innerText()).split("\n")[0].trim();
      const treeLayout = (await lastSection.getAttribute("aria-expanded")) !== null;
      const expandedBefore = await lastSection.getAttribute("aria-expanded");
      await lastSection.click();
      await openNavigation(page);
      if (treeLayout) {
        // The phone tree folds and unfolds the section and its pages.
        await expect(lastSection).toHaveAttribute("aria-expanded", expandedBefore === "true" ? "false" : "true");
      } else {
        await expect(lastSection.locator("xpath=ancestor::*[contains(@class,'section-block')][1]")).toHaveClass(/is-current/);
      }
      expect(title).toMatch(/^Abschnitt \d+$/);

      const pagePane = page.locator(".page-pane");
      if (await pagePane.isVisible().catch(() => false)) {
        const pageTree = pagePane.locator(".page-tree");
        const treeBox = await pageTree.boundingBox();
        const paneBox = await pagePane.boundingBox();
        expect(treeBox!.y + treeBox!.height).toBeLessThanOrEqual(paneBox!.y + paneBox!.height + 1);
      }
    });
  }
}

test("the section and page column widths resize by keyboard and drag and are remembered", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedWorkspace(page, seedDir);
  await page.goto("/app");
  await expect(page.getByLabel("Seitentitel")).toBeVisible({ timeout: 60_000 });
  const handle = page.getByRole("separator", { name: "Breite der Abschnitte" });
  const pane = page.locator(".nav-pane");
  const before = (await pane.boundingBox())!.width;
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(before + 32);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 4 - 60, box.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(before + 32 - 60);
  await handle.focus();
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "160");
  await page.reload();
  await expect(page.getByLabel("Seitentitel")).toBeVisible({ timeout: 60_000 });
  expect((await pane.boundingBox())!.width).toBe(160);
  await page.getByRole("separator", { name: "Breite der Seiten" }).dblclick();
  await expect(page.getByRole("separator", { name: "Breite der Seiten" })).toHaveAttribute("aria-valuenow", "240");
});
