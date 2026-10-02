import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSearchDatabases, generateSeed, seedWorkspace, shownStrokeCount, type SeedPage } from "./seededWorkspace";
import { machineSlowdown, mainThreadCpuMs } from "./machineLoad";
import { expect, test } from "./support";

/**
 * The first open of a page shaped like a heavy synthetic notebook page: 7,000 imported handwriting strokes of ten points with
 * pressure, eight printout backgrounds and text boxes (synthetic data).
 * It took about 9 s on a laptop while Automerge's load was diffed and
 * patched value by value; it now takes about 2 s. The budgets are for an idle
 * machine. The title and reopen budgets are wall-clock and are multiplied by
 * the measured slowdown of the machine (see machineLoad.ts), so parallel specs
 * and other browsers do not fail them. Opening the page is computation on the
 * main thread, so its budget is the thread's CPU time, which a busy machine
 * does not inflate the way it inflates the wall clock.
 */
const seedBase = join(tmpdir(), "canvink-e2e-heavy-page-seed");
let seedDir = seedBase; // set to the generated seed in beforeAll
const HEAVY_STROKES = 7_000;
const OPEN_BUDGET_MS = 5_000;
const TITLE_BUDGET_MS = 1_000;
const REOPEN_BUDGET_MS = 1_500;
const FIRST_SEARCH_BUDGET_MS = 1_500;
const INDEX_ATTEMPTS = 4;

