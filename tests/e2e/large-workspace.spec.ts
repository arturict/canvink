import type { Page } from "@playwright/test";
import { seedWorkspace, shownStrokeCount, type SeedPage } from "./seededWorkspace";
import { expect, test } from "./support";

/**
 * Opens a workspace of a large synthetic notebook (400 pages,
 * about 200,000 strokes and 2 million ink points, 1,000 images), which did not
 * fit into memory while every page was loaded at once, and navigates through
 * it. The seed is generated once (a few minutes) and passed in:
 *
 *   pnpm exec vite build --config scripts/bench/vite.seed.config.mjs
 *   node node_modules/.cache/canvink-bench/seed-workspace.js --out /tmp/canvink-bm-seed
 *   CANVINK_LARGE_SEED=/tmp/canvink-bm-seed pnpm exec playwright test tests/e2e/large-workspace.spec.ts
 */
const seedDir = process.env.CANVINK_LARGE_SEED;

async function expectPageShown(page: Page, info: SeedPage, timeout = 120_000): Promise<void> {
  await expect(page.getByLabel("Seitentitel")).toHaveValue(info.title, { timeout });
  await expect.poll(() => shownStrokeCount(page), { timeout: 120_000 }).toBeGreaterThanOrEqual(info.strokes);
}

test.describe("large workspace", () => {
  test.skip(!seedDir, "Set CANVINK_LARGE_SEED to a generated bm-size seed (see the file comment).");
  test.setTimeout(900_000);

  test("opens a bm-size workspace, navigates it and finds a page that was never opened", async ({ page }) => {
    await page.addInitScript(() => {
      const memories: WebAssembly.Memory[] = [];
      (window as unknown as { __wasmMemories: WebAssembly.Memory[] }).__wasmMemories = memories;
      const remember = <T>(result: T): T => {
        const instance = (result as { instance?: WebAssembly.Instance }).instance ?? (result as WebAssembly.Instance);
        for (const value of Object.values(instance?.exports ?? {})) if (value instanceof WebAssembly.Memory) memories.push(value);
        return result;
      };
      const instantiate = WebAssembly.instantiate.bind(WebAssembly);
      WebAssembly.instantiate = ((...args: Parameters<typeof WebAssembly.instantiate>) => instantiate(...args).then(remember)) as typeof WebAssembly.instantiate;
      const streaming = WebAssembly.instantiateStreaming?.bind(WebAssembly);
      if (streaming) {
        WebAssembly.instantiateStreaming = ((...args: Parameters<typeof WebAssembly.instantiateStreaming>) => streaming(...args).then(remember)) as typeof WebAssembly.instantiateStreaming;
      }
    });
    if (!seedDir) throw new Error("CANVINK_LARGE_SEED is not set.");
    const pages = await seedWorkspace(page, seedDir);
    expect(pages).toHaveLength(400);
    await page.goto("/app");
    // The seed is written like a workspace from before lazy loading, so the
    // first open builds the page index once, reading every page one by one.
    await expect(page.getByRole("heading", { name: "Seitenübersicht wird einmalig aufgebaut" })).toBeVisible({ timeout: 60_000 });
    await expectPageShown(page, pages[0], 600_000);

    const firstSection = pages.filter((candidate) => candidate.sectionId === pages[0].sectionId);
    const heaviest = [...firstSection].sort((left, right) => right.strokes - left.strokes)[0];
    for (const target of [firstSection[1], heaviest, firstSection[5], firstSection[9], pages[0]]) {
      await page.locator(`[data-page-row-id="${target.pageId}"] .page-row__target`).click();
      await expectPageShown(page, target);
    }

    // A page in another section that was never opened in this session.
    const hidden = [...pages].reverse().find((candidate) => candidate.sectionId !== pages[0].sectionId)!;
    const search = page.getByRole("combobox", { name: "Arbeitsbereich lokal durchsuchen" });
    await search.fill(hidden.token);
    const result = page.getByRole("option", { name: new RegExp(hidden.title) }).first();
    await expect(result).toBeVisible({ timeout: 300_000 });
    await result.click();
    await expectPageShown(page, hidden);

    // All 400 pages together hold far more ink than the WebAssembly memory
    // a handful of loaded pages needs.
    const wasmBytes = await page.evaluate(() =>
      (window as unknown as { __wasmMemories: WebAssembly.Memory[] }).__wasmMemories
        .reduce((total, memory) => total + memory.buffer.byteLength, 0));
    expect(wasmBytes).toBeLessThan(1024 * 1024 * 1024);
  });
});