test.describe("heavy page", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test.beforeAll(() => {
    test.setTimeout(240_000);
    seedDir = generateSeed(seedBase, ["--pages", "3", "--strokes", "300", "--images", "3", "--sections", "1", "--heavy", String(HEAVY_STROKES), "--heavy-images", "8"]);
  });

  test("opens a 7,000-stroke page within the budget and shows its title at once", async ({ page }) => {
    await page.addInitScript(() => {
      const tasks: Array<{ start: number; duration: number }> = [];
      (window as unknown as { __longTasks: typeof tasks }).__longTasks = tasks;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: "longtask", buffered: true });
    });
    const pages: SeedPage[] = await seedWorkspace(page, seedDir);
    const heavy = pages.find((candidate) => candidate.pageId === "bm-heavy")!;
    const title = page.getByLabel("Seitentitel");
    await page.goto("/app");
    await expect(title).toHaveValue(pages[0].title, { timeout: 120_000 });
    // Let the one-time page index and the search index settle first.
    await expect(page.locator("[data-search-indexing]")).toHaveCount(0, { timeout: 120_000 });
    const loadBefore = await machineSlowdown(page);

    const timings = page.evaluate(({ title: expected, strokes }) => new Promise<{ titleMs: number; inkMs: number; start: number }>((resolve) => {
      const start = performance.now();
      let titleMs = -1;
      const tick = () => {
        const now = performance.now() - start;
        const input = document.querySelector<HTMLInputElement>('input[aria-label="Seitentitel"]');
        if (titleMs < 0 && input?.value === expected) titleMs = now;
        const loading = document.querySelector("[data-page-loading]") !== null;
        const count = Number(document.querySelector("[data-ink-stroke-count]")?.getAttribute("data-ink-stroke-count") ?? 0);
        if (!loading && count >= strokes && input?.value === expected) resolve({ titleMs, inkMs: now, start });
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }), { title: heavy.title, strokes: heavy.strokes });
    const cpuBefore = await mainThreadCpuMs(page);
    await page.locator(`[data-page-row-id="${heavy.pageId}"] .page-row__target`).click();
    const { titleMs, inkMs, start } = await timings;
    const openCpuMs = await mainThreadCpuMs(page) - cpuBefore;
    const slowdown = Math.max(loadBefore, await machineSlowdown(page));
    const longestTask = await page.evaluate((from) => Math.max(0, ...(window as unknown as { __longTasks: Array<{ start: number; duration: number }> })
      .__longTasks.filter((task) => task.start + task.duration >= from).map((task) => task.duration)), start);
    test.info().annotations.push({ type: "heavy page open", description: `title ${Math.round(titleMs)} ms, ink ${Math.round(inkMs)} ms (${Math.round(openCpuMs)} ms CPU), longest task ${Math.round(longestTask)} ms, machine ${slowdown.toFixed(1)}x slower than idle` });

    expect(titleMs).toBeLessThan(TITLE_BUDGET_MS * slowdown);
    expect(openCpuMs).toBeLessThan(OPEN_BUDGET_MS);
    expect(await shownStrokeCount(page)).toBe(HEAVY_STROKES);
    await expect(title).toBeEnabled();

    // Back and forth: the page stays in memory and reopens at once.
    await page.locator(`[data-page-row-id="${pages[0].pageId}"] .page-row__target`).click();
    await expect(title).toHaveValue(pages[0].title);
    const reopenStart = Date.now();
    await page.locator(`[data-page-row-id="${heavy.pageId}"] .page-row__target`).click();
    await expect.poll(() => shownStrokeCount(page)).toBe(HEAVY_STROKES);
    expect(Date.now() - reopenStart).toBeLessThan(REOPEN_BUDGET_MS * slowdown);
  });

  test("answers a search while the index is still being built and says it is incomplete", async ({ page }) => {
    const pages: SeedPage[] = await seedWorkspace(page, seedDir);
    const first = pages[0];
    const heavy = pages.find((candidate) => candidate.pageId === "bm-heavy")!;
    await page.goto("/app");
    await expect(page.getByLabel("Seitentitel")).toHaveValue(first.title, { timeout: 120_000 });

    // The heavy page is indexed in a worker for about two seconds; a search
    // meanwhile answers from the pages already indexed. On a busy machine the
    // index can be finished before the page lets the test search at all, and
    // then there is nothing to observe: the index is deleted and built again.
    const search = page.getByRole("combobox", { name: "Arbeitsbereich lokal durchsuchen" });
    const incomplete = page.locator(".search-panel__incomplete");
    let note: string | null = null;
    for (let attempt = 1; attempt <= INDEX_ATTEMPTS && note === null; attempt += 1) {
      if (attempt > 1) {
        await search.fill("");
        await deleteSearchDatabases(page);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByLabel("Seitentitel")).toHaveValue(first.title, { timeout: 120_000 });
      }
      const loadBefore = await machineSlowdown(page);
      const started = Date.now();
      await search.fill(first.token);
      await expect(page.getByRole("option", { name: new RegExp(first.title) }).first()).toBeVisible();
      const firstSearchMs = Date.now() - started;
      const slowdown = Math.max(loadBefore, await machineSlowdown(page));
      test.info().annotations.push({ type: "first search", description: `${firstSearchMs} ms, machine ${slowdown.toFixed(1)}x slower than idle` });
      expect(firstSearchMs).toBeLessThan(FIRST_SEARCH_BUDGET_MS * slowdown);
      // The note's text is read in one step: the note goes away when the pass is done.
      // An object, because waitForFunction keeps waiting on a falsy value.
      const state = await page.waitForFunction(() => {
        const element = document.querySelector(".search-panel__incomplete");
        if (element) return { text: element.textContent ?? "" };
        return document.querySelector("[data-search-indexing]") ? null : { text: null };
      }, undefined, { timeout: 60_000 });
      note = (await state.jsonValue()).text;
    }
    expect(note, `The search never saw an unfinished index in ${INDEX_ATTEMPTS} attempts`).not.toBeNull();
    expect(note).toMatch(/Suche noch unvollständig/);
    expect(note).toMatch(/\d+ von \d+ Seiten durchsucht|PDF-Text von \d+ Seiten wird noch gelesen/);

    // Once the pass is done the note goes away and the heavy page is found.
    await expect(incomplete).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator("[data-search-indexing]")).toHaveCount(0);
    await search.fill(heavy.token);
    await expect(page.getByRole("option", { name: new RegExp(heavy.title) }).first()).toBeVisible();
  });
});
